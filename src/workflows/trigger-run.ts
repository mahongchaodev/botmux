/**
 * Shared workflow trigger — used by the dashboard catalog `POST .../run`
 * route on the daemon side.  Wraps the load/coerce/createRun/drive sequence
 * with injectable deps so the orchestration can be unit-tested without the
 * full daemon process.
 *
 * IM `/workflow run` still goes through `executeWorkflowCommand`; this helper
 * is the dashboard-trigger path that consumes pre-decoded JSON params and
 * fires the workflow loop in the background.
 */

import { coerceWorkflowParams, ParamCoerceFailure, type RawParamInput } from './params.js';
import { EventLog } from './events/append.js';
import { loadWorkflowDefinition as defaultLoadWorkflowDefinition } from './loader.js';
import { mintWorkflowRunId } from './run-id.js';
import { createRun, type BotResolver } from './run-init.js';
import { replay } from './events/replay.js';
import { getRunsDir } from './runs-dir.js';
import type { WorkflowDefinition } from './definition.js';
import type { WorkflowRuntimeContext, WorkerSpawnFn } from './runtime.js';
import type { LegacyWorkflowRetirementReason } from '../services/trigger-types.js';
import {
  LegacyWorkflowChangedAfterMigrationError,
  LegacyWorkflowIdentityConflictError,
  LegacyWorkflowMigratedError,
} from './migration/v2-ledger.js';

type TriggerInputBase = {
  workflowId: string;
  rawParams: Record<string, RawParamInput>;
  initiator: string;
};

export type TriggerInput =
  | (TriggerInputBase & {
      /** Validate the real definition and parameters without minting a run. */
      dryRun: true;
      chatBinding?: never;
    })
  | (TriggerInputBase & {
      dryRun?: false;
      chatBinding: { chatId: string; larkAppId: string };
    });

export type TriggerDeps = {
  spawnSubagent: WorkerSpawnFn;
  botResolver: BotResolver;
  /** Build the ctx scaffolding (hostExecutors, reconcilers, loadEffectInput). */
  makeRuntimeContext: (
    log: EventLog,
    def: WorkflowDefinition,
    spawnSubagent: WorkerSpawnFn,
  ) => WorkflowRuntimeContext;
  /** Daemon side registers the ctx so future cancel/approve can find it. */
  attachRuntime: (runId: string, ctx: WorkflowRuntimeContext) => { ready?: Promise<unknown> };
  /** Fire-and-forget loop drive — daemon owns the actual scheduling. */
  driveRun: (runId: string) => void;
  /** Test seam: override the file lookup. */
  loadWorkflowDefinition?: (workflowId: string) => Promise<WorkflowDefinition>;
  /** Test seam: deterministic run id. */
  makeRunId?: (def: WorkflowDefinition) => string;
  /** Test seam: explicit runs dir override. */
  makeEventLog?: (runId: string) => EventLog;
};

export type TriggerStartedSuccess = {
  ok: true;
  dryRun: false;
  runId: string;
  workflowId: string;
  status: string;
  lastSeq: number;
};

export type TriggerValidatedSuccess = {
  ok: true;
  dryRun: true;
  workflowId: string;
  status: 'validated';
};

export type TriggerSuccess = TriggerStartedSuccess | TriggerValidatedSuccess;

export type TriggerFailure =
  | {
      ok: false;
      error: 'unknown_workflow';
      message: string;
    }
  | {
      ok: false;
      error: 'invalid_params';
      message: string;
      issues: Array<{ path: string[]; code: string; message: string }>;
    }
  | {
      ok: false;
      error: 'load_definition_failed' | 'internal_error';
      message: string;
    }
  | {
      ok: false;
      error: 'legacy_workflow_retired';
      reason: LegacyWorkflowRetirementReason;
      message: string;
      targetWorkflowId?: string;
      targetRevisionId?: string;
    };

export type TriggerResult = TriggerSuccess | TriggerFailure;

function classifyLegacyWorkflowRetirement(err: unknown): Extract<
  TriggerFailure,
  { error: 'legacy_workflow_retired' }
