import { canOperate, extractMessageTextForRouting } from './event-dispatcher.js';
import { stripLeadingMentions } from './message-parser.js';
import { getChatMode, getChatNameAndMode, replyMessage, sendUserMessage } from './client.js';
import { isSubstituteEnabledForChat, setSubstituteEnabledForChat } from '../../services/substitute-chat-toggle-store.js';
import {
  clearSubstituteDirectChat,
  clearSubstituteDirectChatsByGroup,
  deactivateSubstituteDirectChat,
  getSubstituteDirectBindingForSender,
  setSubstituteDirectChatBotMention,
  substituteDirectTargetKey,
  upsertSubstituteDirectChat,
} from '../../services/substitute-direct-store.js';
import { getBot } from '../../bot-registry.js';
import { leaveChat, listChats } from '../../services/groups-store.js';
import { chatAppLink, normalizeBrand } from './lark-hosts.js';
import { directMultiUrl } from './card-builder.js';
import { localeForBot, t } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';
import type { DaemonSession } from '../../core/types.js';
import { sessionAnchorId, sessionKey } from '../../core/types.js';

const DIRECT_ACTIONS = new Set([
  'substitute_direct_page',
  'substitute_direct_manage',
  'substitute_direct_back',
  'substitute_direct_enter',
  'substitute_direct_exit',
  'substitute_direct_bot_mention_enable',
  'substitute_direct_bot_mention_disable',
  'substitute_direct_leave_group',
  'substitute_direct_enable',
  'substitute_direct_disable',
]);

export function isSubstituteDirectAction(action: unknown): boolean {
  return typeof action === 'string' && DIRECT_ACTIONS.has(action);
}

function substituteTargetForOpenId(larkAppId: string, openId: string | undefined) {
  if (!openId) return undefined;
  const cfg = getBot(larkAppId).config.substituteMode;
  return cfg?.targets?.find(t => t.openId === openId);
}

function substituteTargetForDirectAction(larkAppId: string, openId: string | undefined) {
  const directTarget = substituteTargetForOpenId(larkAppId, openId);
  if (directTarget?.openId) return directTarget;
  const cfg = getBot(larkAppId).config.substituteMode;
  const targetsWithOpenId = cfg?.targets?.filter(t => t.openId) ?? [];
  return targetsWithOpenId.length === 1 ? targetsWithOpenId[0] : undefined;
}

function substituteBindingOpenIdForControls(larkAppId: string, openId: string | undefined): string | undefined {
  return substituteTargetForDirectAction(larkAppId, openId)?.openId ?? openId;
}

function canUseDirectControls(larkAppId: string, openId: string | undefined): boolean {
  if (!openId) return false;
  return canOperate(larkAppId, undefined, openId) || !!substituteTargetForOpenId(larkAppId, openId);
}

function canManageDirectSession(larkAppId: string, openId: string | undefined): boolean {
  if (!openId) return false;
  return canOperate(larkAppId, undefined, openId) || !!substituteTargetForOpenId(larkAppId, openId)?.openId;
}

const DIRECT_CHAT_PAGE_SIZE = 5;
const DIRECT_CHAT_JUMP_PAGE_MAX_OPTIONS = 50;

type DirectChatRow = {
  targetKey: string;
  scope: 'chat' | 'thread';
  anchor: string;
  chatId: string;
  name?: string;
  title?: string;
  sessionId?: string;
  enabled: boolean;
  active: boolean;
  mode?: 'direct';
  substituteEnabled: boolean;
  directBotMention: boolean;
  directBotMentionConfigured: boolean;
  canManageDirect: boolean;
  canOperateChat: boolean;
  canLeaveGroup: boolean;
};

type DirectCardState = {
  page?: number;
  detailTargetKey?: string;
  p2pThreadMode?: boolean;
};

function isP2pThreadMode(larkAppId: string): boolean {
  try { return getBot(larkAppId).config.p2pMode !== 'chat'; } catch { return true; }
}

