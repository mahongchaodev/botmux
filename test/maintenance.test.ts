import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runMaintenanceTick,
  readMaintenanceStateTo,
  writeMaintenanceStateTo,
  type MaintenanceDeps,
  type MaintenanceState,
} from '../src/core/maintenance.js';
import type { MaintenanceConfig } from '../src/global-config.js';
import type { RestartIntent } from '../src/services/restart-intent-store.js';

// 2026-06-07T04:00:00Z === 2026-06-07 12:00 local (Asia/Shanghai)
const NOON = Date.parse('2026-06-07T04:00:00.000Z');
const TODAY = '2026-06-07';

function makeDeps(cfg: MaintenanceConfig, init: MaintenanceState = {}, over: Partial<MaintenanceDeps> = {}) {
  const state: MaintenanceState = JSON.parse(JSON.stringify(init));
  const calls = { restart: 0, update: 0, writes: 0, intents: [] as RestartIntent[], logs: [] as string[] };
  const deps: MaintenanceDeps = {
    now: () => NOON,
    readConfig: () => cfg,
    readState: () => state,
    writeState: () => { calls.writes++; },
    anyBusy: () => false,
    isLocalDev: () => false,
    currentVersion: () => '2.64.0',
    runUpdate: () => { calls.update++; return { newVersion: '2.65.0' }; },
    writeIntent: (i) => { calls.intents.push(i); },
    triggerRestart: () => { calls.restart++; },
    log: (m) => { calls.logs.push(m); },
    ...over,
  };
  return { deps, calls, state };
}

describe('runMaintenanceTick', () => {
  it('does nothing when neither task is enabled', () => {
    const { deps, calls } = makeDeps({});
    runMaintenanceTick(deps);
    expect(calls.restart).toBe(0);
    expect(calls.writes).toBe(0);
  });

  it('auto-restart due + idle → triggers one restart with an auto-restart intent, marks today', () => {
    const { deps, calls, state } = makeDeps({ autoRestart: { enabled: true, time: '12:00' } });
    runMaintenanceTick(deps);
    expect(calls.restart).toBe(1);
    expect(calls.intents).toEqual([expect.objectContaining({ kind: 'auto-restart' })]);
    expect(state.autoRestart?.lastDate).toBe(TODAY);
  });

  it('auto-restart due + BUSY → no restart, but marks today (slips to next day)', () => {
    const { deps, calls, state } = makeDeps({ autoRestart: { enabled: true, time: '12:00' } }, {}, { anyBusy: () => true });
    runMaintenanceTick(deps);
    expect(calls.restart).toBe(0);
    expect(state.autoRestart?.lastDate).toBe(TODAY);
  });

  it('auto-restart already handled today → no restart, no state write', () => {
    const { deps, calls } = makeDeps({ autoRestart: { enabled: true, time: '12:00' } }, { autoRestart: { lastDate: TODAY } });
    runMaintenanceTick(deps);
    expect(calls.restart).toBe(0);
    expect(calls.writes).toBe(0);
  });

  it('auto-restart missed (past grace) → no restart, marks today', () => {
    const { deps, calls, state } = makeDeps({ autoRestart: { enabled: true, time: '10:00' } }); // 120 min late
    runMaintenanceTick(deps);
    expect(calls.restart).toBe(0);
    expect(state.autoRestart?.lastDate).toBe(TODAY);
  });

  it('auto-update due + new version → runs update, writes update intent, restarts, marks', () => {
    const { deps, calls, state } = makeDeps({ autoUpdate: { enabled: true, time: '12:00' } });
    runMaintenanceTick(deps);
    expect(calls.update).toBe(1);
    expect(calls.restart).toBe(1);
    expect(calls.intents).toEqual([expect.objectContaining({ kind: 'update', oldVersion: '2.64.0', newVersion: '2.65.0' })]);
    expect(state.autoUpdate?.lastDate).toBe(TODAY);
  });

  it('auto-update due but already on latest → no restart, no intent, marks', () => {
    const { deps, calls, state } = makeDeps({ autoUpdate: { enabled: true, time: '12:00' } }, {}, {
      runUpdate: () => ({ newVersion: '2.64.0' }), // same as currentVersion
    });
    runMaintenanceTick(deps);
    expect(calls.restart).toBe(0);
    expect(calls.intents).toEqual([]);
    expect(state.autoUpdate?.lastDate).toBe(TODAY);
  });

  it('auto-update due on a local-dev install → never runs npm, no restart, marks (skip)', () => {
    let updateRan = 0;
    const { deps, calls, state } = makeDeps({ autoUpdate: { enabled: true, time: '12:00' } }, {}, {
      isLocalDev: () => true,
      runUpdate: () => { updateRan++; return { newVersion: '2.65.0' }; },
    });
    runMaintenanceTick(deps);
    expect(updateRan).toBe(0);
    expect(calls.restart).toBe(0);
    expect(state.autoUpdate?.lastDate).toBe(TODAY);
  });

  it('auto-update due + BUSY → does not run npm, marks (slips to next day)', () => {
    let updateRan = 0;
    const { deps, calls } = makeDeps({ autoUpdate: { enabled: true, time: '12:00' } }, {}, {
      anyBusy: () => true,
      runUpdate: () => { updateRan++; return { newVersion: '2.65.0' }; },
    });
    runMaintenanceTick(deps);
    expect(updateRan).toBe(0);
    expect(calls.restart).toBe(0);
  });

  it('both tasks due in the same tick → exactly ONE restart, both marked', () => {
    const { deps, calls, state } = makeDeps({
      autoUpdate: { enabled: true, time: '12:00' },
      autoRestart: { enabled: true, time: '12:00' },
    });
    runMaintenanceTick(deps);
    expect(calls.restart).toBe(1);
    expect(calls.intents).toHaveLength(1);
    expect(calls.intents[0].kind).toBe('update');
    expect(state.autoUpdate?.lastDate).toBe(TODAY);
    expect(state.autoRestart?.lastDate).toBe(TODAY);
  });
});

describe('maintenance-state store', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-mstate-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reads {} when absent and round-trips after a write', () => {
    expect(readMaintenanceStateTo(dir)).toEqual({});
    writeMaintenanceStateTo(dir, { autoRestart: { lastDate: '2026-06-07' } });
    expect(readMaintenanceStateTo(dir)).toEqual({ autoRestart: { lastDate: '2026-06-07' } });
  });

  it('tolerates a corrupt state file (reads as {})', () => {
    writeMaintenanceStateTo(dir, { autoUpdate: { lastDate: '2026-06-07' } });
    rmSync(join(dir, 'maintenance-state.json'));
    expect(readMaintenanceStateTo(dir)).toEqual({});
  });
});
