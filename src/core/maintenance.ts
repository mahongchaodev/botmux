/**
 * Maintenance timer: scheduled auto-update / auto-restart. Runs only on the
 * primary daemon (bot-0) — restart is a host-wide operation (it takes down all
 * per-bot daemons), so exactly one process must own it.
 *
 * At the scheduled local time (Asia/Shanghai, once/day) it:
 *  - checks the cross-daemon busy gate (anyDaemonBusy) — a session mid-CLI-turn
 *    anywhere defers the run to the next day (no retry);
 *  - auto-update (npm-global only): `npm install -g botmux@latest`, then restart
 *    to apply iff the version actually changed;
 *  - auto-restart: just restart.
 * Before triggering a restart it drops a restart-intent breadcrumb so the fresh
 * daemon knows to DM the owner (vs. staying silent on a crash-restart).
 *
 * runMaintenanceTick is pure over its injected deps (unit tested); the rest is
 * production wiring.
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { readGlobalConfig, type MaintenanceConfig } from '../global-config.js';
import { evaluateDue } from './maintenance-schedule.js';
import { anyDaemonBusy } from './daemon-heartbeat.js';
import { writeRestartIntent, type RestartIntent } from '../services/restart-intent-store.js';
import { isLocalDevInstall, botmuxVersion, botmuxCliEntry } from '../utils/install-info.js';

export interface MaintenanceState {
  autoUpdate?: { lastDate: string };
  autoRestart?: { lastDate: string };
}

export interface MaintenanceDeps {
  now: () => number;
  readConfig: () => MaintenanceConfig | undefined;
  readState: () => MaintenanceState;
  writeState: (s: MaintenanceState) => void;
  anyBusy: () => boolean;
  isLocalDev: () => boolean;
  /** botmux version before an update (read fresh each call). */
  currentVersion: () => string;
  /** Runs `npm install -g botmux@latest` and reports the resulting version.
   *  Throws on failure. */
  runUpdate: () => { newVersion: string };
  writeIntent: (intent: RestartIntent) => void;
  /** Spawn a detached `botmux restart` (this process is then killed by pm2). */
  triggerRestart: () => void;
  log?: (msg: string) => void;
}

/** One maintenance tick. Pure orchestration over injected deps. */
export function runMaintenanceTick(deps: MaintenanceDeps): void {
  const cfg = deps.readConfig();
  if (!cfg || (!cfg.autoUpdate?.enabled && !cfg.autoRestart?.enabled)) return;

  const now = deps.now();
  const state = deps.readState();
  const busy = deps.anyBusy();
  const log = deps.log ?? (() => {});
  let restarted = false;

  const mark = (key: 'autoUpdate' | 'autoRestart', markDate: string) => {
    state[key] = { lastDate: markDate };
    deps.writeState(state);
  };

  // ---- auto-update ----
  const upd = evaluateDue(cfg.autoUpdate ?? {}, state.autoUpdate?.lastDate, now);
  if ((upd.decision === 'due' || upd.decision === 'missed') && upd.markDate) mark('autoUpdate', upd.markDate);
  if (upd.decision === 'due') {
    if (deps.isLocalDev()) {
      log('auto-update skipped: local-dev install (npm-global only)');
    } else if (busy) {
      log('auto-update skipped: a session is busy — slipping to next day');
    } else {
      try {
        const before = deps.currentVersion();
        const { newVersion } = deps.runUpdate();
        if (newVersion && newVersion !== before) {
          deps.writeIntent({ kind: 'update', oldVersion: before, newVersion, at: new Date(now).toISOString() });
          deps.triggerRestart();
          restarted = true;
          log(`auto-update: ${before} → ${newVersion}, restarting`);
        } else {
          log('auto-update: already on the latest version, no restart');
        }
      } catch (e) {
        log(`auto-update failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // ---- auto-restart ----
  const res = evaluateDue(cfg.autoRestart ?? {}, state.autoRestart?.lastDate, now);
  if ((res.decision === 'due' || res.decision === 'missed') && res.markDate) mark('autoRestart', res.markDate);
  if (res.decision === 'due' && !restarted) {
    if (busy) {
      log('auto-restart skipped: a session is busy — slipping to next day');
    } else {
      deps.writeIntent({ kind: 'auto-restart', at: new Date(now).toISOString() });
      deps.triggerRestart();
      restarted = true;
      log('auto-restart: restarting');
    }
  }
}

// ---- maintenance-state store (dir-injected for tests) ----

const STATE_FILE = 'maintenance-state.json';

export function maintenanceStatePathIn(dir: string): string {
  return join(dir, STATE_FILE);
}

export function readMaintenanceStateTo(dir: string): MaintenanceState {
  const path = maintenanceStatePathIn(dir);
  if (!existsSync(path)) return {};
  try {
    const v = JSON.parse(readFileSync(path, 'utf-8'));
    return v && typeof v === 'object' ? v as MaintenanceState : {};
  } catch {
    return {};
  }
}

export function writeMaintenanceStateTo(dir: string, s: MaintenanceState): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = maintenanceStatePathIn(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  renameSync(tmp, path);
}

// ---- production wiring ----

/** How often to evaluate the schedule. Sub-minute so an HH:MM target fires
 *  within the same minute it's reached. */
export const MAINTENANCE_TICK_MS = 60_000;

function productionDeps(): MaintenanceDeps {
  return {
    now: () => Date.now(),
    readConfig: () => readGlobalConfig().maintenance,
    readState: () => readMaintenanceStateTo(config.session.dataDir),
    writeState: (s) => writeMaintenanceStateTo(config.session.dataDir, s),
    anyBusy: () => anyDaemonBusy(),
    isLocalDev: () => isLocalDevInstall(),
    currentVersion: () => botmuxVersion(),
    runUpdate: () => {
      execSync('npm install -g botmux@latest', { stdio: 'inherit' });
      return { newVersion: botmuxVersion() };
    },
    writeIntent: (intent) => writeRestartIntent(intent),
    triggerRestart: () => {
      const child = spawn(process.execPath, [botmuxCliEntry(), 'restart'], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.unref();
    },
    log: (msg) => logger.info(`[maintenance] ${msg}`),
  };
}

let timer: NodeJS.Timeout | undefined;

/** Start the maintenance loop. Call only on the primary daemon (bot-0). */
export function startMaintenance(): void {
  if (timer) return;
  const deps = productionDeps();
  const tick = () => {
    try { runMaintenanceTick(deps); } catch (e) {
      logger.warn(`[maintenance] tick failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  // First evaluation shortly after startup, then on a steady cadence.
  setTimeout(tick, 10_000).unref?.();
  timer = setInterval(tick, MAINTENANCE_TICK_MS);
  timer.unref?.();
  logger.info('[maintenance] timer started (primary daemon)');
}

export function stopMaintenance(): void {
  if (timer) { clearInterval(timer); timer = undefined; }
}