function isEchoDirectSession(ds: DaemonSession): boolean {
  if (ds.worker) return true;
  if (ds.session.cliId) return true;
  if (ds.session.lastCliInput) return true;
  return false;
}

function directChatDisplayTitle(chatName: string | undefined, chatId: string, sessionTitle: string | undefined): string {
  const title = sessionTitle || chatName || chatId;
  if (!chatName || chatName === chatId) return title;
  if (title === chatName || title.startsWith(`${chatName}-`)) return title;
  return `${chatName}-${title}`;
}

async function listSubstituteDirectChats(
  larkAppId: string,
  openId: string | undefined,
  activeSessions?: Iterable<DaemonSession> | Map<string, DaemonSession>,
): Promise<DirectChatRow[]> {
  if (!canUseDirectControls(larkAppId, openId)) return [];
  const bindingOpenId = substituteBindingOpenIdForControls(larkAppId, openId);
  const binding = getSubstituteDirectBindingForSender(larkAppId, bindingOpenId);
  const defaultDirectBotMention = getBot(larkAppId).config.substituteMode?.directBotMention === true;
  if (activeSessions) {
    const iterable = activeSessions instanceof Map ? activeSessions.values() : activeSessions;
    const candidates = [...iterable]
      .filter(ds => ds.larkAppId === larkAppId && ds.chatType !== 'p2p' && ds.session.status === 'active' && !ds.session.adoptedFrom && isEchoDirectSession(ds))
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
    const chatInfos = new Map<string, { name: string | null }>();
    for (const chatId of [...new Set(candidates.map(ds => ds.chatId))]) {
      const info = await getChatNameAndMode(larkAppId, chatId).catch(() => ({ name: null }));
      chatInfos.set(chatId, info);
    }
    const rows: DirectChatRow[] = [];
    for (const ds of candidates) {
      const scope = ds.scope === 'chat' ? 'chat' : 'thread';
      const anchor = sessionAnchorId(ds);
      const targetKey = substituteDirectTargetKey(scope, anchor, ds.chatId);
      if (!targetKey) continue;
      const stored = binding?.chats[targetKey] ?? (scope === 'chat' ? binding?.chats[ds.chatId] : undefined);
      const chatName = chatInfos.get(ds.chatId)?.name ?? ds.session.chatDisplayName ?? ds.chatId;
      const sessionTitle = ds.session.title || ds.currentTurnTitle || ds.session.sessionId;
      rows.push({
        targetKey,
        scope,
        anchor,
        chatId: ds.chatId,
        name: chatName,
        title: directChatDisplayTitle(chatName, ds.chatId, sessionTitle),
        sessionId: ds.session.sessionId,
        enabled: stored?.enabled !== false && stored?.mode === 'direct',
        active: binding?.activeChatId === targetKey || (scope === 'chat' && binding?.activeChatId === ds.chatId),
        mode: stored?.mode,
        substituteEnabled: isSubstituteEnabledForChat(larkAppId, ds.chatId),
        directBotMention: stored?.directBotMention ?? defaultDirectBotMention,
        directBotMentionConfigured: stored?.directBotMention !== undefined,
        canManageDirect: canManageDirectSession(larkAppId, openId),
        canOperateChat: canOperate(larkAppId, ds.chatId, openId),
        canLeaveGroup: scope === 'chat' && canOperate(larkAppId, undefined, openId),
      });
    }
    const chatScopeKeys = new Set(rows.filter(r => r.scope === 'chat').map(r => r.targetKey));
    const chats = await listChats(larkAppId);
    for (const c of chats) {
      if (!c.chatId) continue;
      const chatMode = await getChatMode(larkAppId, c.chatId);
      if (chatMode !== 'group' && chatMode !== 'topic') continue;
      const targetKey = substituteDirectTargetKey('chat', c.chatId, c.chatId) ?? c.chatId;
      if (chatScopeKeys.has(targetKey)) continue;
      const stored = binding?.chats[targetKey] ?? binding?.chats[c.chatId];
      const name = c.name || c.chatId;
      rows.push({
        targetKey,
        scope: 'chat',
        anchor: c.chatId,
        chatId: c.chatId,
        name,
        title: `${name} ${t('cmd.substitute.direct_no_session', undefined, localeForBot(larkAppId))}`,
        enabled: stored?.enabled !== false && stored?.mode === 'direct',
        active: binding?.activeChatId === targetKey || binding?.activeChatId === c.chatId,
        mode: stored?.mode,
        substituteEnabled: isSubstituteEnabledForChat(larkAppId, c.chatId),
        directBotMention: stored?.directBotMention ?? defaultDirectBotMention,
        directBotMentionConfigured: stored?.directBotMention !== undefined,
        canManageDirect: canManageDirectSession(larkAppId, openId),
        canOperateChat: canOperate(larkAppId, c.chatId, openId),
        canLeaveGroup: canOperate(larkAppId, undefined, openId),
      });
    }
    rows.sort((a, b) => String(a.title ?? a.name ?? a.chatId).localeCompare(String(b.title ?? b.name ?? b.chatId)));
    return rows;
  }
  const chats = await listChats(larkAppId);
  const rows: DirectChatRow[] = [];
  for (const c of chats) {
    if (!c.chatId) continue;
    const chatMode = await getChatMode(larkAppId, c.chatId);
    if (chatMode !== 'group' && chatMode !== 'topic') continue;
    const targetKey = substituteDirectTargetKey('chat', c.chatId, c.chatId) ?? c.chatId;
    const stored = binding?.chats[targetKey] ?? binding?.chats[c.chatId];
    rows.push({
      targetKey,
      scope: 'chat',
      anchor: c.chatId,
      chatId: c.chatId,
      name: c.name,
      enabled: stored?.enabled !== false && stored?.mode === 'direct',
      active: binding?.activeChatId === targetKey || binding?.activeChatId === c.chatId,
      mode: stored?.mode,
      substituteEnabled: isSubstituteEnabledForChat(larkAppId, c.chatId),
      directBotMention: stored?.directBotMention ?? defaultDirectBotMention,
      directBotMentionConfigured: stored?.directBotMention !== undefined,
      canManageDirect: canManageDirectSession(larkAppId, openId),
      canOperateChat: canOperate(larkAppId, c.chatId, openId),
      canLeaveGroup: canOperate(larkAppId, undefined, openId),
    });
  }
  return rows;
}

