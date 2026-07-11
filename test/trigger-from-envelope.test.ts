/**
 * Workflow thin layer: maps a target.kind=workflow trigger to a workflow run,
 * passing the untrusted event as a single string `event` param.
 * Run: pnpm vitest run test/trigger-from-envelope.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { triggerWorkflowFromEnvelope, EVENT_PARAM_NAME } from '../src/workflows/trigger-from-envelope.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import type { TriggerResult } from '../src/workflows/trigger-run.js';

function req(over: Partial<TriggerRequest['target']> = {}, options?: TriggerRequest['options']): TriggerRequest {
  return {
    source: { type: 'webhook', connectorId: 'conn_1' },
    target: { kind: 'workflow', workflowId: 'deploy', chatId: 'oc_x', ...over },
    envelope: { format: 'botmux.webhook.v1', sourceName: 'argos', trusted: false, payload: { alert: 'x' } },
    options,
  };
}

const fixedId = () => 'trg_fixed';

describe('triggerWorkflowFromEnvelope', () => {
  it('runs the workflow with the event passed as a string param', async () => {
    const runWorkflow = vi.fn(async (): Promise<TriggerResult> => ({ ok: true, dryRun: false, runId: 'run_9', workflowId: 'deploy', status: 'running', lastSeq: 1 }));
    const res = await triggerWorkflowFromEnvelope(req(), { larkAppId: 'cli_a', runWorkflow, makeTriggerId: fixedId });

    expect(res).toMatchObject({ ok: true, action: 'queued', triggerId: 'trg_fixed', target: { kind: 'workflow', workflowRunId: 'run_9', chatId: 'oc_x' } });
    const input = runWorkflow.mock.calls[0][0];
    expect(input.workflowId).toBe('deploy');
    expect(input.dryRun).toBe(false);
    expect(input.chatBinding).toEqual({ chatId: 'oc_x', larkAppId: 'cli_a' });
    expect(input.initiator).toBe('webhook:conn_1');
    // event param is a STRING (object/array params unsupported) carrying the envelope JSON
    const ev = input.rawParams[EVENT_PARAM_NAME];
    expect(ev.kind).toBe('string');
    expect(JSON.parse((ev as { value: string }).value)).toMatchObject({ envelope: { sourceName: 'argos' } });
  });

  it('dryRun calls the real workflow preflight without requiring a chat', async () => {
    const runWorkflow = vi.fn(async (): Promise<TriggerResult> => ({
      ok: true,
      dryRun: true,
      workflowId: 'deploy',
      status: 'validated',
    }));
    const res = await triggerWorkflowFromEnvelope(
      req({ chatId: undefined }, { dryRun: true }),
      { larkAppId: 'cli_a', runWorkflow, makeTriggerId: fixedId },
    );
    expect(res).toMatchObject({ ok: true, action: 'dry_run', target: { kind: 'workflow' } });
    expect(runWorkflow).toHaveBeenCalledTimes(1);
    expect(runWorkflow.mock.calls[0][0]).toMatchObject({
      workflowId: 'deploy',
      dryRun: true,
      initiator: 'webhook:conn_1',
    });
    expect(runWorkflow.mock.calls[0][0]).not.toHaveProperty('chatBinding');
  });

  it('requires workflowId and chatId (target_required)', async () => {
    const runWorkflow = vi.fn();
    const noWf = await triggerWorkflowFromEnvelope(req({ workflowId: undefined }), { larkAppId: 'cli_a', runWorkflow });
    expect(noWf).toMatchObject({ ok: false, errorCode: 'target_required' });
    const noChat = await triggerWorkflowFromEnvelope(req({ chatId: undefined }), { larkAppId: 'cli_a', runWorkflow });
    expect(noChat).toMatchObject({ ok: false, errorCode: 'target_required' });
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it('dryRun surfaces real parameter validation failures', async () => {
    const runWorkflow = vi.fn(async (): Promise<TriggerResult> => ({
      ok: false,
      error: 'invalid_params',
      message: 'event has wrong type',
      issues: [{ path: ['event'], code: 'type_mismatch', message: 'wrong type' }],
    }));
    const res = await triggerWorkflowFromEnvelope(
      req({ chatId: undefined }, { dryRun: true }),
      { larkAppId: 'cli_a', runWorkflow, makeTriggerId: fixedId },
    );
    expect(res).toMatchObject({ ok: false, errorCode: 'bad_request', error: 'event has wrong type' });
    expect(runWorkflow).toHaveBeenCalledTimes(1);
  });

  it('maps unknown_workflow / invalid_params → bad_request, else trigger_failed', async () => {
    const unknown = await triggerWorkflowFromEnvelope(req(), {
      larkAppId: 'cli_a', makeTriggerId: fixedId,
      runWorkflow: async () => ({ ok: false, error: 'unknown_workflow', message: 'not found' }),
    });
    expect(unknown).toMatchObject({ ok: false, errorCode: 'bad_request', error: 'not found' });

    const internal = await triggerWorkflowFromEnvelope(req(), {
      larkAppId: 'cli_a', makeTriggerId: fixedId,
      runWorkflow: async () => ({ ok: false, error: 'internal_error', message: 'boom' }),
    });
    expect(internal).toMatchObject({ ok: false, errorCode: 'trigger_failed', error: 'boom' });
  });

  it('maps a dry-run retired v2 preflight to the stable trigger error code and metadata', async () => {
    const res = await triggerWorkflowFromEnvelope(req({ chatId: undefined }, { dryRun: true }), {
      larkAppId: 'cli_a',
      makeTriggerId: fixedId,
      runWorkflow: async () => ({
        ok: false,
        error: 'legacy_workflow_retired',
        reason: 'migrated',
        message: 'run the v3 definition instead',
        targetWorkflowId: `wf_${'a'.repeat(32)}`,
        targetRevisionId: `rev_${'b'.repeat(64)}`,
      }),
    });
    expect(res).toEqual({
      ok: false,
      triggerId: 'trg_fixed',
      errorCode: 'legacy_workflow_retired',
      error: 'run the v3 definition instead',
      reason: 'migrated',
      targetWorkflowId: `wf_${'a'.repeat(32)}`,
      targetRevisionId: `rev_${'b'.repeat(64)}`,
    });
  });

  it('uses external:<type> initiator when no connectorId', async () => {
    const runWorkflow = vi.fn(async (): Promise<TriggerResult> => ({ ok: true, dryRun: false, runId: 'r', workflowId: 'deploy', status: 'running', lastSeq: 1 }));
    const r = req();
    r.source = { type: 'ui' };
    await triggerWorkflowFromEnvelope(r, { larkAppId: 'cli_a', runWorkflow });
    expect(runWorkflow.mock.calls[0][0].initiator).toBe('external:ui');
  });
});
