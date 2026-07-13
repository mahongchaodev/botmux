import { canOperate, canTalk, extractMessageTextForRouting, isBotMentioned } from './event-dispatcher.js';
import { stripLeadingMentions } from './message-parser.js';
import { getChatMode, replyMessage } from './client.js';
import { isSubstituteEnabledForChat, setSubstituteEnabledForChat } from '../../services/substitute-chat-toggle-store.js';
import {
  clearSubstituteDirectChat,
  getSubstituteDirectBinding,
  getSubstituteDirectChat,
  upsertSubstituteDirectChat,
} from '../../services/substitute-direct-store.js';
import { getBot } from '../../bot-registry.js';
import { leaveChat, listChats } from '../../services/groups-store.js';
import { chatAppLink, normalizeBrand } from './lark-hosts.js';
import { directMultiUrl } from './card-builder.js';
import { localeForBot, t } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';

const DIRECT_ACTIONS = new Set([
  'substitute_direct_page',
  'substitute_direct_manage',
  'substitute_direct_back',
  'substitute_direct_enter',
  'substitute_direct_exit',
  'substitute_direct_intervene',
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
  return openId;
}

function canUseDirectControls(larkAppId: string, openId: string | undefined): boolean {
  if (!openId) return false;
  return canOperate(larkAppId, undefined, openId) || !!substituteTargetForOpenId(larkAppId, openId);
}

const DIRECT_CHAT_PAGE_SIZE = 5;
const DIRECT_CHAT_JUMP_PAGE_MAX_OPTIONS = 50;

type DirectChatRow = {
  chatId: string;
  name?: string;
  enabled: boolean;
  active: boolean;
  mode?: 'direct' | 'intervene';
  substituteEnabled: boolean;
  canOperateChat: boolean;
  canLeaveGroup: boolean;
};

type DirectCardState = {
  page?: number;
  detailChatId?: string;
};

async function listSubstituteDirectChats(larkAppId: string, openId: string | undefined): Promise<DirectChatRow[]> {
  if (!canUseDirectControls(larkAppId, openId)) return [];
  const bindingOpenId = substituteBindingOpenIdForControls(larkAppId, openId);
  const binding = getSubstituteDirectBinding(larkAppId, bindingOpenId);
  const chats = await listChats(larkAppId);
  const rows: DirectChatRow[] = [];
  for (const c of chats) {
    if (!c.chatId) continue;
    if (await getChatMode(larkAppId, c.chatId) !== 'group') continue;
    rows.push({
      chatId: c.chatId,
      name: c.name,
      enabled: !!binding?.chats[c.chatId],
      active: binding?.activeChatId === c.chatId,
      mode: binding?.chats[c.chatId]?.mode,
      substituteEnabled: isSubstituteEnabledForChat(larkAppId, c.chatId),
      canOperateChat: canOperate(larkAppId, c.chatId, openId),
      canLeaveGroup: canOperate(larkAppId, undefined, openId),
    });
  }
  return rows;
}

function renderDirectChatList(rows: DirectChatRow[], loc: any): string {
  if (rows.length === 0) return t('cmd.substitute.direct_list_empty', undefined, loc);
  return [
    t('cmd.substitute.direct_list_header', undefined, loc),
    ...rows.map((r, idx) => {
      const state = r.enabled
        ? r.mode === 'intervene'
          ? (r.active ? t('cmd.substitute.intervene_state_active', undefined, loc) : t('cmd.substitute.intervene_state_on', undefined, loc))
          : (r.active ? t('cmd.substitute.direct_state_active', undefined, loc) : t('cmd.substitute.direct_state_on', undefined, loc))
        : t('cmd.substitute.direct_state_off', undefined, loc);
      const sub = r.substituteEnabled ? t('cmd.substitute.direct_substitute_on', undefined, loc) : t('cmd.substitute.direct_substitute_off', undefined, loc);
      return `${idx + 1}. ${r.name || r.chatId} (${r.chatId}) - ${state} / ${sub}`;
    }),
    '',
    t('cmd.substitute.direct_list_usage', undefined, loc),
  ].join('\n');
}

function directChatStateText(r: DirectChatRow, loc: any): string {
  return r.enabled
    ? r.mode === 'intervene'
      ? (r.active ? t('cmd.substitute.intervene_state_active', undefined, loc) : t('cmd.substitute.intervene_state_on', undefined, loc))
      : (r.active ? t('cmd.substitute.direct_state_active', undefined, loc) : t('cmd.substitute.direct_state_on', undefined, loc))
    : t('cmd.substitute.direct_state_off', undefined, loc);
}

function directChatSubstituteStateText(r: DirectChatRow, loc: any): string {
  return r.substituteEnabled ? t('cmd.substitute.direct_substitute_on', undefined, loc) : t('cmd.substitute.direct_substitute_off', undefined, loc);
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
    const label = r.name || r.chatId;
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${label}**\n${t('cmd.substitute.direct_field_mode', undefined, loc)}：${directChatStateText(r, loc)}\n${t('cmd.substitute.direct_field_substitute', undefined, loc)}：${directChatSubstituteStateText(r, loc)}\n${r.chatId}`,
      },
    });
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: t('cmd.substitute.direct_btn_manage', undefined, loc) },
        type: 'default',
        value: directChatCardValue(invokerOpenId, page, {
          action: 'substitute_direct_manage',
          chat_id: r.chatId,
        }),
      }],
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
  const label = row.name || row.chatId;
  const elements: any[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${label}**\n${t('cmd.substitute.direct_field_mode', undefined, loc)}：${directChatStateText(row, loc)}\n${t('cmd.substitute.direct_field_substitute', undefined, loc)}：${directChatSubstituteStateText(row, loc)}\n${row.chatId}`,
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
            chat_id: row.chatId,
            detail_chat_id: row.chatId,
          }),
        },
        {
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: t(row.enabled && row.mode === 'intervene' ? 'cmd.substitute.direct_btn_exit_intervene' : 'cmd.substitute.direct_btn_intervene', undefined, loc),
          },
          type: row.enabled && row.mode === 'intervene' ? 'default' : 'primary',
          value: directChatCardValue(invokerOpenId, page, {
            action: row.enabled && row.mode === 'intervene' ? 'substitute_direct_exit' : 'substitute_direct_intervene',
            chat_id: row.chatId,
            detail_chat_id: row.chatId,
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
            chat_id: row.chatId,
            detail_chat_id: row.chatId,
          }),
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t('cmd.substitute.direct_btn_leave_group', undefined, loc) },
          type: 'danger',
          disabled: !row.canLeaveGroup,
          confirm: {
            title: { tag: 'plain_text', content: t('cmd.substitute.direct_leave_group_confirm_title', undefined, loc) },
            text: { tag: 'plain_text', content: t('cmd.substitute.direct_leave_group_confirm_text', { chat: label }, loc) },
          },
          value: directChatCardValue(invokerOpenId, page, {
            action: 'substitute_direct_leave_group',
            chat_id: row.chatId,
          }),
        },
      ],
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t('cmd.substitute.direct_btn_open_chat', undefined, loc) },
          type: 'default',
          multi_url: directMultiUrl(chatAppLink(row.chatId, brand)),
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t('cmd.substitute.direct_btn_back', undefined, loc) },
          type: 'default',
          value: directChatCardValue(invokerOpenId, page, { action: 'substitute_direct_back' }),
        },
      ],
    },
  ];
  if (!row.canOperateChat || !row.canLeaveGroup) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `<font color='grey'>${t('cmd.substitute.direct_permission_hint', undefined, loc)}</font>` },
    });
  }
  return elements;
}

