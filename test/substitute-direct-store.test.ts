import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('uses the latest matching binding when target and operator bindings coexist', async () => {
    const store = await freshStore();
    const path = join(process.env.SESSION_DATA_DIR!, 'substitute-direct-bindings.json');
    writeFileSync(path, JSON.stringify({
      bindings: {
        'app-x::ou_target': {
          larkAppId: 'app-x',
          substituteOpenId: 'ou_target',
          targetOpenId: 'ou_target',
          targetName: 'Target',
          activeChatId: 'chat:oc_group',
          updatedAt: 100,
          chats: {
            'chat:oc_group': {
              targetKey: 'chat:oc_group',
              chatId: 'oc_group',
              scope: 'chat',
              anchor: 'oc_group',
              targetName: 'Target',
              mode: 'direct',
              enabled: true,
              updatedAt: 100,
            },
          },
        },
        'app-x::ou_operator': {
          larkAppId: 'app-x',
          substituteOpenId: 'ou_operator',
          targetOpenId: 'ou_target',
          targetName: 'Target',
          activeChatId: 'chat:oc_group',
          updatedAt: 200,
          chats: {
            'chat:oc_group': {
              targetKey: 'chat:oc_group',
              chatId: 'oc_group',
              scope: 'chat',
              anchor: 'oc_group',
              targetName: 'Target',
              mode: 'direct',
              enabled: true,
              updatedAt: 200,
            },
          },
        },
      },
    }, null, 2) + '\n');

    expect(store.getSubstituteDirectChatByTarget(
      'app-x',
      { openId: 'ou_target', name: 'Target' },
      'oc_group',
      'chat:oc_group',
    )).toMatchObject({
      substituteOpenId: 'ou_operator',
      targetOpenId: 'ou_target',
      chat: { targetKey: 'chat:oc_group' },
    });
  });
});
