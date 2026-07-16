import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsBotMentioned = vi.fn(() => true);
const mockCanOperate = vi.fn(() => true);
const mockCanTalk = vi.fn(() => true);
vi.mock('../src/im/lark/event-dispatcher.js', () => ({
  isBotMentioned: (...a: any[]) => mockIsBotMentioned(...a),
  canOperate: (...a: any[]) => mockCanOperate(...a),
  canTalk: (...a: any[]) => mockCanTalk(...a),
  extractMessageTextForRouting: (m: any) => {
    try { return JSON.parse(m.content ?? '{}').text ?? ''; } catch { return ''; }
  },
}));

vi.mock('../src/im/lark/message-parser.js', () => ({
  stripLeadingMentions: (s: string) => s,
}));

const mockGetChatMode = vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p');
const mockGetChatNameAndMode = vi.fn(async (_app: string, chatId: string) => ({ name: chatId === 'oc_group' ? 'Group' : chatId, mode: 'group' as const }));
const mockReplyMessage = vi.fn(async () => 'msg-id');
const mockSendUserMessage = vi.fn(async () => 'dm-root-msg');
vi.mock('../src/im/lark/client.js', () => ({
  getChatMode: (...a: any[]) => mockGetChatMode(...a),
  getChatNameAndMode: (...a: any[]) => mockGetChatNameAndMode(...a),
  replyMessage: (...a: any[]) => mockReplyMessage(...a),
  sendUserMessage: (...a: any[]) => mockSendUserMessage(...a),
}));

const mockGetBot = vi.fn(() => ({
  config: {
    p2pMode: 'chat',
    substituteMode: {
      enabled: true,
      targets: [{ openId: USER, name: 'User' }],
      disclosure: 'prefix',
    },
  },
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...a: any[]) => mockGetBot(...a),
}));

const mockListChats = vi.fn(async () => [{ chatId: 'oc_group', name: 'Group', chatMode: 'group' }]);
const mockLeaveChat = vi.fn(async () => ({ ok: true as const }));
vi.mock('../src/services/groups-store.js', () => ({
  listChats: (...a: any[]) => mockListChats(...a),
  leaveChat: (...a: any[]) => mockLeaveChat(...a),
}));

const mockIsSubstituteEnabledForChat = vi.fn(() => true);
const mockSetSubstituteEnabledForChat = vi.fn();
vi.mock('../src/services/substitute-chat-toggle-store.js', () => ({
  isSubstituteEnabledForChat: (...a: any[]) => mockIsSubstituteEnabledForChat(...a),
  setSubstituteEnabledForChat: (...a: any[]) => mockSetSubstituteEnabledForChat(...a),
}));