function directChatStateText(r: DirectChatRow, loc: any): string {
  return r.enabled
    ? (r.active ? t('cmd.substitute.direct_state_active', undefined, loc) : t('cmd.substitute.direct_state_on', undefined, loc))
    : t('cmd.substitute.direct_state_off', undefined, loc);
}

function directChatListStateText(r: DirectChatRow, loc: any, p2pThreadMode: boolean): string {
  if (!r.enabled) return t('cmd.substitute.direct_state_off', undefined, loc);
  if (p2pThreadMode) return t('cmd.substitute.direct_state_on', undefined, loc);
  return r.active ? t('cmd.substitute.direct_state_active', undefined, loc) : t('cmd.substitute.direct_state_on', undefined, loc);
}

function directChatSubstituteStateText(r: DirectChatRow, loc: any): string {
  return r.substituteEnabled ? t('cmd.substitute.direct_substitute_on', undefined, loc) : t('cmd.substitute.direct_substitute_off', undefined, loc);
}

function directChatBotMentionStateText(r: DirectChatRow, loc: any): string {
  return r.directBotMention
    ? t(r.directBotMentionConfigured ? 'cmd.substitute.direct_bot_mention_on' : 'cmd.substitute.direct_bot_mention_on_default', undefined, loc)
    : t(r.directBotMentionConfigured ? 'cmd.substitute.direct_bot_mention_off' : 'cmd.substitute.direct_bot_mention_off_default', undefined, loc);
}

function directChatCardValue(invokerOpenId: string, page: number, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    invoker_open_id: invokerOpenId,
    page: String(page),
    ...extra,
  };
}