function buildDirectChatCard(larkAppId: string, rows: DirectChatRow[], invokerOpenId: string, loc: any, state: DirectCardState = {}): string {
  const requestedPage = Number.isFinite(state.page) ? Math.max(1, Math.floor(state.page!)) : 1;
  const detailRow = state.detailChatId ? rows.find(r => r.chatId === state.detailChatId) : undefined;
  const elements = detailRow
    ? buildDirectChatDetailCardElements(larkAppId, detailRow, invokerOpenId, loc, requestedPage)
    : buildDirectChatListCardElements(larkAppId, rows, invokerOpenId, loc, state);
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t(detailRow ? 'cmd.substitute.direct_card_detail_title' : 'cmd.substitute.direct_card_title', undefined, loc) },
      template: detailRow ? 'turquoise' : 'blue',
    },
    elements,
  });
}

async function applyDirectAction(larkAppId: string, openId: string | undefined, chatId: string | undefined, action: string, loc: any): Promise<{ ok: boolean; message: string }> {
  if (!canUseDirectControls(larkAppId, openId)) return { ok: false, message: t('cmd.substitute.direct_forbidden', undefined, loc) };
  if (!openId || !chatId) return { ok: false, message: t('cmd.substitute.direct_bad_chat', undefined, loc) };
  if (action === 'substitute_direct_leave_group' && !canOperate(larkAppId, undefined, openId)) {
    return { ok: false, message: t('cmd.substitute.owner_only', undefined, loc) };
  }
  const rows = await listSubstituteDirectChats(larkAppId, openId);
  const row = rows.find(r => r.chatId === chatId);
  if (!row) return { ok: false, message: t('cmd.substitute.direct_bad_chat', undefined, loc) };
  if (action === 'substitute_direct_enter') {
    const target = substituteTargetForDirectAction(larkAppId, openId);
    if (!target?.openId) return { ok: false, message: t('substitute.direct.no_open_id', undefined, loc) };
    upsertSubstituteDirectChat({
      larkAppId,
      substituteOpenId: openId,
      targetOpenId: target.openId,
      substituteUserId: target.userId,
      substituteUnionId: target.unionId,
      chatId: row.chatId,
      chatName: row.name,
      targetName: target.name,
      mode: 'direct',
      disclosure: getBot(larkAppId).config.substituteMode?.disclosure,
    });
    return { ok: true, message: t('cmd.substitute.direct_enter_ok', { chat: row.name || row.chatId }, loc) };
  }
  if (action === 'substitute_direct_intervene') {
    const target = substituteTargetForDirectAction(larkAppId, openId);
    if (!target?.openId) return { ok: false, message: t('substitute.direct.no_open_id', undefined, loc) };
    upsertSubstituteDirectChat({
      larkAppId,
      substituteOpenId: openId,
      targetOpenId: target.openId,
      substituteUserId: target.userId,
      substituteUnionId: target.unionId,
      chatId: row.chatId,
      chatName: row.name,
      targetName: target.name,
      mode: 'intervene',
      disclosure: getBot(larkAppId).config.substituteMode?.disclosure,
    });
    return { ok: true, message: t('cmd.substitute.intervene_enter_ok', { chat: row.name || row.chatId }, loc) };
  }
  if (action === 'substitute_direct_enable' || action === 'substitute_direct_disable') {
    if (!canOperate(larkAppId, row.chatId, openId)) return { ok: false, message: t('cmd.substitute.owner_only', undefined, loc) };
    const enabled = action === 'substitute_direct_enable';
    setSubstituteEnabledForChat(larkAppId, row.chatId, enabled);
    return { ok: true, message: t(enabled ? 'cmd.substitute.updated_on' : 'cmd.substitute.updated_off', undefined, loc) };
  }
  if (action === 'substitute_direct_exit') {
    const existed = clearSubstituteDirectChat(larkAppId, substituteBindingOpenIdForControls(larkAppId, openId), row.chatId);
    return { ok: existed, message: existed ? t('cmd.substitute.direct_exit_ok', { chat: row.name || row.chatId }, loc) : t('cmd.substitute.direct_exit_none', undefined, loc) };
  }
  if (action === 'substitute_direct_leave_group') {
    const left = await leaveChat(larkAppId, row.chatId);
    if (!left.ok) return { ok: false, message: t('cmd.substitute.direct_leave_group_failed', { reason: left.error }, loc) };
    clearSubstituteDirectChat(larkAppId, substituteBindingOpenIdForControls(larkAppId, openId), row.chatId);
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
  detailChatId?: string;
}): Promise<any> {
  const loc = localeForBot(input.larkAppId);
  if (!input.operatorOpenId || input.operatorOpenId !== input.invokerOpenId) {
    return { toast: { type: 'error', content: t('cmd.substitute.direct_not_invoker', undefined, loc) } };
  }
  const rawPage = Number(input.page ?? 1);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  if (input.action === 'substitute_direct_page' || input.action === 'substitute_direct_back' || input.action === 'substitute_direct_manage') {
    const rows = await listSubstituteDirectChats(input.larkAppId, input.operatorOpenId);
    const detailChatId = input.action === 'substitute_direct_manage' ? input.chatId : undefined;
    return {
      card: { type: 'raw', data: JSON.parse(buildDirectChatCard(input.larkAppId, rows, input.operatorOpenId, loc, { page, detailChatId })) },
    };
  }
  const result = await applyDirectAction(input.larkAppId, input.operatorOpenId, input.chatId, input.action, loc);
  const rows = await listSubstituteDirectChats(input.larkAppId, input.operatorOpenId);
  const detailChatId = result.ok && input.action === 'substitute_direct_leave_group'
    ? undefined
    : input.detailChatId;
  return {
    toast: { type: result.ok ? 'success' : 'error', content: result.message },
    card: { type: 'raw', data: JSON.parse(buildDirectChatCard(input.larkAppId, rows, input.operatorOpenId, loc, { page, detailChatId })) },
  };
}

