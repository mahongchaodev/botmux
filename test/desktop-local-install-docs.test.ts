import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('desktop local source installer docs', () => {
  it('keeps Desktop installation outside the botmux CLI command surface', () => {
    const script = readFileSync('src/desktop/install-local.sh', 'utf-8');
    const readme = readFileSync('src/desktop/README.md', 'utf-8');

    expect(script).toContain('#!/usr/bin/env bash');
    expect(script).toContain('Node.js 22 or newer is required');
    expect(script).toContain('pnpm link --global');
    expect(script).toContain('pnpm desktop:bundle');
    expect(script).toContain('electron-builder --mac dir');
    expect(script).toContain('codesign --force --deep --sign -');
    expect(script).toContain('xattr -dr com.apple.quarantine');
    expect(script).not.toContain('botmux app');

    expect(readme).toContain('bash src/desktop/install-local.sh');
    expect(readme).toContain('pnpm link --global');
    expect(readme).not.toContain('botmux app');
  });
});