function buildDirectChatListCardElements(
  larkAppId: string,
  rows: DirectChatRow[],
  invokerOpenId: string,
  loc: any,
  state: DirectCardState,
): any[] {
  const elements: any[] = [];
  const brand = normalizeBrand(getBot(larkAppId).config.brand);
  if (rows.length === 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: t('cmd.substitute.direct_list_empty', undefined, loc) } });
    return elements;
  }

  const requestedPage = Number.isFinite(state.page) ? Math.max(1, Math.floor(state.page!)) : 1;
  const totalPages = Math.max(1, Math.ceil(rows.length / DIRECT_CHAT_PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * DIRECT_CHAT_PAGE_SIZE;
  const visible = rows.slice(start, start + DIRECT_CHAT_PAGE_SIZE);

  elements.push({ tag: 'div', text: { tag: 'lark_md', content: t('cmd.substitute.direct_list_header', undefined, loc) } });
  for (const r of visible) {
    const label = r.title || r.name || r.chatId;
    const targetLabel = r.scope === 'thread' ? `thread:${r.anchor}` : r.chatId;
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${label}**\n${t('cmd.substitute.direct_field_mode', undefined, loc)}：${directChatListStateText(r, loc, state.p2pThreadMode === true)}\n${t('cmd.substitute.direct_field_substitute', undefined, loc)}：${directChatSubstituteStateText(r, loc)}\n${t('cmd.substitute.direct_field_bot_mention', undefined, loc)}：${directChatBotMentionStateText(r, loc)}\n${targetLabel}`,
      },
    });
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t('cmd.substitute.direct_btn_manage', undefined, loc) },
          type: 'default',
          value: directChatCardValue(invokerOpenId, page, {
            action: 'substitute_direct_manage',
            target_key: r.targetKey,
            chat_id: r.chatId,
          }),
        },
        ...(r.scope === 'chat' ? [{
          tag: 'button',
          text: { tag: 'plain_text', content: t('cmd.substitute.direct_btn_open_chat', undefined, loc) },
          type: 'default',
          multi_url: directMultiUrl(chatAppLink(r.chatId, brand)),
        }] : []),
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t('cmd.substitute.direct_btn_leave_group', undefined, loc) },
          type: 'danger',
          disabled: !r.canLeaveGroup || r.scope !== 'chat',
          confirm: {
            title: { tag: 'plain_text', content: t('cmd.substitute.direct_leave_group_confirm_title', undefined, loc) },
            text: { tag: 'plain_text', content: t('cmd.substitute.direct_leave_group_confirm_text', { chat: label }, loc) },
          },
          value: directChatCardValue(invokerOpenId, page, {
            action: 'substitute_direct_leave_group',
            target_key: r.targetKey,
            chat_id: r.chatId,
          }),
        },
      ],
    });
  }

  if (totalPages > 1) {
    const actions: any[] = [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t('cmd.substitute.direct_btn_prev_page', undefined, loc) },
        type: 'default',
        disabled: page <= 1,
        value: directChatCardValue(invokerOpenId, Math.max(1, page - 1), { action: 'substitute_direct_page' }),
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t('cmd.substitute.direct_btn_next_page', undefined, loc) },
        type: 'default',
        disabled: page >= totalPages,
        value: directChatCardValue(invokerOpenId, Math.min(totalPages, page + 1), { action: 'substitute_direct_page' }),
      },
    ];
    if (totalPages > 2 && totalPages <= DIRECT_CHAT_JUMP_PAGE_MAX_OPTIONS) {
      actions.push({
        tag: 'select_static',
        placeholder: {
          tag: 'plain_text',
          content: t('cmd.substitute.direct_jump_page', { n: String(page), total: String(totalPages) }, loc),
        },
        initial_option: String(page),
        options: Array.from({ length: totalPages }, (_, i) => {
          const n = i + 1;
          return {
            text: { tag: 'plain_text', content: t('cmd.substitute.direct_jump_page', { n: String(n), total: String(totalPages) }, loc) },
            value: String(n),
          };
        }),
        value: directChatCardValue(invokerOpenId, page, { action: 'substitute_direct_page' }),
      });
    }
    elements.push({
      tag: 'action',
      actions,
    });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: t('cmd.substitute.direct_page_indicator', { current: String(page), total: String(totalPages) }, loc) },
    });
  }
  return elements;
}

function buildDirectChatDetailCardElements(
  larkAppId: string,
  row: DirectChatRow,
  invokerOpenId: string,
  loc: any,
  page: number,
): any[] {
  const brand = normalizeBrand(getBot(larkAppId).config.brand);
  const label = row.title || row.name || row.chatId;
  const targetLabel = row.scope === 'thread' ? `thread:${row.anchor}` : row.chatId;
  const elements: any[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${label}**\n${t('cmd.substitute.direct_field_mode', undefined, loc)}：${directChatStateText(row, loc)}\n${t('cmd.substitute.direct_field_substitute', undefined, loc)}：${directChatSubstituteStateText(row, loc)}\n${t('cmd.substitute.direct_field_bot_mention', undefined, loc)}：${directChatBotMentionStateText(row, loc)}\n${targetLabel}`,
      },
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: t(row.enabled && row.mode === 'direct' ? 'cmd.substitute.direct_btn_exit' : 'cmd.substitute.direct_btn_enter', undefined, loc),
          },
          type: row.enabled && row.mode === 'direct' ? 'default' : 'primary',
          value: directChatCardValue(invokerOpenId, page, {
            action: row.enabled && row.mode === 'direct' ? 'substitute_direct_exit' : 'substitute_direct_enter',
            target_key: row.targetKey,
            chat_id: row.chatId,
            detail_target_key: row.targetKey,
          }),
        },
      ],
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t(row.directBotMention ? 'cmd.substitute.direct_btn_disable_bot_mention' : 'cmd.substitute.direct_btn_enable_bot_mention', undefined, loc) },
          type: row.directBotMention ? 'default' : 'primary',
          disabled: !row.canManageDirect,
          value: directChatCardValue(invokerOpenId, page, {
            action: row.directBotMention ? 'substitute_direct_bot_mention_disable' : 'substitute_direct_bot_mention_enable',
            target_key: row.targetKey,
            chat_id: row.chatId,
            detail_target_key: row.targetKey,
          }),
        },
      ],
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t(row.substituteEnabled ? 'cmd.substitute.direct_btn_disable_substitute' : 'cmd.substitute.direct_btn_enable_substitute', undefined, loc) },
          type: row.substituteEnabled ? 'default' : 'primary',
          disabled: !row.canOperateChat,
          value: directChatCardValue(invokerOpenId, page, {
            action: row.substituteEnabled ? 'substitute_direct_disable' : 'substitute_direct_enable',
            target_key: row.targetKey,
            chat_id: row.chatId,
            detail_target_key: row.targetKey,
          }),
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t('cmd.substitute.direct_btn_leave_group', undefined, loc) },
          type: 'danger',
          disabled: !row.canLeaveGroup || row.scope !== 'chat',
          confirm: {
            title: { tag: 'plain_text', content: t('cmd.substitute.direct_leave_group_confirm_title', undefined, loc) },
            text: { tag: 'plain_text', content: t('cmd.substitute.direct_leave_group_confirm_text', { chat: label }, loc) },
          },
          value: directChatCardValue(invokerOpenId, page, {
            action: 'substitute_direct_leave_group',
            target_key: row.targetKey,
            chat_id: row.chatId,
          }),
        },
      ],
    },
    {
      tag: 'action',
      actions: [
        ...(row.scope === 'chat' ? [{
          tag: 'button',
          text: { tag: 'plain_text', content: t('cmd.substitute.direct_btn_open_chat', undefined, loc) },
          type: 'default',
          multi_url: directMultiUrl(chatAppLink(row.chatId, brand)),
        }] : []),
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t('cmd.substitute.direct_btn_back', undefined, loc) },
          type: 'default',
          value: directChatCardValue(invokerOpenId, page, { action: 'substitute_direct_back' }),
        },
      ],
    },
  ];
  if (!row.canManageDirect || !row.canOperateChat || !row.canLeaveGroup) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `<font color='grey'>${t('cmd.substitute.direct_permission_hint', undefined, loc)}</font>` },
    });
  }
  return elements;
}

