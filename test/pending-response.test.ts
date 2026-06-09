import { describe, expect, it } from 'vitest';

import {
  claimPendingResponseCard,
  COMPLETED_REACTION_EMOJI_TYPE,
  createPendingResponseQueue,
  isPendingResponseCardOpen,
  markPendingResponseCardPatched,
  markPendingResponseCardPatchedIfCurrent,
  mergePendingResponseState,
  shouldMarkPendingAsMentionedSend,
  shouldPatchPendingOnExplicitSend,
  shouldWithdrawPreviousPendingOnNewTurn,
  shouldReplyPendingInThread,
  startPendingResponseTurn,
  syncPendingResponseState,
} from '../src/core/pending-response.js';

describe('pending response state', () => {
  it('uses the Feishu GoGoGo emoji for completion notification', () => {
    expect(COMPLETED_REACTION_EMOJI_TYPE).toBe('GoGoGo');
  });

  it('starts and patches pending response state explicitly', () => {
    const session = {} as { pendingResponseCardId?: string; pendingResponseCardState?: 'open' | 'patched'; lastPatchedResponseCardId?: string };

    startPendingResponseTurn(session, 'om_processing');
    expect(session.pendingResponseCardId).toBe('om_processing');
    expect(session.pendingResponseCardState).toBe('open');
    expect(isPendingResponseCardOpen(session)).toBe(true);

    markPendingResponseCardPatched(session);
    expect(session.pendingResponseCardId).toBeUndefined();
    expect(session.lastPatchedResponseCardId).toBe('om_processing');
    expect(session.pendingResponseCardState).toBe('patched');
    expect(isPendingResponseCardOpen(session)).toBe(false);
  });

  it('patches an open pending card for explicit botmux send responses', () => {
    const session = { pendingResponseCardId: 'om_processing', pendingResponseCardState: 'open' as const };

    expect(shouldPatchPendingOnExplicitSend(session, { msgType: 'interactive', sendTopLevel: false, overrideChatId: false, sendInto: false, hasNotificationMentions: false })).toBe(true);
    expect(shouldPatchPendingOnExplicitSend(session, { msgType: 'post', sendTopLevel: false, overrideChatId: false, sendInto: false, hasNotificationMentions: false })).toBe(false);
    expect(shouldPatchPendingOnExplicitSend(session, { msgType: 'interactive', sendTopLevel: true, overrideChatId: false, sendInto: false, hasNotificationMentions: false })).toBe(false);
    expect(shouldPatchPendingOnExplicitSend(session, { msgType: 'interactive', sendTopLevel: false, overrideChatId: true, sendInto: false, hasNotificationMentions: false })).toBe(false);
    expect(shouldPatchPendingOnExplicitSend(session, { msgType: 'interactive', sendTopLevel: false, overrideChatId: false, sendInto: true, hasNotificationMentions: false })).toBe(false);
    expect(shouldPatchPendingOnExplicitSend(session, { msgType: 'interactive', sendTopLevel: false, overrideChatId: false, sendInto: false, hasNotificationMentions: true })).toBe(false);
  });

  it('replies pending cards in thread-scope to seed private chat topics', () => {
    expect(shouldReplyPendingInThread('thread')).toBe(true);
    expect(shouldReplyPendingInThread('chat')).toBe(false);
  });

  it('marks mentioned sends only for same-thread replies, not detours', () => {
    expect(shouldMarkPendingAsMentionedSend({ msgType: 'interactive', sendTopLevel: false, overrideChatId: false, sendInto: false, hasNotificationMentions: true })).toBe(true);
    expect(shouldMarkPendingAsMentionedSend({ msgType: 'interactive', sendTopLevel: true, overrideChatId: false, sendInto: false, hasNotificationMentions: true })).toBe(false);
    expect(shouldMarkPendingAsMentionedSend({ msgType: 'interactive', sendTopLevel: false, overrideChatId: true, sendInto: false, hasNotificationMentions: true })).toBe(false);
    expect(shouldMarkPendingAsMentionedSend({ msgType: 'interactive', sendTopLevel: false, overrideChatId: false, sendInto: true, hasNotificationMentions: true })).toBe(false);
    expect(shouldMarkPendingAsMentionedSend({ msgType: 'interactive', sendTopLevel: false, overrideChatId: false, sendInto: false, hasNotificationMentions: false })).toBe(false);
  });

  it('syncs daemon in-memory pending state from persisted patched state', () => {
    const memory = { pendingResponseCardId: 'om_old_memory', pendingResponseCardState: 'open' as const, lastPatchedResponseCardId: undefined as string | undefined };
    const persisted = { pendingResponseCardId: undefined, pendingResponseCardState: 'patched' as const, lastPatchedResponseCardId: 'om_done' };

    syncPendingResponseState(memory, persisted);

    expect(memory.pendingResponseCardId).toBeUndefined();
    expect(memory.lastPatchedResponseCardId).toBe('om_done');
    expect(memory.pendingResponseCardState).toBe('patched');
    expect(isPendingResponseCardOpen(memory)).toBe(false);
  });

  it('does not treat patched cards as mergeable even if the last patched id is present', () => {
    const session = { pendingResponseCardId: undefined, pendingResponseCardState: 'patched' as const, lastPatchedResponseCardId: 'om_done' };

    expect(isPendingResponseCardOpen(session)).toBe(false);
  });

  it('only marks patched when the current pending card still matches', () => {
    const session = { pendingResponseCardId: 'om_a', pendingResponseCardState: 'open' as const, lastPatchedResponseCardId: undefined as string | undefined };
    expect(markPendingResponseCardPatchedIfCurrent(session, 'om_a')).toBe(true);
    expect(session.pendingResponseCardId).toBeUndefined();
    expect(session.pendingResponseCardState).toBe('patched');
    expect(session.lastPatchedResponseCardId).toBe('om_a');

    const newer = { pendingResponseCardId: 'om_b', pendingResponseCardState: 'open' as const, lastPatchedResponseCardId: undefined as string | undefined };
    expect(markPendingResponseCardPatchedIfCurrent(newer, 'om_a')).toBe(false);
    expect(newer.pendingResponseCardId).toBe('om_b');
    expect(newer.pendingResponseCardState).toBe('open');
    expect(newer.lastPatchedResponseCardId).toBeUndefined();
  });

  it('does not let an old finalizer mark a newer pending card as patched', () => {
    const session = { pendingResponseCardId: 'om_b', pendingResponseCardState: 'open' as const, lastPatchedResponseCardId: undefined as string | undefined };

    expect(markPendingResponseCardPatchedIfCurrent(session, 'om_a')).toBe(false);

    expect(session.pendingResponseCardId).toBe('om_b');
    expect(session.pendingResponseCardState).toBe('open');
    expect(session.lastPatchedResponseCardId).toBeUndefined();
  });

  it('does not withdraw an older pending card when a newer turn starts', () => {
    const session = { pendingResponseCardId: 'om_a', pendingResponseCardState: 'open' as const };

    expect(shouldWithdrawPreviousPendingOnNewTurn(session)).toBe(false);
  });

  it('does not clear pending response state when reading the pending id', () => {
    const session = { pendingResponseCardId: 'om_processing', pendingResponseCardState: 'open' as const };

    expect(claimPendingResponseCard(session)).toBe('om_processing');
    expect(session.pendingResponseCardId).toBe('om_processing');
    expect(session.pendingResponseCardState).toBe('open');
  });

  it('cleans up queue entries after work settles', async () => {
    const queue = createPendingResponseQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;

    const first = queue.run('s1', async () => {
      events.push('first:start');
      await new Promise<void>(resolve => { releaseFirst = resolve; });
      events.push('first:end');
    });
    const second = queue.run('s1', async () => {
      events.push('second:start');
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    expect(queue.size()).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    expect(queue.size()).toBe(0);
  });
});

// mergePendingResponseState reconciles a worker's incoming Session save against
// the daemon's freshly-persisted pending-card state. It is the race guard that
// keeps a placeholder card (and therefore the 完成 emoji) from being lost or
// double-opened when worker and daemon write the same session out of order.
// Used by services/session-store.ts on every persist; previously untested.
type PR = {
  marker?: string;
  pendingResponseCardId?: string;
  pendingResponseCardState?: 'open' | 'patched';
  lastPatchedResponseCardId?: string;
};

describe('mergePendingResponseState', () => {
  it('returns incoming verbatim when there is no existing persisted record', () => {
    const incoming: PR = { marker: 'in', pendingResponseCardId: 'om_x', pendingResponseCardState: 'open' };
    expect(mergePendingResponseState(incoming, undefined)).toBe(incoming);
  });

  it('returns incoming when the existing record carries no pending-card fields', () => {
    const incoming: PR = { marker: 'in', pendingResponseCardId: 'om_x', pendingResponseCardState: 'open' };
    const existing: PR = { marker: 'old' };
    expect(mergePendingResponseState(incoming, existing)).toBe(incoming);
  });

  it('lets a worker that opened a brand-new card win over stale persisted state', () => {
    const incoming: PR = { pendingResponseCardId: 'om_new', pendingResponseCardState: 'open' };
    const existing: PR = { pendingResponseCardState: 'patched', lastPatchedResponseCardId: 'om_old' };
    expect(mergePendingResponseState(incoming, existing)).toBe(incoming);
  });

  it('does NOT re-open a card the persisted state already patched (incoming.open id === existing.lastPatched)', () => {
    const incoming: PR = { pendingResponseCardId: 'om_dup', pendingResponseCardState: 'open' };
    const existing: PR = { pendingResponseCardState: 'patched', lastPatchedResponseCardId: 'om_dup' };
    const merged = mergePendingResponseState(incoming, existing);
    expect(merged.pendingResponseCardId).toBeUndefined();
    expect(merged.pendingResponseCardState).toBe('patched');
    expect(merged.lastPatchedResponseCardId).toBe('om_dup');
  });

  it('accepts an incoming patch when the existing record has no newer open card', () => {
    const incoming: PR = { pendingResponseCardState: 'patched', lastPatchedResponseCardId: 'om_a' };
    const existing: PR = { pendingResponseCardState: 'patched', lastPatchedResponseCardId: 'om_a' };
    expect(mergePendingResponseState(incoming, existing)).toBe(incoming);
  });

  it('protects a newer open card from being clobbered by an older finalizer marking patched', () => {
    const incoming: PR = { pendingResponseCardState: 'patched', lastPatchedResponseCardId: 'om_a' };
    const existing: PR = { pendingResponseCardId: 'om_b', pendingResponseCardState: 'open' };
    const merged = mergePendingResponseState(incoming, existing);
    expect(merged.pendingResponseCardId).toBe('om_b');
    expect(merged.pendingResponseCardState).toBe('open');
    expect(merged.lastPatchedResponseCardId).toBeUndefined();
  });

  it('preserves a persisted open card when the incoming save has no pending intent, keeping incoming\'s other fields', () => {
    const incoming: PR = { marker: 'keep' };
    const existing: PR = { pendingResponseCardId: 'om_b', pendingResponseCardState: 'open' };
    const merged = mergePendingResponseState(incoming, existing);
    expect(merged.marker).toBe('keep');
    expect(merged.pendingResponseCardId).toBe('om_b');
    expect(merged.pendingResponseCardState).toBe('open');
    expect(merged).not.toBe(incoming);
    expect(merged).not.toBe(existing);
  });
});
