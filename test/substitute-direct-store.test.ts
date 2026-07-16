import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function freshStore() {
  vi.resetModules();
  return import('../src/services/substitute-direct-store.js');
}

describe('substitute-direct-store', () => {
  beforeEach(() => {
    process.env.SESSION_DATA_DIR = mkdtempSync(join(tmpdir(), 'botmux-substitute-direct-'));
  });

  afterEach(() => {
    delete process.env.SESSION_DATA_DIR;
  });

  it('keeps directBotMention on for legacy operator-owned bindings targeting the substitute', async () => {
    const store = await freshStore();

    store.upsertSubstituteDirectChat({
      larkAppId: 'app-x',
      substituteOpenId: 'ou_operator',
      targetOpenId: 'ou_target',
      chatId: 'oc_group',
      targetKey: 'chat:oc_group',
      scope: 'chat',
      anchor: 'oc_group',
      mode: 'direct',
      targetName: 'Target',
      preserveExistingChats: true,
    });

    expect(store.setSubstituteDirectChatBotMention({
      larkAppId: 'app-x',
      substituteOpenId: 'ou_target',
      targetOpenId: 'ou_target',
      targetKeyOrChatId: 'chat:oc_group',
      enabled: true,
      chatId: 'oc_group',
      scope: 'chat',
      anchor: 'oc_group',
      targetName: 'Target',
    })).toBe(true);

    const raw = JSON.parse(readFileSync(join(process.env.SESSION_DATA_DIR!, 'substitute-direct-bindings.json'), 'utf-8'));
    expect(raw.bindings['app-x::ou_operator'].chats['chat:oc_group'].directBotMention).toBe(true);
  });

  it('turns off competing directBotMention receivers for the same session', async () => {
    const store = await freshStore();

    store.setSubstituteDirectChatBotMention({
      larkAppId: 'app-x',
      substituteOpenId: 'ou_a',
      targetOpenId: 'ou_a',
      targetKeyOrChatId: 'chat:oc_group',
      enabled: true,
      chatId: 'oc_group',
      scope: 'chat',
      anchor: 'oc_group',
    });
    store.setSubstituteDirectChatBotMention({
      larkAppId: 'app-x',
      substituteOpenId: 'ou_b',
      targetOpenId: 'ou_b',
      targetKeyOrChatId: 'chat:oc_group',
      enabled: true,
      chatId: 'oc_group',
      scope: 'chat',
      anchor: 'oc_group',
    });

    const raw = JSON.parse(readFileSync(join(process.env.SESSION_DATA_DIR!, 'substitute-direct-bindings.json'), 'utf-8'));
    expect(raw.bindings['app-x::ou_a'].chats['chat:oc_group'].directBotMention).toBe(false);
    expect(raw.bindings['app-x::ou_b'].chats['chat:oc_group'].directBotMention).toBe(true);
  });
});