> | undefined {
  if (err instanceof LegacyWorkflowMigratedError) {
    const message = err.revision.state === 'pending'
      ? `Legacy workflow '${err.source.legacy.workflowId}' migration is incomplete; ` +
        `re-run botmux template migrate-v3 to recover it. v2 execution stays disabled.`
      : `Legacy workflow '${err.source.legacy.workflowId}' has migrated to Saved Workflow ` +
        `${err.source.target.workflowId}@${err.revision.targetRevisionId}; run the Saved Workflow instead.`;
    return {
      ok: false,
      error: 'legacy_workflow_retired',
      reason: err.revision.state === 'pending' ? 'pending' : 'migrated',
      message,
      targetWorkflowId: err.source.target.workflowId,
      targetRevisionId: err.revision.targetRevisionId,
    };
  }
  if (err instanceof LegacyWorkflowChangedAfterMigrationError) {
    return {
      ok: false,
      error: 'legacy_workflow_retired',
      reason: 'changed_after_migration',
      message:
        `Legacy workflow '${err.source.legacy.workflowId}' changed after migration. ` +
        'v2 execution stays disabled; re-run botmux template migrate-v3 to append a v3 revision.',
      targetWorkflowId: err.source.target.workflowId,
    };
  }
  if (err instanceof LegacyWorkflowIdentityConflictError) {
    // A copied definition can match multiple independently migrated source
    // paths. Only expose a target when the evidence identifies one uniquely;
    // never guess which v3 definition the caller intended.
    const exactMatches = err.matches.filter(
      (source) => source.revisions[err.current.contentHash] !== undefined,
    );
    const targetWorkflowIds = new Set(err.matches.map((source) => source.target.workflowId));
    const targetWorkflowId = targetWorkflowIds.size === 1
      ? err.matches[0]?.target.workflowId
      : undefined;
    const targetRevisionId = exactMatches.length === 1
      ? exactMatches[0]?.revisions[err.current.contentHash]?.targetRevisionId
      : undefined;
    return {
      ok: false,
      error: 'legacy_workflow_retired',
      reason: 'identity_conflict',
      message:
        `Legacy workflow '${err.current.workflowId}' conflicts with existing migration evidence. ` +
        'v2 execution stays disabled; explicitly migrate this asset or run its Saved Workflow target.',
      ...(targetWorkflowId ? { targetWorkflowId } : {}),
      ...(targetRevisionId ? { targetRevisionId } : {}),
    };
  }
  return undefined;
}

export async function triggerWorkflowRun(
  input: TriggerInput,
  deps: TriggerDeps,
): Promise<TriggerResult> {
  const loadDef = deps.loadWorkflowDefinition ?? defaultLoadWorkflowDefinition;
  let def: WorkflowDefinition;
  try {
    def = await loadDef(input.workflowId);
  } catch (err) {
    const retirement = classifyLegacyWorkflowRetirement(err);
    if (retirement) return retirement;
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith(`Workflow '${input.workflowId}' not found`)) {
      return { ok: false, error: 'unknown_workflow', message };
    }
    return { ok: false, error: 'load_definition_failed', message };
  }

  let coerced: Record<string, unknown>;
  try {
    coerced = coerceWorkflowParams(def, input.rawParams);
  } catch (err) {
    if (err instanceof ParamCoerceFailure) {
      return {
        ok: false,
        error: 'invalid_params',
        message: err.message,
        issues: err.issues.map((i) => ({
          path: i.name ? [i.name] : [],
          code: i.code,
          message: i.message,
        })),
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'internal_error', message };
  }

  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      workflowId: def.workflowId,
      status: 'validated',
    };
  }

  try {
    const runId = (deps.makeRunId ?? ((d) => mintWorkflowRunId(d.workflowId, Date.now())))(def);
    const log = deps.makeEventLog ? deps.makeEventLog(runId) : new EventLog(runId, getRunsDir());
    const ctx = deps.makeRuntimeContext(log, def, deps.spawnSubagent);
    await createRun(log, {
      def,
      params: coerced,
      initiator: input.initiator,
      botResolver: deps.botResolver,
      chatBinding: input.chatBinding,
    });
    const watcher = deps.attachRuntime(runId, ctx);
    if (watcher.ready) {
      try {
        await watcher.ready;
      } catch {
        // watcher start failures are logged by the daemon; the run is still
        // valid and will keep producing events the watcher can re-pick on
        // restart, so don't abort the trigger here.
      }
    }
    deps.driveRun(runId);
    const snapshot = replay(await log.readAll());
    return {
      ok: true,
      dryRun: false,
      runId,
      workflowId: def.workflowId,
      status: snapshot.run.status,
      lastSeq: snapshot.lastSeq,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'internal_error', message };
  }
}