function buildDirectChatCard(larkAppId: string, rows: DirectChatRow[], invokerOpenId: string, loc: any, state: DirectCardState = {}): string {
  const requestedPage = Number.isFinite(state.page) ? Math.max(1, Math.floor(state.page!)) : 1;
  const detailRow = state.detailTargetKey ? rows.find(r => r.targetKey === state.detailTargetKey) : undefined;
  const p2pThreadMode = state.p2pThreadMode ?? isP2pThreadMode(larkAppId);
  const elements = detailRow
    ? buildDirectChatDetailCardElements(larkAppId, detailRow, invokerOpenId, loc, requestedPage)
    : buildDirectChatListCardElements(larkAppId, rows, invokerOpenId, loc, { ...state, p2pThreadMode });
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t(detailRow ? 'cmd.substitute.direct_card_detail_title' : 'cmd.substitute.direct_card_title', undefined, loc) },
      template: detailRow ? 'turquoise' : 'blue',
    },
    elements,
  });
}

async function applyDirectAction(
  larkAppId: string,
  openId: string | undefined,
  targetKey: string | undefined,
  action: string,
  loc: any,
  activeSessions?: Iterable<DaemonSession> | Map<string, DaemonSession>,
  closeSession?: (sessionId: string) => Promise<unknown>,
): Promise<{ ok: boolean; message: string }> {
  if (!canUseDirectControls(larkAppId, openId)) return { ok: false, message: t('cmd.substitute.direct_forbidden', undefined, loc) };
  if (!openId || !targetKey) return { ok: false, message: t('cmd.substitute.direct_bad_chat', undefined, loc) };
  if (action === 'substitute_direct_leave_group' && !canOperate(larkAppId, undefined, openId)) {
    return { ok: false, message: t('cmd.substitute.owner_only', undefined, loc) };
  }
  const rows = await listSubstituteDirectChats(larkAppId, openId, activeSessions);
  const row = rows.find(r => r.targetKey === targetKey) ?? rows.find(r => r.chatId === targetKey);
  if (!row) return { ok: false, message: t('cmd.substitute.direct_bad_chat', undefined, loc) };
  if (action === 'substitute_direct_enter') {
    const target = substituteTargetForDirectAction(larkAppId, openId);
    if (!target?.openId) return { ok: false, message: t('substitute.direct.no_open_id', undefined, loc) };
    const threadMode = isP2pThreadMode(larkAppId);
    const dmRootMessageId = threadMode
      ? await sendUserMessage(larkAppId, openId, t('cmd.substitute.direct_thread_started', { chat: row.name || row.chatId }, loc), 'text')
      : undefined;
    upsertSubstituteDirectChat({
      larkAppId,
      substituteOpenId: target.openId,
      targetOpenId: target.openId,
      substituteUserId: target.userId,
      substituteUnionId: target.unionId,
      chatId: row.chatId,
      targetKey: row.targetKey,
      scope: row.scope,
      anchor: row.anchor,
      title: row.title,
      sessionId: row.sessionId,
      chatType: 'group',
      chatName: row.name,
      targetName: target.name,
      mode: 'direct',
      disclosure: getBot(larkAppId).config.substituteMode?.disclosure,
      dmRootMessageId,
      dmThreadId: dmRootMessageId?.startsWith('omt_') ? dmRootMessageId : undefined,
      resetDmHistory: threadMode,
      directBotMention: row.directBotMentionConfigured ? undefined : getBot(larkAppId).config.substituteMode?.directBotMention === true,
      preserveExistingChats: threadMode,
    });
    return { ok: true, message: t('cmd.substitute.direct_enter_ok', { chat: row.name || row.chatId }, loc) };
  }
  if (action === 'substitute_direct_enable' || action === 'substitute_direct_disable') {
    if (!canOperate(larkAppId, row.chatId, openId)) return { ok: false, message: t('cmd.substitute.owner_only', undefined, loc) };
    const enabled = action === 'substitute_direct_enable';
    setSubstituteEnabledForChat(larkAppId, row.chatId, enabled);
    return { ok: true, message: t(enabled ? 'cmd.substitute.updated_on' : 'cmd.substitute.updated_off', undefined, loc) };
  }
  if (action === 'substitute_direct_bot_mention_enable' || action === 'substitute_direct_bot_mention_disable') {
    if (!canManageDirectSession(larkAppId, openId)) return { ok: false, message: t('cmd.substitute.owner_only', undefined, loc) };
    const enabled = action === 'substitute_direct_bot_mention_enable';
    const target = substituteTargetForDirectAction(larkAppId, openId);
    const ok = setSubstituteDirectChatBotMention({
      larkAppId,
      substituteOpenId: substituteBindingOpenIdForControls(larkAppId, openId),
      targetKeyOrChatId: row.targetKey,
      enabled,
      targetOpenId: target?.openId,
      substituteUserId: target?.userId,
      substituteUnionId: target?.unionId,
      chatId: row.chatId,
      scope: row.scope,
      anchor: row.anchor,
      title: row.title,
      sessionId: row.sessionId,
      chatName: row.name,
      targetName: target?.name,
      disclosure: getBot(larkAppId).config.substituteMode?.disclosure,
    });
    return {
      ok,
      message: ok
        ? t(enabled ? 'cmd.substitute.direct_bot_mention_updated_on' : 'cmd.substitute.direct_bot_mention_updated_off', undefined, loc)
        : t('cmd.substitute.direct_bad_chat', undefined, loc),
    };
  }
  if (action === 'substitute_direct_exit') {
    const { deactivateSubstituteDirectChat } = await import('../../services/substitute-direct-store.js');
    const existed = deactivateSubstituteDirectChat(larkAppId, substituteBindingOpenIdForControls(larkAppId, openId), row.targetKey);
    return { ok: existed, message: existed ? t('cmd.substitute.direct_exit_ok', { chat: row.name || row.chatId }, loc) : t('cmd.substitute.direct_exit_none', undefined, loc) };
  }
  if (action === 'substitute_direct_leave_group') {
    if (row.scope !== 'chat') return { ok: false, message: t('cmd.substitute.owner_only', undefined, loc) };
    const left = await leaveChat(larkAppId, row.chatId);
    if (!left.ok) return { ok: false, message: t('cmd.substitute.direct_leave_group_failed', { reason: left.error }, loc) };
    if (activeSessions) {
      const sessionsToClose = [...(activeSessions instanceof Map ? activeSessions.values() : activeSessions)]
        .filter(ds => ds.larkAppId === larkAppId && ds.chatId === row.chatId && ds.session.status !== 'closed')
        .map(ds => ds.session.sessionId);
      for (const sessionId of sessionsToClose) {
        if (closeSession) await closeSession(sessionId);
      }
    }
    clearSubstituteDirectChatsByGroup(larkAppId, substituteBindingOpenIdForControls(larkAppId, openId), row.chatId)
      || clearSubstituteDirectChat(larkAppId, substituteBindingOpenIdForControls(larkAppId, openId), row.targetKey);
    return { ok: true, message: t('cmd.substitute.direct_leave_group_ok', { chat: row.name || row.chatId }, loc) };
  }
  return { ok: false, message: t('cmd.substitute.direct_bad_chat', undefined, loc) };
}