const mockDirect = new Map<string, any>();
vi.mock('../src/services/substitute-direct-store.js', () => ({
  substituteDirectTargetKey: (scope: string | undefined, anchor: string | undefined, chatId?: string) => scope === 'thread' && anchor ? `thread:${anchor}` : `chat:${anchor || chatId}`,
  getSubstituteDirectBinding: (_app: string, openId: string) => mockDirect.get(openId),
  getSubstituteDirectBindingForSender: (_app: string, openId: string) => mockDirect.get(openId),
  getSubstituteDirectChat: (_app: string, openId: string, chatId: string) => mockDirect.get(openId)?.chats?.[chatId],
  upsertSubstituteDirectChat: (input: any) => {
    const cur = mockDirect.get(input.substituteOpenId) ?? { chats: {} };
    cur.targetOpenId = input.targetOpenId;
    cur.substituteUserId = input.substituteUserId;
    cur.substituteUnionId = input.substituteUnionId;
    cur.targetName = input.targetName;
    const targetKey = input.targetKey ?? input.chatId;
    const existingChat = cur.chats[targetKey];
    if (!input.preserveExistingChats) cur.chats = {};
    cur.chats[targetKey] = {
      ...input,
      directBotMention: input.directBotMention ?? existingChat?.directBotMention,
    };
    cur.activeChatId = targetKey;
    mockDirect.set(input.substituteOpenId, cur);
    return cur;
  },
  setSubstituteDirectChatBotMention: (input: any) => {
    const cur = mockDirect.get(input.substituteOpenId) ?? { chats: {} };
    const targetKey = cur.chats[input.targetKeyOrChatId] || /^(chat|thread):/.test(input.targetKeyOrChatId)
      ? input.targetKeyOrChatId
      : input.scope === 'thread' && input.anchor
        ? `thread:${input.anchor}`
        : `chat:${input.anchor || input.chatId || input.targetKeyOrChatId}`;
    const chat = cur.chats[targetKey] ?? {
      targetKey,
      chatId: input.chatId,
      scope: input.scope,
      anchor: input.anchor,
      enabled: false,
      mode: 'direct',
    };
    chat.directBotMention = input.enabled;
    cur.chats[targetKey] = chat;
    if (input.enabled) {
      for (const [otherOpenId, other] of mockDirect.entries()) {
        for (const [otherKey, otherChat] of Object.entries<any>(other.chats ?? {})) {
          if (otherOpenId === input.substituteOpenId && otherKey === targetKey) continue;
          if (otherKey !== targetKey && otherChat.chatId !== chat.chatId) continue;
          if (otherChat.scope !== chat.scope || otherChat.anchor !== chat.anchor) continue;
          otherChat.directBotMention = false;
        }
      }
    }
    mockDirect.set(input.substituteOpenId, cur);
    return true;
  },
  deactivateSubstituteDirectChat: (_app: string, openId: string, chatId: string) => {
    const cur = mockDirect.get(openId);
    const chat = cur?.chats?.[chatId];
    if (!chat || chat.enabled === false) return false;
    chat.enabled = false;
    return true;
  },
  clearSubstituteDirectChat: (_app: string, openId: string, chatId?: string) => {
    if (!chatId) return mockDirect.delete(openId);
    const cur = mockDirect.get(openId);
    if (!cur?.chats?.[chatId]) return false;
    delete cur.chats[chatId];
    return true;
  },
  clearSubstituteDirectChatsByGroup: (_app: string, openId: string, chatId?: string) => {
    const cur = mockDirect.get(openId);
    if (!cur || !chatId) return false;
    let changed = false;
    for (const [targetKey, chat] of Object.entries<any>(cur.chats ?? {})) {
      if (chat.chatId !== chatId) continue;
      delete cur.chats[targetKey];
      changed = true;
    }
    if (!Object.keys(cur.chats ?? {}).length) mockDirect.delete(openId);
    return changed;
  },
}));

