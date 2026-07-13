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
const mockReplyMessage = vi.fn(async () => 'msg-id');
vi.mock('../src/im/lark/client.js', () => ({
  getChatMode: (...a: any[]) => mockGetChatMode(...a),
  replyMessage: (...a: any[]) => mockReplyMessage(...a),
}));

const mockGetBot = vi.fn(() => ({
  config: {
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
  getSubstituteDirectBinding: (_app: string, openId: string) => mockDirect.get(openId),
  getSubstituteDirectChat: (_app: string, openId: string, chatId: string) => mockDirect.get(openId)?.chats?.[chatId],
  upsertSubstituteDirectChat: (input: any) => {
    const cur = mockDirect.get(input.substituteOpenId) ?? { chats: {} };
    cur.targetOpenId = input.targetOpenId;
    cur.substituteUserId = input.substituteUserId;
    cur.substituteUnionId = input.substituteUnionId;
    cur.targetName = input.targetName;
    cur.chats = {};
    cur.chats[input.chatId] = { ...input };
    cur.activeChatId = input.chatId;
    mockDirect.set(input.substituteOpenId, cur);
    return cur;
  },
  clearSubstituteDirectChat: (_app: string, openId: string, chatId?: string) => {
    if (!chatId) return mockDirect.delete(openId);
    const cur = mockDirect.get(openId);
    if (!cur?.chats?.[chatId]) return false;
    delete cur.chats[chatId];
    return true;
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
        substituteMode: {
          enabled: true,
          targets: [{ openId: USER, name: 'User' }],
          disclosure: 'prefix',
        },
      },
    });
    mockGetChatMode.mockResolvedValue('group');
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
      expect(actions).toHaveLength(4);
      expect(actions.map((a: any) => a.text.content)).toEqual([...labels, 'cmd.substitute.direct_btn_open_chat']);
      expect(actions.map((a: any) => a.value?.action)).toEqual([...actionValues, undefined]);
      expect(actions[3].multi_url?.url).toContain('openChatId=oc_group');
      expect(actions[3].multi_url?.pc_url).toBe(actions[3].multi_url?.url);
      expect(actions[3].multi_url?.android_url).toBe(actions[3].multi_url?.url);
      expect(actions[3].multi_url?.ios_url).toBe(actions[3].multi_url?.url);
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
      'cmd.substitute.direct_btn_disable_substitute',
      'cmd.substitute.direct_btn_leave_group',
    ], [
      'substitute_direct_enter',
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
      'cmd.substitute.direct_btn_disable_substitute',
      'cmd.substitute.direct_btn_leave_group',
    ], [
      'substitute_direct_exit',
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
      activeChatId: 'oc_group',
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
    expect(mockDirect.get(USER)?.chats?.oc_group).toBeTruthy();

    result = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_exit',
      chatId: 'oc_group',
    });
    expect(result.toast).toEqual({ type: 'success', content: 'cmd.substitute.direct_exit_ok' });
    expect(mockDirect.get(USER)?.chats?.oc_group).toBeFalsy();
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
    expect(Object.keys(mockDirect.get(USER)?.chats ?? {})).toEqual(['oc_group']);

    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group_2',
    });
    expect(mockDirect.get(USER)?.activeChatId).toBe('oc_group_2');
    expect(Object.keys(mockDirect.get(USER)?.chats ?? {})).toEqual(['oc_group_2']);
    expect(mockDirect.get(USER)?.chats?.oc_group_2?.mode).toBe('direct');
  });

  it('DM leave-group makes the bot leave the selected group and removes direct state', async () => {
    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group',
    });
    const result = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_leave_group',
      chatId: 'oc_group',
    });
    expect(mockLeaveChat).toHaveBeenCalledWith(APP, 'oc_group');
    expect(result.toast).toEqual({ type: 'success', content: 'cmd.substitute.direct_leave_group_ok' });
    expect(mockDirect.get(USER)?.chats?.oc_group).toBeFalsy();
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
    expect(mockDirect.get(USER)?.chats?.oc_group).toBeTruthy();
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

    expect(mockDirect.get('ou_sub')).toBeUndefined();
    expect(mockDirect.get(USER)).toMatchObject({
      targetOpenId: 'ou_sub',
      substituteUserId: 'u_sub',
      substituteUnionId: 'on_sub',
      targetName: 'Sub',
      activeChatId: 'oc_group',
      chats: {
        oc_group: expect.objectContaining({ mode: 'direct', targetName: 'Sub' }),
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
      'cmd.substitute.direct_btn_disable_substitute',
      'cmd.substitute.direct_btn_leave_group',
      'cmd.substitute.direct_btn_open_chat',
    ]);
    expect(actions[3].multi_url?.url).toContain('openChatId=oc_group');
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