export async function handleSubstituteDirectCardAction(input: {
  larkAppId: string;
  operatorOpenId: string | undefined;
  action: string;
  chatId: string | undefined;
  invokerOpenId: string | undefined;
  page?: number;
  detailTargetKey?: string;
  activeSessions?: Iterable<DaemonSession> | Map<string, DaemonSession>;
  closeSession?: (sessionId: string) => Promise<unknown>;
}): Promise<any> {
  const loc = localeForBot(input.larkAppId);
  logger.info(
    `[echo-direct:${input.larkAppId}] card action=${input.action} ` +
    `operator=${input.operatorOpenId?.substring(0, 12) ?? '-'} ` +
    `invoker=${input.invokerOpenId?.substring(0, 12) ?? '-'} ` +
    `chat=${input.chatId?.substring(0, 12) ?? '-'} ` +
    `target=${input.detailTargetKey ?? '-'}`,
  );
  if (!input.operatorOpenId || input.operatorOpenId !== input.invokerOpenId) {
    return { toast: { type: 'error', content: t('cmd.substitute.direct_not_invoker', undefined, loc) } };
  }
  const rawPage = Number(input.page ?? 1);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  if (input.action === 'substitute_direct_page' || input.action === 'substitute_direct_back' || input.action === 'substitute_direct_manage') {
    const rows = await listSubstituteDirectChats(input.larkAppId, input.operatorOpenId, input.activeSessions);
    const detailTargetKey = input.action === 'substitute_direct_manage'
      ? (input.detailTargetKey ?? (input.chatId ? substituteDirectTargetKey('chat', input.chatId, input.chatId) : undefined))
      : undefined;
    return {
      card: { type: 'raw', data: JSON.parse(buildDirectChatCard(input.larkAppId, rows, input.operatorOpenId, loc, { page, detailTargetKey })) },
    };
  }
  const targetKey = input.detailTargetKey || (input.chatId ? substituteDirectTargetKey('chat', input.chatId, input.chatId) : undefined);
  const result = await applyDirectAction(input.larkAppId, input.operatorOpenId, targetKey, input.action, loc, input.activeSessions, input.closeSession);
  const rows = await listSubstituteDirectChats(input.larkAppId, input.operatorOpenId, input.activeSessions);
  const detailTargetKey = result.ok && input.action === 'substitute_direct_leave_group'
    ? undefined
    : input.detailTargetKey;
  return {
    toast: { type: result.ok ? 'success' : 'error', content: result.message },
    card: { type: 'raw', data: JSON.parse(buildDirectChatCard(input.larkAppId, rows, input.operatorOpenId, loc, { page, detailTargetKey })) },
  };
}

