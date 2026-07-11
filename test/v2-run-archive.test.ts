import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalJsonStringify, parseWorkflowDefinition } from '../src/workflows/definition.js';
import { cancelWorkflowRun } from '../src/workflows/cancel-run.js';
import { EventLog } from '../src/workflows/events/append.js';
import { readRunSnapshot } from '../src/workflows/ops-projection.js';
import { createRun } from '../src/workflows/run-init.js';
import { runLoop } from '../src/workflows/loop.js';
import {
  V2RunArchiveError,
  commitV2RunArchive,
  planV2RunArchive,
  verifyV2RunArchive,
} from '../src/workflows/migration/v2-run-archive.js';
import type { WorkerSpawnFn } from '../src/workflows/runtime.js';

const DEFINITION = parseWorkflowDefinition({
  workflowId: 'archive-demo',
  version: 1,
  nodes: { work: { type: 'subagent', bot: 'cli_archive', prompt: 'write a report' } },
});

const succeed: WorkerSpawnFn = async (input) => ({
  kind: 'success',
  output: { ok: true, node: input.nodeId },
  session: {
    sessionId: `session-${input.activityId}`,
    botName: input.botName,
    startedAt: 1,
    endedAt: 2,
  },
});

describe('v2 workflow-run content-addressed archive', () => {
  let root: string;
  let runsDir: string;
  let archiveBaseDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-v2-run-archive-'));
    runsDir = join(root, 'workflow-runs');
    archiveBaseDir = join(root, 'archives');
    mkdirSync(runsDir, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function seedSucceeded(runId = 'run-ok'): Promise<string> {
    const log = new EventLog(runId, runsDir);
    await createRun(log, {
      def: DEFINITION,
      params: { topic: 'archive' },
      initiator: 'ou_test',
      botResolver: () => ({ larkAppId: 'cli_archive', cliId: 'codex' }),
    });
    await runLoop({ log, def: DEFINITION, spawnSubagent: succeed });
    return log.runDir;
  }

  it('copies every run and residual byte, stores projection parity, and verifies statically/source-aware', async () => {
    const runDir = await seedSucceeded();
    mkdirSync(join(runDir, 'empty-audit-dir'));
    const residual = join(runsDir, 'target');
    mkdirSync(join(residual, 'blobs'), { recursive: true });
    writeFileSync(join(residual, 'blobs', 'orphan'), 'historical residual', 'utf-8');

    const plan = await planV2RunArchive({ runsDir });
    expect(plan.runCount).toBe(1);
    expect(plan.residualCount).toBe(1);
    expect(plan.content.residuals[0]).toMatchObject({
      name: 'target',
      reason: 'directory-without-events',
      fileCount: 1,
    });
    expect(plan.content.payloadDirectories).toContain('runs/run-ok/raw/empty-audit-dir');

    const result = await commitV2RunArchive({
      runsDir,
      archiveBaseDir,
      now: new Date('2026-07-11T00:00:00.000Z'),
    });
    expect(result.reused).toBe(false);
    expect(result.verification).toMatchObject({ staticVerified: true, sourceVerified: true });
    expect(existsSync(join(result.archiveDir, 'COMMITTED'))).toBe(true);
    expect(readFileSync(join(result.archiveDir, 'residual', 'target', 'raw', 'blobs', 'orphan'), 'utf-8'))
      .toBe('historical residual');

    const archivedProjection = JSON.parse(
      readFileSync(join(result.archiveDir, 'runs', 'run-ok', 'projection.json'), 'utf-8'),
    );
    const liveProjection = await readRunSnapshot(runsDir, 'run-ok');
    expect(canonicalJsonStringify(archivedProjection)).toBe(canonicalJsonStringify(liveProjection));

    expect(lstatSync(result.archiveDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(result.archiveDir, 'manifest.json')).mode & 0o777).toBe(0o600);
    for (const file of result.manifest.content.payloadFiles) {
      expect(lstatSync(join(result.archiveDir, ...file.path.split('/'))).mode & 0o777).toBe(0o600);
    }
    await expect(verifyV2RunArchive({ archiveDir: result.archiveDir }))
      .resolves.toMatchObject({ staticVerified: true, sourceVerified: false });
  });

  it('is idempotent by content and repairs a crash after atomic publication but before COMMITTED', async () => {
    await seedSucceeded();
    await expect(commitV2RunArchive({
      runsDir,
      archiveBaseDir,
      onPhase(phase) {
        if (phase === 'after-publish') throw new Error('crash-after-publish');
      },
    })).rejects.toThrow('crash-after-publish');
    const published = readdirSync(archiveBaseDir).find((name) => name.startsWith('sha256-'));
    expect(published).toBeTruthy();
    expect(existsSync(join(archiveBaseDir, published!, 'COMMITTED'))).toBe(false);

    const recovered = await commitV2RunArchive({ runsDir, archiveBaseDir });
    expect(recovered.reused).toBe(true);
    expect(existsSync(join(recovered.archiveDir, 'COMMITTED'))).toBe(true);
    expect(readdirSync(archiveBaseDir).filter((name) => name.startsWith('.staging-'))).toEqual([]);

    const replay = await commitV2RunArchive({ runsDir, archiveBaseDir });
    expect(replay.reused).toBe(true);
    expect(replay.archiveDir).toBe(recovered.archiveDir);
  });

  for (const crashPhase of ['after-copy', 'after-manifest'] as const) {
    it(`cleans an owned staging transaction and rebuilds after ${crashPhase}`, async () => {
      await seedSucceeded();
      await expect(commitV2RunArchive({
        runsDir,
        archiveBaseDir,
        onPhase(phase) {
          if (phase === crashPhase) throw new Error(`crash:${crashPhase}`);
        },
      })).rejects.toThrow(`crash:${crashPhase}`);
      expect(readdirSync(archiveBaseDir).some((name) => name.startsWith('.staging-'))).toBe(true);
      const recovered = await commitV2RunArchive({ runsDir, archiveBaseDir });
      expect(recovered.reused).toBe(false);
      expect(readdirSync(archiveBaseDir).filter((name) => name.startsWith('.staging-'))).toEqual([]);
    });
  }

  it('fails closed when source changes between the copied and second capture', async () => {
    await seedSucceeded();
    const residual = join(runsDir, 'target');
    mkdirSync(residual);
    writeFileSync(join(residual, 'note'), 'before', 'utf-8');
    await expect(commitV2RunArchive({
      runsDir,
      archiveBaseDir,
      onPhase(phase) {
        if (phase === 'after-copy') writeFileSync(join(residual, 'note'), 'after', 'utf-8');
      },
    })).rejects.toMatchObject({ code: 'SOURCE_CHANGED_DURING_ARCHIVE' });
    expect(readdirSync(archiveBaseDir).some((name) => name.startsWith('sha256-'))).toBe(false);
  });

  it('rejects nonterminal and corrupt event-bearing directories instead of classifying them as residual', async () => {
    const active = new EventLog('run-active', runsDir);
    await createRun(active, {
      def: DEFINITION,
      params: {},
      initiator: 'test',
      botResolver: () => ({ larkAppId: 'cli_archive', cliId: 'codex' }),
    });
    await expect(planV2RunArchive({ runsDir })).rejects.toMatchObject({ code: 'NONTERMINAL_RUN' });

    rmSync(active.runDir, { recursive: true, force: true });
    const corrupt = join(runsDir, 'run-corrupt');
    mkdirSync(corrupt);
    writeFileSync(join(corrupt, 'events.ndjson'), '{bad-json\n', 'utf-8');
    await expect(planV2RunArchive({ runsDir })).rejects.toMatchObject({ code: 'CORRUPT_EVENT_LOG' });
  });

  it('requires a physically complete NDJSON journal with no blank interior lines', async () => {
    const runDir = await seedSucceeded();
    const journal = join(runDir, 'events.ndjson');
    const complete = readFileSync(journal, 'utf-8');
    writeFileSync(journal, complete.slice(0, -1), 'utf-8');
    await expect(planV2RunArchive({ runsDir })).rejects.toMatchObject({ code: 'TORN_EVENT_LOG' });

    writeFileSync(journal, complete.replace('\n', '\n\n'), 'utf-8');
    await expect(planV2RunArchive({ runsDir })).rejects.toMatchObject({ code: 'CORRUPT_EVENT_LOG' });
  });

  it('rejects an archive path inside the source before creating or chmodding it', async () => {
    await seedSucceeded();
    const nestedArchive = join(runsDir, 'must-not-be-created');
    await expect(commitV2RunArchive({ runsDir, archiveBaseDir: nestedArchive }))
      .rejects.toMatchObject({ code: 'ARCHIVE_SOURCE_OVERLAP' });
    expect(existsSync(nestedArchive)).toBe(false);
  });

  it('never chmods a caller-owned existing archive base', async () => {
    await seedSucceeded();
    const callerOwned = join(root, 'caller-owned');
    mkdirSync(callerOwned, { mode: 0o755 });
    chmodSync(callerOwned, 0o755);
    await expect(commitV2RunArchive({ runsDir, archiveBaseDir: callerOwned }))
      .rejects.toMatchObject({ code: 'ARCHIVE_MODE_MISMATCH' });
    expect(lstatSync(callerOwned).mode & 0o777).toBe(0o755);
    expect(readdirSync(callerOwned)).toEqual([]);
  });

  it('archives historical missing optional paths and records warnings instead of fabricating them', async () => {
    const runDir = await seedSucceeded();
    rmSync(join(runDir, 'attempts'), { recursive: true, force: true });
    const plan = await planV2RunArchive({ runsDir });
    expect(plan.content.runs[0]?.missingOptional).toEqual(['chat-binding.json', 'attempts']);
    expect(plan.content.runs[0]?.presence).toMatchObject({
      chatBindingJson: false,
      attemptsDir: false,
    });
  });

  it('accepts every authoritative v2 terminal verdict', async () => {
    await seedSucceeded('run-succeeded');

    const failed = new EventLog('run-failed', runsDir);
    await createRun(failed, {
      def: DEFINITION,
      params: {},
      initiator: 'test',
      botResolver: () => ({ larkAppId: 'cli_archive', cliId: 'codex' }),
    });
    await runLoop({
      log: failed,
      def: DEFINITION,
      spawnSubagent: async () => ({
        kind: 'failure',
        errorCode: 'ARCHIVE_TEST_FAILURE',
        errorClass: 'manual',
      }),
    });

    const cancelled = new EventLog('run-cancelled', runsDir);
    await createRun(cancelled, {
      def: DEFINITION,
      params: {},
      initiator: 'test',
      botResolver: () => ({ larkAppId: 'cli_archive', cliId: 'codex' }),
    });
    await cancelWorkflowRun({
      ctx: { log: cancelled, def: DEFINITION, spawnSubagent: succeed },
      reason: 'archive cancellation fixture',
      by: 'ou_test',
    });

    const plan = await planV2RunArchive({ runsDir });
    expect(Object.fromEntries(plan.content.runs.map((run) => [run.runId, run.verdict.status])))
      .toEqual({
        'run-cancelled': 'cancelled',
        'run-failed': 'failed',
        'run-succeeded': 'succeeded',
      });
  });

  it('rejects source symlinks, hardlinks, and special topology before publishing', async () => {
    const runDir = await seedSucceeded();
    symlinkSync(join(runDir, 'workflow.json'), join(runDir, 'alias.json'));
    await expect(planV2RunArchive({ runsDir })).rejects.toMatchObject({ code: 'SOURCE_SYMLINK' });

    unlinkIfExists(join(runDir, 'alias.json'));
    linkSync(join(runDir, 'workflow.json'), join(runDir, 'hardlink.json'));
    await expect(planV2RunArchive({ runsDir })).rejects.toMatchObject({ code: 'SOURCE_HARDLINK' });
  });

  it('detects payload, manifest, topology, and source tampering', async () => {
    await seedSucceeded();
    const result = await commitV2RunArchive({ runsDir, archiveBaseDir });
    const rawWorkflow = join(result.archiveDir, 'runs', 'run-ok', 'raw', 'workflow.json');
    chmodSync(rawWorkflow, 0o600);
    writeFileSync(rawWorkflow, '{}', { mode: 0o600 });
    await expect(verifyV2RunArchive({ archiveDir: result.archiveDir }))
      .rejects.toMatchObject({ code: 'ARCHIVE_FILE_HASH_MISMATCH' });

    rmSync(result.archiveDir, { recursive: true, force: true });
    const rebuilt = await commitV2RunArchive({ runsDir, archiveBaseDir });
    writeFileSync(join(runsDir, 'run-ok', 'workflow.json'), '{}', 'utf-8');
    await expect(verifyV2RunArchive({
      archiveDir: rebuilt.archiveDir,
      sourceRunsDir: runsDir,
    })).rejects.toBeInstanceOf(V2RunArchiveError);
  });
});

function unlinkIfExists(path: string): void {
  try { rmSync(path); } catch { /* absent */ }
}
