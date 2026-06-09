/**
 * Regression: `/card off` (disableStreamingCard) must still post a 「处理中」
 * placeholder card and record it as the open pending-response card — that card
 * is what the final reply / `botmux send` patches in place, and its patch is
 * what lets the 完成 emoji land on the user's message.
 *
 * Commit 8b48871 (topic reply mode) silently neutered `postPendingResponseCard`
 * into a no-op ("card-off = no visible botmux cards at all"), which made both
 * the placeholder and the emoji disappear. There was no test covering the
 * placeholder-post path, so the regression slipped in. This locks the
 * creation side; the patch + GoGoGo-emoji side is covered by
 * test/bridge-final-output-retry.test.ts.
 *
 * Run:  pnpm vitest run test/pending-response-card-post.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mocks = vi.hoisted(() => ({
  replyMessage: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return { ...actual, replyMessage: mocks.replyMessage, sendMessage: mocks.sendMessage };
});

import { registerBot } from '../src/bot-registry.js';
import { postPendingResponseCard } from '../src/daemon.js';
import {
  markPendingResponsePatchMarkerPatched,
  writePendingResponsePatchMarker,
} from '../src/services/pending-response-transaction-store.js';
import type { DaemonSession } from '../src/core/types.js';

const APP = 'pending_card_app';
const APP_NOCARD = 'pending_card_nocard_app';

function makeDs(scope: 'chat' | 'thread', over: Partial<DaemonSession> = {}): DaemonSession {
  const session: any = {
    sessionId: 'sess-' + Math.random().toString(36).slice(2),
    chatId: 'oc_pending',
    rootMessageId: 'om_root',
    createdAt: new Date().toISOString(),
  };
  return {
    session,
    larkAppId: APP,
    chatId: 'oc_pending',
    scope,
    ...over,
  } as unknown as DaemonSession;
}

function placeholderTitle(content: string): string {
  return JSON.parse(content).header.title.content;
}
const PLACEHOLDER_TITLES = ['处理中', 'Processing'];

describe('postPendingResponseCard — card-off placeholder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SESSION_DATA_DIR = mkdtempSync(join(tmpdir(), 'botmux-pending-'));
    mocks.replyMessage.mockResolvedValue('om_placeholder');
    mocks.sendMessage.mockResolvedValue('om_placeholder');
    registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      disableStreamingCard: true,
    });
    registerBot({
      larkAppId: APP_NOCARD,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      // streaming card NOT globally disabled — only suppressed for this one chat.
      noCardChats: ['oc_pending'],
    });
  });

  it('chat-scope plain: posts a 处理中 placeholder as a top-level chat message and records it open', async () => {
    const ds = makeDs('chat');
    await postPendingResponseCard(ds, 'om_trigger', 'hello', undefined, 'turn-1');

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.replyMessage).not.toHaveBeenCalled();
    const [appId, chatId, content, msgType] = mocks.sendMessage.mock.calls[0];
    expect(appId).toBe(APP);
    expect(chatId).toBe('oc_pending');
    expect(msgType).toBe('interactive');
    expect(PLACEHOLDER_TITLES).toContain(placeholderTitle(content));

    expect(ds.session.pendingResponseCardId).toBe('om_placeholder');
    expect(ds.session.pendingResponseCardState).toBe('open');
  });

  it('thread-scope: replies the placeholder inside the thread', async () => {
    const ds = makeDs('thread');
    await postPendingResponseCard(ds, 'om_trigger', 'hello', undefined, 'turn-1');

    expect(mocks.replyMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    const [appId, target, content, msgType, replyInThread] = mocks.replyMessage.mock.calls[0];
    expect(appId).toBe(APP);
    expect(target).toBe('om_root');
    expect(msgType).toBe('interactive');
    expect(replyInThread).toBe(true);
    expect(PLACEHOLDER_TITLES).toContain(placeholderTitle(content));
    expect(ds.session.pendingResponseCardId).toBe('om_placeholder');
  });

  it('chat-scope topic-alias: routes the placeholder into the aliased topic thread on a matching turn', async () => {
    const ds = makeDs('chat', {
      currentReplyTarget: { rootMessageId: 'om_topic', turnId: 'turn-1', updatedAt: new Date().toISOString() },
    });
    await postPendingResponseCard(ds, 'om_trigger', 'hello', undefined, 'turn-1');

    expect(mocks.replyMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    const [, target, , , replyInThread] = mocks.replyMessage.mock.calls[0];
    expect(target).toBe('om_topic');
    expect(replyInThread).toBe(true);
  });

  it('chat-scope topic-alias: a non-matching turnId does NOT hijack into the stale topic — falls back to plain chat', async () => {
    // The alias was set for turn-1; a later top-level turn-2 must not be
    // routed into turn-1's topic thread (resolveSessionReplyTarget turnId gate).
    const ds = makeDs('chat', {
      currentReplyTarget: { rootMessageId: 'om_topic', turnId: 'turn-1', updatedAt: new Date().toISOString() },
    });
    await postPendingResponseCard(ds, 'om_trigger', 'hello', undefined, 'turn-2');

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.replyMessage).not.toHaveBeenCalled();
    expect(mocks.sendMessage.mock.calls[0][1]).toBe('oc_pending');
  });

  it('noCardChats: posts the placeholder even when disableStreamingCard is not globally set', async () => {
    const ds = makeDs('chat', { larkAppId: APP_NOCARD } as Partial<DaemonSession>);
    await postPendingResponseCard(ds, 'om_trigger', 'hello', undefined, 'turn-1');

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage.mock.calls[0][0]).toBe(APP_NOCARD);
    expect(ds.session.pendingResponseCardId).toBe('om_placeholder');
    expect(ds.session.pendingResponseCardState).toBe('open');
  });

  it('streaming card enabled (forced): no placeholder posted, no pending card recorded', async () => {
    const ds = makeDs('chat', { streamingCardForced: true } as Partial<DaemonSession>);
    await postPendingResponseCard(ds, 'om_trigger', 'hello', undefined, 'turn-1');

    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.replyMessage).not.toHaveBeenCalled();
    expect(ds.session.pendingResponseCardId).toBeUndefined();
  });

  it('Lark API failure: swallows the error and records no open card (no dangling pending state)', async () => {
    mocks.sendMessage.mockRejectedValueOnce(new Error('lark 500'));
    const ds = makeDs('chat');

    await expect(postPendingResponseCard(ds, 'om_trigger', 'hello', undefined, 'turn-1')).resolves.toBeUndefined();
    expect(ds.session.pendingResponseCardId).toBeUndefined();
    expect(ds.session.pendingResponseCardState).toBeUndefined();
  });

  it('marker reconciliation: a prior open card whose PATCH committed (marker=patched) is settled before a fresh placeholder is posted', async () => {
    const ds = makeDs('chat');
    // Simulate a previous turn whose card was PATCHed at Feishu (marker promoted)
    // but whose session save lost the race, so the in-memory card still looks open.
    (ds as any).pendingResponseCardId = 'om_stale';
    (ds as any).pendingResponseCardState = 'open';
    ds.session.pendingResponseCardId = 'om_stale';
    ds.session.pendingResponseCardState = 'open';
    writePendingResponsePatchMarker(ds.session.sessionId, 'om_stale');
    markPendingResponsePatchMarkerPatched(ds.session.sessionId);

    mocks.sendMessage.mockResolvedValueOnce('om_fresh');
    await postPendingResponseCard(ds, 'om_trigger', 'hello', undefined, 'turn-1');

    // Stale card reconciled to patched, then a brand-new open card recorded.
    expect(ds.session.lastPatchedResponseCardId).toBe('om_stale');
    expect(ds.session.pendingResponseCardId).toBe('om_fresh');
    expect(ds.session.pendingResponseCardState).toBe('open');
  });

  it('sequential turns: each turn posts a fresh placeholder and the latest card id wins', async () => {
    const ds = makeDs('chat');
    mocks.sendMessage.mockResolvedValueOnce('om_first').mockResolvedValueOnce('om_second');

    await postPendingResponseCard(ds, 'om_trigger', 'hello', undefined, 'turn-1');
    expect(ds.session.pendingResponseCardId).toBe('om_first');

    await postPendingResponseCard(ds, 'om_trigger2', 'hello again', undefined, 'turn-2');
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(ds.session.pendingResponseCardId).toBe('om_second');
    expect(ds.session.pendingResponseCardState).toBe('open');
  });
});