export async function tryHandleEchoCommand(
  larkAppId: string,
  message: any,
  senderOpenId: string | undefined,
  activeSessions?: Iterable<DaemonSession> | Map<string, DaemonSession>,
): Promise<boolean> {
  const rawText = extractMessageTextForRouting(message);
  if (!rawText) return false;
  const text = stripLeadingMentions(rawText.trim(), message?.mentions ?? []);
  const match = /^\/echo(?:\s+(.+))?\s*$/i.exec(text);
  if (!match) return false;

  const isP2p = message.chat_type === 'p2p';
  const messageId: string | undefined = message.message_id;
  const loc = localeForBot(larkAppId);
  const reply = (content: string) => messageId
    ? replyMessage(larkAppId, messageId, content, 'text', false)
        .catch(err => logger.warn(`[echo] reply failed: ${err?.message ?? err}`))
    : Promise.resolve();

  if (!isP2p || match[1]?.trim()) {
    await reply(t('cmd.echo.usage', undefined, loc));
    return true;
  }
  if (!senderOpenId) return true;
  if (!canUseDirectControls(larkAppId, senderOpenId)) {
    await reply(t('cmd.substitute.direct_forbidden', undefined, loc));
    return true;
  }
  await (messageId
    ? replyMessage(larkAppId, messageId, buildDirectChatCard(larkAppId, await listSubstituteDirectChats(larkAppId, senderOpenId, activeSessions), senderOpenId, loc), 'interactive', false)
        .catch(err => logger.warn(`[echo] reply failed: ${err?.message ?? err}`))
    : Promise.resolve());
  return true;
}