export async function tryHandleSubstituteCommand(
  larkAppId: string,
  message: any,
  senderOpenId: string | undefined,
): Promise<boolean> {
  const rawText = extractMessageTextForRouting(message);
  if (!rawText) return false;
  const text = stripLeadingMentions(rawText.trim(), message?.mentions ?? []);
  const match = /^\/substitute(?:\s+(.+))?\s*$/i.exec(text);
  if (!match) return false;

  const isP2p = message.chat_type === 'p2p';
  if (!isP2p && !isBotMentioned(larkAppId, message, senderOpenId)) return true;

  const chatId: string | undefined = message.chat_id;
  const messageId: string | undefined = message.message_id;
  const loc = localeForBot(larkAppId);
  const reply = (content: string) => messageId
    ? replyMessage(larkAppId, messageId, content, 'text', false)
        .catch(err => logger.warn(`[substitute] reply failed: ${err?.message ?? err}`))
    : Promise.resolve();

  const argLine = match[1]?.trim() ?? 'status';
  const parts = argLine.split(/\s+/);
  const arg = parts[0]?.toLowerCase() ?? 'status';

  if (isP2p) {
    if (arg === 'list' || arg === 'status' || arg === '列表') {
      if (!senderOpenId) return true;
      if (!canUseDirectControls(larkAppId, senderOpenId)) {
        await reply(t('cmd.substitute.direct_forbidden', undefined, loc));
        return true;
      }
      await (messageId
        ? replyMessage(larkAppId, messageId, buildDirectChatCard(larkAppId, await listSubstituteDirectChats(larkAppId, senderOpenId), senderOpenId, loc), 'interactive', false)
            .catch(err => logger.warn(`[substitute] reply failed: ${err?.message ?? err}`))
        : Promise.resolve());
      return true;
    }
    if (arg === 'enter' || arg === 'join' || arg === '进入') {
      const targetChatId = parts[1];
      const result = await applyDirectAction(larkAppId, senderOpenId, targetChatId, 'substitute_direct_enter', loc);
      await reply(result.message);
      return true;
    }
    if (arg === 'intervene' || arg === '干预') {
      const targetChatId = parts[1];
      const result = await applyDirectAction(larkAppId, senderOpenId, targetChatId, 'substitute_direct_intervene', loc);
      await reply(result.message);
      return true;
    }
    if (arg === 'exit' || arg === 'leave' || arg === '退出') {
      const targetChatId = parts[1];
      const bindingOpenId = substituteBindingOpenIdForControls(larkAppId, senderOpenId);
      const binding = getSubstituteDirectBinding(larkAppId, bindingOpenId);
      const active = !targetChatId && binding?.activeChatId ? binding.chats[binding.activeChatId] : undefined;
      if (targetChatId === 'all' || targetChatId === '全部') {
        const existed = clearSubstituteDirectChat(larkAppId, bindingOpenId);
        await reply(existed ? t('cmd.substitute.direct_exit_ok', { chat: t('cmd.substitute.direct_all', undefined, loc) }, loc) : t('cmd.substitute.direct_exit_none', undefined, loc));
        return true;
      }
      const result = targetChatId
        ? await applyDirectAction(larkAppId, senderOpenId, targetChatId, 'substitute_direct_exit', loc)
        : {
            ok: clearSubstituteDirectChat(larkAppId, bindingOpenId, binding?.activeChatId),
            message: active ? t('cmd.substitute.direct_exit_ok', { chat: active.chatName ?? active.chatId }, loc) : t('cmd.substitute.direct_exit_none', undefined, loc),
          };
      await reply(result.message);
      return true;
    }
    if (arg === 'leave-group' || arg === 'quit-group' || arg === '退群') {
      const targetChatId = parts[1];
      const result = await applyDirectAction(larkAppId, senderOpenId, targetChatId, 'substitute_direct_leave_group', loc);
      await reply(result.message);
      return true;
    }
    await reply(t('cmd.substitute.unsupported', undefined, loc));
    return true;
  }

  if (!chatId || (await getChatMode(larkAppId, chatId)) !== 'group') {
    await reply(t('cmd.substitute.unsupported', undefined, loc));
    return true;
  }

  if (!arg || arg === 'status') {
    if (!canTalk(larkAppId, chatId, senderOpenId) && !isBotMentioned(larkAppId, message, senderOpenId)) return true;
    const enabled = isSubstituteEnabledForChat(larkAppId, chatId);
    await reply(t(enabled ? 'cmd.substitute.status_on' : 'cmd.substitute.status_off', undefined, loc));
    return true;
  }

  const enable = arg === 'on' || arg === 'enable' || arg === '开启' || arg === '开';
  const disable = arg === 'off' || arg === 'disable' || arg === '关闭' || arg === '关';
  if (!enable && !disable) {
    await reply(t('cmd.substitute.usage', undefined, loc));
    return true;
  }
  if (!canOperate(larkAppId, chatId, senderOpenId)) {
    await reply(t('cmd.substitute.owner_only', undefined, loc));
    return true;
  }
  setSubstituteEnabledForChat(larkAppId, chatId, enable);
  await reply(t(enable ? 'cmd.substitute.updated_on' : 'cmd.substitute.updated_off', undefined, loc));
  return true;
}
