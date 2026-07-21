import { describe, expect, it } from 'vitest';
import { buildPm2SpawnCommand, parsePm2JlistOutput } from '../src/cli/pm2-command.js';

describe('buildPm2SpawnCommand', () => {
  it('runs bundled pm2 script through node.exe on Windows', () => {
    expect(buildPm2SpawnCommand(
      'D:\\Application\\npm-global\\node_modules\\botmux\\node_modules\\pm2\\bin\\pm2',
      ['logs', '/^botmux/', '--lines', '50'],
      'win32',
      'D:\\Application\\nodejs\\node.exe',
    )).toEqual({
      command: 'D:\\Application\\nodejs\\node.exe',
      args: [
        'D:\\Application\\npm-global\\node_modules\\botmux\\node_modules\\pm2\\bin\\pm2',
        'logs',
        '/^botmux/',
        '--lines',
        '50',
      ],
    });
  });

  it('runs package-local pm2.cmd directly through a Windows shell (quoted)', () => {
    const pm2Cmd = String.raw`D:\Application\npm-global\node_modules\botmux\node_modules\.bin\pm2.cmd`;
    expect(buildPm2SpawnCommand(
      pm2Cmd,
      ['status'],
      'win32',
      String.raw`D:\Application\nodejs\node.exe`,
    )).toEqual({
      command: `"${pm2Cmd}"`,
      args: ['"status"'],
      shell: true,
    });
  });

  it('quotes pm2.cmd and args so spaces in the config path survive shell:true', () => {
    const pm2Cmd = String.raw`C:\Users\First Last\AppData\Roaming\npm\node_modules\botmux\node_modules\.bin\pm2.cmd`;
    const cfg = String.raw`C:\Users\First Last\.botmux\ecosystem.config.json`;
    expect(buildPm2SpawnCommand(pm2Cmd, ['start', cfg], 'win32')).toEqual({
      command: `"${pm2Cmd}"`,
      args: ['"start"', `"${cfg}"`],
      shell: true,
    });
  });

  it('keeps direct pm2 command unchanged on Windows', () => {
    expect(buildPm2SpawnCommand('pm2', ['status'], 'win32', 'node.exe')).toEqual({
      command: 'pm2',
      args: ['status'],
    });
  });

  it('keeps direct script execution on Unix platforms', () => {
    expect(buildPm2SpawnCommand('/app/node_modules/pm2/bin/pm2', ['status'], 'linux', '/usr/bin/node')).toEqual({
      command: '/app/node_modules/pm2/bin/pm2',
      args: ['status'],
    });
  });
});

describe('parsePm2JlistOutput', () => {
  it('parses plain pm2 jlist JSON', () => {
    expect(parsePm2JlistOutput('[{"name":"botmux-0"}]')).toEqual([{ name: 'botmux-0' }]);
  });

  it('skips PM2 out-of-date banner before the JSON array', () => {
    const raw = [
      '\x1b[31m\x1b[1m>>>> In-memory PM2 is out-of-date, do:\x1b[22m\x1b[39m',
      '\x1b[31m\x1b[1m>>>> $ pm2 update\x1b[22m\x1b[39m',
      'In memory PM2 version: \x1b[34m\x1b[1m6.0.14\x1b[22m\x1b[39m',
      'Local PM2 version: \x1b[34m\x1b[1m7.0.3\x1b[22m\x1b[39m',
      '',
      '[{"name":"botmux-0","pid":123}]',
    ].join('\n');

    expect(parsePm2JlistOutput(raw)).toEqual([{ name: 'botmux-0', pid: 123 }]);
  });

  it('returns an empty list for empty output', () => {
    expect(parsePm2JlistOutput(' \n ')).toEqual([]);
  });
});
