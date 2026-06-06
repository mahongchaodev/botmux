import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  globalConfigPath,
  readGlobalConfig,
  mergeMaintenanceConfig,
  isValidHhMm,
  parseMaintenancePatch,
} from '../src/global-config.js';

describe('isValidHhMm', () => {
  it('accepts valid 24h times with or without leading zero', () => {
    expect(isValidHhMm('00:00')).toBe(true);
    expect(isValidHhMm('4:00')).toBe(true);
    expect(isValidHhMm('04:30')).toBe(true);
    expect(isValidHhMm('23:59')).toBe(true);
  });
  it('rejects out-of-range or malformed times', () => {
    expect(isValidHhMm('24:00')).toBe(false);
    expect(isValidHhMm('12:60')).toBe(false);
    expect(isValidHhMm('foo')).toBe(false);
    expect(isValidHhMm('')).toBe(false);
    expect(isValidHhMm('4')).toBe(false);
    expect(isValidHhMm('04:5')).toBe(false);
  });
});

describe('maintenance global config', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-maint-config-'));
    vi.stubEnv('HOME', home);
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('absent maintenance section reads as undefined (feature off by default)', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({ lang: 'zh' }));
    expect(readGlobalConfig().maintenance).toBeUndefined();
  });

  it('parses valid autoUpdate / autoRestart blocks', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      maintenance: {
        autoUpdate: { enabled: true, time: '04:00' },
        autoRestart: { enabled: false, time: '4:30' },
      },
    }));
    expect(readGlobalConfig().maintenance).toEqual({
      autoUpdate: { enabled: true, time: '04:00' },
      autoRestart: { enabled: false, time: '4:30' },
    });
  });

  it('drops invalid time and non-boolean enabled, keeps the rest', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      maintenance: {
        autoUpdate: { enabled: 'yes', time: '99:99' },
        autoRestart: { enabled: true, time: '02:15' },
      },
    }));
    // autoUpdate: both fields invalid → dropped entirely
    // autoRestart: valid → kept
    expect(readGlobalConfig().maintenance).toEqual({
      autoRestart: { enabled: true, time: '02:15' },
    });
  });

  it('mergeMaintenanceConfig round-trips and preserves unknown sibling keys', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      lang: 'zh',
      dashboard: { publicReadOnly: true },
    }));
    const merged = mergeMaintenanceConfig({ autoRestart: { enabled: true, time: '03:00' } });
    expect(merged.autoRestart).toEqual({ enabled: true, time: '03:00' });
    const raw = JSON.parse(readFileSync(globalConfigPath(), 'utf8'));
    expect(raw.lang).toBe('zh');
    expect(raw.dashboard.publicReadOnly).toBe(true);
    expect(raw.maintenance.autoRestart).toEqual({ enabled: true, time: '03:00' });
  });

  it('mergeMaintenanceConfig merges into existing maintenance without dropping the other task', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      maintenance: { autoUpdate: { enabled: true, time: '05:00' } },
    }));
    mergeMaintenanceConfig({ autoRestart: { enabled: true, time: '06:00' } });
    const m = readGlobalConfig().maintenance;
    expect(m?.autoUpdate).toEqual({ enabled: true, time: '05:00' });
    expect(m?.autoRestart).toEqual({ enabled: true, time: '06:00' });
  });

  it('read-after-merge sees fresh value immediately (cache invalidation)', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({ maintenance: { autoRestart: { enabled: false, time: '01:00' } } }));
    expect(readGlobalConfig().maintenance?.autoRestart?.enabled).toBe(false); // prime cache
    mergeMaintenanceConfig({ autoRestart: { enabled: true, time: '01:00' } });
    expect(readGlobalConfig().maintenance?.autoRestart?.enabled).toBe(true);
  });
});

describe('parseMaintenancePatch (dashboard PUT validation)', () => {
  it('accepts a valid task block', () => {
    expect(parseMaintenancePatch({ autoRestart: { enabled: true, time: '04:00' } }))
      .toEqual({ ok: true, patch: { autoRestart: { enabled: true, time: '04:00' } } });
  });
  it('accepts enabled-only (time optional)', () => {
    expect(parseMaintenancePatch({ autoUpdate: { enabled: false } }))
      .toEqual({ ok: true, patch: { autoUpdate: { enabled: false } } });
  });
  it('accepts both tasks at once', () => {
    const r = parseMaintenancePatch({
      autoUpdate: { enabled: true, time: '04:00' },
      autoRestart: { enabled: false, time: '05:30' },
    });
    expect(r).toEqual({ ok: true, patch: {
      autoUpdate: { enabled: true, time: '04:00' },
      autoRestart: { enabled: false, time: '05:30' },
    } });
  });
  it('rejects an invalid time', () => {
    expect(parseMaintenancePatch({ autoRestart: { time: '99:99' } })).toEqual({ ok: false, error: 'invalid_time' });
  });
  it('rejects a non-boolean enabled', () => {
    expect(parseMaintenancePatch({ autoUpdate: { enabled: 'yes' } })).toEqual({ ok: false, error: 'invalid_enabled' });
  });
  it('rejects a non-object task', () => {
    expect(parseMaintenancePatch({ autoRestart: 'x' })).toEqual({ ok: false, error: 'invalid_task' });
  });
  it('rejects empty / non-object input', () => {
    expect(parseMaintenancePatch({})).toEqual({ ok: false, error: 'empty' });
    expect(parseMaintenancePatch(null)).toEqual({ ok: false, error: 'empty' });
  });
});