vi.mock('../src/i18n/index.js', () => ({
  t: (key: string) => key,
  localeForBot: () => 'zh',
  setBotLookup: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleSubstituteDirectCardAction, tryHandleEchoCommand } from '../src/im/lark/substitute-command.js';

const APP = 'app-x';
const USER = 'ou_user';

function msg(text: string, chatType: 'group' | 'p2p' = 'group') {
  return {
    chat_id: chatType === 'p2p' ? 'oc_dm' : 'oc_group',
    message_id: 'om_1',
    chat_type: chatType,
    content: JSON.stringify({ text }),
    mentions: [],
  };
}

function lastReply(): string | undefined {
  const calls = mockReplyMessage.mock.calls;
  return calls.length ? calls[calls.length - 1][2] : undefined;
}

function lastReplyCard(): any {
  const raw = lastReply();
  return raw ? JSON.parse(raw) : undefined;
}

function cardActions(card: any): any[] {
  return (card?.elements ?? []).flatMap((el: any) => el.actions ?? []);
}

describe('tryHandleEchoCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBotMentioned.mockReturnValue(true);
    mockCanOperate.mockReturnValue(true);
    mockCanTalk.mockReturnValue(true);
    mockGetBot.mockReturnValue({
      config: {
        p2pMode: 'chat',
        substituteMode: {
          enabled: true,
          targets: [{ openId: USER, name: 'User' }],
          disclosure: 'prefix',
        },
      },
    });
    mockGetChatMode.mockResolvedValue('group');
    mockGetChatNameAndMode.mockImplementation(async (_app: string, chatId: string) => ({ name: chatId === 'oc_group' ? 'Group' : chatId, mode: 'group' as const }));
    mockIsSubstituteEnabledForChat.mockReturnValue(true);
    mockListChats.mockResolvedValue([{ chatId: 'oc_group', name: 'Group', chatMode: 'group' }]);
    mockLeaveChat.mockResolvedValue({ ok: true });
    mockDirect.clear();
  });

  it('non-command messages are ignored', async () => {
    expect(await tryHandleEchoCommand(APP, msg('hello'), USER)).toBe(false);
  });

  it('/substitute text commands are no longer handled', async () => {
    expect(await tryHandleEchoCommand(APP, msg('/substitute list', 'p2p'), USER)).toBe(false);
    expect(await tryHandleEchoCommand(APP, msg('/substitute off'), USER)).toBe(false);
    expect(mockReplyMessage).not.toHaveBeenCalled();
    expect(mockSetSubstituteEnabledForChat).not.toHaveBeenCalled();
  });

  it('/echo is the only text command and does not accept subcommands', async () => {
    expect(await tryHandleEchoCommand(APP, msg('/echo list', 'p2p'), USER)).toBe(true);
    expect(lastReply()).toBe('cmd.echo.usage');
  });

  it('DM list shows substitute groups', async () => {
    await tryHandleEchoCommand(APP, msg('/echo', 'p2p'), USER);
    expect(lastReply()).toContain('cmd.substitute.direct_list_header');
    expect(lastReply()).toContain('oc_group');
  });

  it('DM list merges active sessions with groups that have no session', async () => {
    mockListChats.mockResolvedValue([
      { chatId: 'oc_group', name: 'Group', chatMode: 'group' },
      { chatId: 'oc_group_2', name: 'Group 2', chatMode: 'group' },
    ]);
    const sessions = [
      {
        larkAppId: APP,
        chatId: 'oc_group',
        chatType: 'group',
        scope: 'chat',
        session: { sessionId: 'sess-chat', status: 'active', chatId: 'oc_group', rootMessageId: 'om_chat_seed', title: 'Chat Session', cliId: 'claude-code', createdAt: new Date().toISOString() },
        lastMessageAt: 2,
        worker: null,
      },
      {
        larkAppId: APP,
        chatId: 'oc_group',
        chatType: 'group',
        scope: 'thread',
        session: { sessionId: 'sess-thread', status: 'active', chatId: 'oc_group', rootMessageId: 'om_topic_root', title: 'Topic Session', cliId: 'claude-code', createdAt: new Date().toISOString() },
        lastMessageAt: 1,
        worker: null,
      },
    ];

    await tryHandleEchoCommand(APP, msg('/echo', 'p2p'), USER, sessions as any);

    const raw = lastReply();
    expect(raw).toContain('Group-Chat Session');
    expect(raw).toContain('Group-Topic Session');
    expect(raw).toContain('Group 2 cmd.substitute.direct_no_session');
    const actions = cardActions(lastReplyCard());
    expect(actions.filter((a: any) => a.value?.action === 'substitute_direct_manage')).toHaveLength(3);
    expect(actions.filter((a: any) => a.value?.target_key === 'chat:oc_group')).toHaveLength(2);
    expect(actions.filter((a: any) => a.value?.target_key === 'thread:om_topic_root')).toHaveLength(2);
    expect(actions.filter((a: any) => a.value?.target_key === 'chat:oc_group_2')).toHaveLength(2);
  });

  it('DM list exposes manage, open chat, and leave group buttons per group', async () => {
    await tryHandleEchoCommand(APP, msg('/echo', 'p2p'), USER);
    let actions = cardActions(lastReplyCard());
    let manageActions = actions.filter((a: any) => a.value?.action === 'substitute_direct_manage');
    let openChatActions = actions.filter((a: any) => a.multi_url?.url?.includes('openChatId=oc_group'));
    let leaveGroupActions = actions.filter((a: any) => a.value?.action === 'substitute_direct_leave_group');
    expect(manageActions).toHaveLength(1);
    expect(manageActions[0].text.content).toBe('cmd.substitute.direct_btn_manage');
    expect(manageActions[0].value.chat_id).toBe('oc_group');
    expect(openChatActions).toHaveLength(1);
    expect(openChatActions[0].text.content).toBe('cmd.substitute.direct_btn_open_chat');
    expect(leaveGroupActions).toHaveLength(1);
    expect(leaveGroupActions[0].text.content).toBe('cmd.substitute.direct_btn_leave_group');
    expect(leaveGroupActions[0].disabled).toBe(false);

    mockIsSubstituteEnabledForChat.mockReturnValue(false);
    await tryHandleEchoCommand(APP, msg('/echo', 'p2p'), USER);
    expect(lastReply()).toContain('cmd.substitute.direct_substitute_off');
    actions = cardActions(lastReplyCard());
    manageActions = actions.filter((a: any) => a.value?.action === 'substitute_direct_manage');
    expect(manageActions).toHaveLength(1);
  });

  it('DM list disables leave-group for non-operators but still shows the button', async () => {
    mockCanOperate.mockImplementation((_app, chatId) => chatId === undefined ? false : true);

    await tryHandleEchoCommand(APP, msg('/echo', 'p2p'), USER);

    const leaveGroupActions = cardActions(lastReplyCard())
      .filter((a: any) => a.value?.action === 'substitute_direct_leave_group');
    expect(leaveGroupActions).toHaveLength(1);
    expect(leaveGroupActions[0].disabled).toBe(true);
  });

  it('detail card uses dynamic substitute and direct buttons per group', async () => {
    const expectActionRow = (actions: any[], labels: string[], actionValues: Array<string | undefined>) => {
      expect(actions).toHaveLength(5);
      expect(actions.map((a: any) => a.text.content)).toEqual([...labels, 'cmd.substitute.direct_btn_open_chat']);
      expect(actions.map((a: any) => a.value?.action)).toEqual([...actionValues, undefined]);
      expect(actions[4].multi_url?.url).toContain('openChatId=oc_group');
      expect(actions[4].multi_url?.pc_url).toBe(actions[4].multi_url?.url);
      expect(actions[4].multi_url?.android_url).toBe(actions[4].multi_url?.url);
      expect(actions[4].multi_url?.ios_url).toBe(actions[4].multi_url?.url);
    };

    let result = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_manage',
      chatId: 'oc_group',
    });
    let actions = cardActions(result.card.data).filter((a: any) => a.value?.action !== 'substitute_direct_back');
    expectActionRow(actions, [
      'cmd.substitute.direct_btn_enter',
      'cmd.substitute.direct_btn_enable_bot_mention',
      'cmd.substitute.direct_btn_disable_substitute',
      'cmd.substitute.direct_btn_leave_group',
    ], [
      'substitute_direct_enter',
      'substitute_direct_bot_mention_enable',
      'substitute_direct_disable',
      'substitute_direct_leave_group',
    ]);

    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group',
    });
    result = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_manage',
      chatId: 'oc_group',
    });
    actions = cardActions(result.card.data).filter((a: any) => a.value?.action !== 'substitute_direct_back');
    expectActionRow(actions, [
      'cmd.substitute.direct_btn_exit',
      'cmd.substitute.direct_btn_enable_bot_mention',
      'cmd.substitute.direct_btn_disable_substitute',
      'cmd.substitute.direct_btn_leave_group',
    ], [
      'substitute_direct_exit',
      'substitute_direct_bot_mention_enable',
      'substitute_direct_disable',
      'substitute_direct_leave_group',
    ]);
  });

  it('DM list paginates groups and supports a jump-page selector', async () => {
    mockListChats.mockResolvedValue(Array.from({ length: 12 }, (_, i) => ({
      chatId: `oc_group_${i + 1}`,
      name: `Group ${i + 1}`,
      chatMode: 'group',
    })));

    await tryHandleEchoCommand(APP, msg('/echo', 'p2p'), USER);

    const card = lastReplyCard();
    expect(cardActions(card).filter((a: any) => a.value?.action === 'substitute_direct_manage')).toHaveLength(5);
    expect(cardActions(card).filter((a: any) => a.value?.action === 'substitute_direct_leave_group')).toHaveLength(5);
    const actions = cardActions(card);
    expect(actions.some((a: any) => a.value?.action === 'substitute_direct_page')).toBe(true);
    expect(actions.some((a: any) => a.tag === 'select_static')).toBe(true);
    expect(lastReply()).toContain('cmd.substitute.direct_page_indicator');
  });

  it('DM list does not require the sender to already be a substitute target', async () => {
    mockGetBot.mockReturnValue({ config: { substituteMode: { enabled: true, targets: [], disclosure: 'prefix' } } });

    await tryHandleEchoCommand(APP, msg('/echo', 'p2p'), USER);

    expect(lastReply()).toContain('cmd.substitute.direct_list_header');
    expect(lastReply()).toContain('oc_group');
  });

  it('DM list is forbidden when sender is neither operator nor substitute target', async () => {
    mockCanOperate.mockReturnValue(false);
    mockGetBot.mockReturnValue({ config: { substituteMode: { enabled: true, targets: [], disclosure: 'prefix' } } });

    await tryHandleEchoCommand(APP, msg('/echo', 'p2p'), USER);

    expect(lastReply()).toBe('cmd.substitute.direct_forbidden');
  });

  it('DM list remains forbidden for a stale direct binding after the user loses substitute permission', async () => {
    mockCanOperate.mockReturnValue(false);
    mockGetBot.mockReturnValue({ config: { substituteMode: { enabled: true, targets: [], disclosure: 'prefix' } } });
    mockDirect.set(USER, {
      activeChatId: 'chat:oc_group',
      chats: {
        oc_group: { chatId: 'oc_group', mode: 'direct' },
      },
    });

    await tryHandleEchoCommand(APP, msg('/echo', 'p2p'), USER);

    expect(lastReply()).toBe('cmd.substitute.direct_forbidden');
  });

  it('DM list filters out topic chats using getChatMode', async () => {
    mockListChats.mockResolvedValue([
      { chatId: 'oc_group', name: 'Group', chatMode: 'group' },
      { chatId: 'oc_topic', name: 'Topic', chatMode: 'group' },
    ]);
    mockGetChatMode.mockImplementation(async (_app, chatId) => chatId === 'oc_topic' ? 'topic' : 'group');

    await tryHandleEchoCommand(APP, msg('/echo', 'p2p'), USER);

    expect(lastReply()).toContain('oc_group');
    expect(lastReply()).not.toContain('oc_topic');
  });

  it('card actions enter/exit direct mode for a group', async () => {
    let result = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group',
    });
    expect(result.toast).toEqual({ type: 'success', content: 'cmd.substitute.direct_enter_ok' });
    expect(mockDirect.get(USER)?.chats?.['chat:oc_group']).toBeTruthy();

    result = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_exit',
      chatId: 'oc_group',
    });
    expect(result.toast).toEqual({ type: 'success', content: 'cmd.substitute.direct_exit_ok' });
    expect(mockDirect.get(USER)?.chats?.['chat:oc_group']?.enabled).toBe(false);
  });

  it('card enter keeps only one active substitute group', async () => {
    mockListChats.mockResolvedValue([
      { chatId: 'oc_group', name: 'Group', chatMode: 'group' },
      { chatId: 'oc_group_2', name: 'Group 2', chatMode: 'group' },
    ]);

    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group',
    });
    expect(Object.keys(mockDirect.get(USER)?.chats ?? {})).toEqual(['chat:oc_group']);

    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group_2',
    });
    expect(mockDirect.get(USER)?.activeChatId).toBe('chat:oc_group_2');
    expect(Object.keys(mockDirect.get(USER)?.chats ?? {})).toEqual(['chat:oc_group_2']);
    expect(mockDirect.get(USER)?.chats?.['chat:oc_group_2']?.mode).toBe('direct');
  });

  it('thread-mode DM allows multiple active substitute groups with separate DM roots', async () => {
    mockGetBot.mockReturnValue({
      config: {
        substituteMode: {
          enabled: true,
          targets: [{ openId: USER, name: 'User' }],
          disclosure: 'prefix',
        },
      },
    });
    mockListChats.mockResolvedValue([
      { chatId: 'oc_group', name: 'Group', chatMode: 'group' },
      { chatId: 'oc_group_2', name: 'Group 2', chatMode: 'group' },
    ]);
    mockSendUserMessage
      .mockResolvedValueOnce('dm-root-1')
      .mockResolvedValueOnce('dm-root-2');

    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group',
    });
    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group_2',
    });

    expect(Object.keys(mockDirect.get(USER)?.chats ?? {}).sort()).toEqual(['chat:oc_group', 'chat:oc_group_2']);
    expect(mockDirect.get(USER)?.chats?.['chat:oc_group']?.dmRootMessageId).toBe('dm-root-1');
    expect(mockDirect.get(USER)?.chats?.['chat:oc_group_2']?.dmRootMessageId).toBe('dm-root-2');
    expect(mockSendUserMessage).toHaveBeenCalledTimes(2);

    await tryHandleEchoCommand(APP, msg('/echo', 'p2p'), USER);

    const raw = lastReply();
    expect(raw).toContain('cmd.substitute.direct_state_on');
    expect(raw).not.toContain('cmd.substitute.direct_state_active');
  });

  it('DM leave-group makes the bot leave the selected group and removes direct state', async () => {
    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group',
    });
    mockDirect.get(USER).chats['thread:om_topic_root'] = {
      targetKey: 'thread:om_topic_root',
      scope: 'thread',
      anchor: 'om_topic_root',
      chatId: 'oc_group',
      mode: 'direct',
      enabled: true,
      updatedAt: Date.now(),
    };
    const result = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_leave_group',
      chatId: 'oc_group',
    });
    expect(mockLeaveChat).toHaveBeenCalledWith(APP, 'oc_group');
    expect(result.toast).toEqual({ type: 'success', content: 'cmd.substitute.direct_leave_group_ok' });
    expect(mockDirect.get(USER)).toBeUndefined();
  });

  it('DM leave-group requires operator permission', async () => {
    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group',
    });
    mockCanOperate.mockReturnValue(false);

    const result = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_leave_group',
      chatId: 'oc_group',
    });

    expect(mockLeaveChat).not.toHaveBeenCalled();
    expect(result.toast).toEqual({ type: 'error', content: 'cmd.substitute.owner_only' });
  });

  it('card action enter updates direct mode and returns an updated card', async () => {
    const result = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group',
    });

    expect(result.toast).toEqual({ type: 'success', content: 'cmd.substitute.direct_enter_ok' });
    expect(result.card.type).toBe('raw');
    expect(mockDirect.get(USER)?.chats?.['chat:oc_group']).toBeTruthy();
  });

  it('entering direct mode in DM thread mode always creates a fresh topic root', async () => {
    mockGetBot.mockReturnValue({
      config: {
        p2pMode: 'thread',
        substituteMode: {
          enabled: true,
          targets: [{ openId: USER, name: 'User' }],
          disclosure: 'prefix',
        },
      },
    });
    mockSendUserMessage
      .mockResolvedValueOnce('dm-root-old')
      .mockResolvedValueOnce('dm-root-new');

    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group',
    });
    expect(mockDirect.get(USER)?.chats?.['chat:oc_group']?.dmRootMessageId).toBe('dm-root-old');
    mockDirect.get(USER).chats['chat:oc_group'].dmToGroupMessageIds = { 'old-dm-reply': 'old-group-message' };

    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_exit',
      chatId: 'oc_group',
    });
    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group',
    });

    expect(mockDirect.get(USER)?.chats?.['chat:oc_group']?.dmRootMessageId).toBe('dm-root-new');
    expect(mockDirect.get(USER)?.chats?.['chat:oc_group']?.dmToGroupMessageIds).toBeUndefined();
    expect(mockSendUserMessage).toHaveBeenCalledTimes(2);
  });

  it('operator entering direct mode stores state under the configured substitute target', async () => {
    mockGetBot.mockReturnValue({
      config: {
        substituteMode: {
          enabled: true,
          targets: [{ openId: 'ou_sub', userId: 'u_sub', unionId: 'on_sub', name: 'Sub' }],
          disclosure: 'prefix',
        },
      },
    });

    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group',
    });

    expect(mockDirect.get(USER)).toBeUndefined();
    expect(mockDirect.get('ou_sub')).toMatchObject({
      targetOpenId: 'ou_sub',
      substituteUserId: 'u_sub',
      substituteUnionId: 'on_sub',
      targetName: 'Sub',
      activeChatId: 'chat:oc_group',
      chats: {
        'chat:oc_group': expect.objectContaining({ mode: 'direct', targetName: 'Sub' }),
      },
    });
  });

  it('operator card action enter refreshes the card as direct mode on', async () => {
    mockGetBot.mockReturnValue({
      config: {
        substituteMode: {
          enabled: true,
          targets: [{ openId: 'ou_sub', name: 'Sub' }],
          disclosure: 'prefix',
        },
      },
    });

    const result = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group',
    });

    const detail = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_manage',
      chatId: 'oc_group',
    });
    const actions = cardActions(detail.card.data).filter((a: any) => a.value?.action !== 'substitute_direct_back');
    expect(actions.map((a: any) => a.text.content)).toEqual([
      'cmd.substitute.direct_btn_exit',
      'cmd.substitute.direct_btn_enable_bot_mention',
      'cmd.substitute.direct_btn_disable_substitute',
      'cmd.substitute.direct_btn_leave_group',
      'cmd.substitute.direct_btn_open_chat',
    ]);
    expect(actions[4].multi_url?.url).toContain('openChatId=oc_group');
  });

  it('card action toggles @bot forwarding for the selected direct session', async () => {
    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group',
    });

    const on = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_bot_mention_enable',
      chatId: 'oc_group',
      detailTargetKey: 'chat:oc_group',
    });
    expect(on.toast).toEqual({ type: 'success', content: 'cmd.substitute.direct_bot_mention_updated_on' });
    expect(mockDirect.get(USER)?.chats?.['chat:oc_group']?.directBotMention).toBe(true);
    expect(JSON.stringify(on.card.data)).toContain('cmd.substitute.direct_btn_disable_bot_mention');

    const off = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_bot_mention_disable',
      chatId: 'oc_group',
      detailTargetKey: 'chat:oc_group',
    });
    expect(off.toast).toEqual({ type: 'success', content: 'cmd.substitute.direct_bot_mention_updated_off' });
    expect(mockDirect.get(USER)?.chats?.['chat:oc_group']?.directBotMention).toBe(false);
    expect(JSON.stringify(off.card.data)).toContain('cmd.substitute.direct_btn_enable_bot_mention');
  });

  it('card action can preconfigure @bot forwarding before entering direct mode', async () => {
    const on = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_bot_mention_enable',
      chatId: 'oc_group',
      detailTargetKey: 'chat:oc_group',
    });
    expect(on.toast).toEqual({ type: 'success', content: 'cmd.substitute.direct_bot_mention_updated_on' });
    expect(mockDirect.get(USER)?.chats?.['chat:oc_group']).toMatchObject({
      enabled: false,
      directBotMention: true,
    });

    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group',
      detailTargetKey: 'chat:oc_group',
    });

    expect(mockDirect.get(USER)?.chats?.['chat:oc_group']).toMatchObject({
      mode: 'direct',
      directBotMention: true,
    });
  });

  it('card action preserves preconfigured @bot forwarding for a thread session', async () => {
    const activeSessions = [{
      larkAppId: APP,
      chatId: 'oc_group',
      chatType: 'group',
      scope: 'thread',
      session: { sessionId: 'sess-thread', status: 'active', chatId: 'oc_group', rootMessageId: 'om_topic_root', title: 'Topic Session', cliId: 'claude-code', createdAt: new Date().toISOString() },
      lastMessageAt: 1,
      worker: null,
    }] as any;

    const on = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_bot_mention_enable',
      chatId: 'oc_group',
      detailTargetKey: 'thread:om_topic_root',
      activeSessions,
    });
    expect(on.toast).toEqual({ type: 'success', content: 'cmd.substitute.direct_bot_mention_updated_on' });
    expect(mockDirect.get(USER)?.chats?.['thread:om_topic_root']).toMatchObject({
      scope: 'thread',
      anchor: 'om_topic_root',
      enabled: false,
      directBotMention: true,
    });
    expect(mockDirect.get(USER)?.chats?.['chat:thread:om_topic_root']).toBeUndefined();

    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group',
      detailTargetKey: 'thread:om_topic_root',
      activeSessions,
    });

    expect(mockDirect.get(USER)?.chats?.['thread:om_topic_root']).toMatchObject({
      mode: 'direct',
      directBotMention: true,
    });
    expect(mockDirect.get(USER)?.activeChatId).toBe('thread:om_topic_root');
  });

  it('card action keeps only one @bot forwarding receiver for the same session', async () => {
    mockGetBot.mockReturnValue({
      config: {
        substituteMode: {
          enabled: true,
          targets: [
            { openId: USER, name: 'User' },
            { openId: 'ou_other', name: 'Other' },
          ],
          disclosure: 'prefix',
        },
      },
    });
    mockDirect.set('ou_other', {
      chats: {
        'chat:oc_group': {
          targetKey: 'chat:oc_group',
          chatId: 'oc_group',
          scope: 'chat',
          anchor: 'oc_group',
          mode: 'direct',
          enabled: true,
          directBotMention: true,
          updatedAt: Date.now(),
        },
      },
      activeChatId: 'chat:oc_group',
    });

    const on = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_bot_mention_enable',
      chatId: 'oc_group',
      detailTargetKey: 'chat:oc_group',
    });

    expect(on.toast).toEqual({ type: 'success', content: 'cmd.substitute.direct_bot_mention_updated_on' });
    expect(mockDirect.get(USER)?.chats?.['chat:oc_group']?.directBotMention).toBe(true);
    expect(mockDirect.get('ou_other')?.chats?.['chat:oc_group']?.directBotMention).toBe(false);
  });

  it('card action can enable and disable substitute for the target group', async () => {
    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_disable',
      chatId: 'oc_group',
    });
    expect(mockSetSubstituteEnabledForChat).toHaveBeenCalledWith(APP, 'oc_group', false);

    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enable',
      chatId: 'oc_group',
    });
    expect(mockSetSubstituteEnabledForChat).toHaveBeenCalledWith(APP, 'oc_group', true);
  });

  it('card action requires operator permission to enable or disable substitute', async () => {
    mockCanOperate.mockReturnValue(false);

    const result = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_disable',
      chatId: 'oc_group',
    });

    expect(result.toast).toEqual({ type: 'error', content: 'cmd.substitute.owner_only' });
    expect(mockSetSubstituteEnabledForChat).not.toHaveBeenCalled();
  });
});
