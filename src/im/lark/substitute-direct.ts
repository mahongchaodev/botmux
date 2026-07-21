import type { SubstituteTrigger } from '../../types.js';
import {
  getActiveSubstituteDirectChat,
  getSubstituteDirectChatByDmAnchor,
  getSubstituteDirectQuotedGroupMessageId,
  getSubstituteDirectChat,
  migrateActiveSubstituteDirectChatToDmRoot,
  recordSubstituteDirectForwardedMessage,
  substituteDirectTargetKey,
  upsertSubstituteDirectChat,
  type SubstituteDirectChat,
} from '../../services/substitute-direct-store.js';
import { getBot, resolveBrandLabel } from '../../bot-registry.js';
import { getChatName, getMessageThreadId, MessageWithdrawnError, replyMessage, sendMessage, sendUserMessage } from './client.js';
import { resolveName } from './identity-cache.js';
import { mentionOpenId, stripLeadingMentions } from './message-parser.js';
import { buildMarkdownCard } from './md-card.js';
import { t, localeForBot } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';

function textFromMessage(message: any, opts?: { renderAt?: boolean }): string | null {
  if (!message?.content) return null;
  try {
    const obj = JSON.parse(message.content);
    if (typeof obj?.text === 'string') return opts?.renderAt ? renderMentionKeys(obj.text, message?.mentions) : obj.text;
    const inner = obj?.zh_cn ?? obj?.en_us ?? obj;
    if (Array.isArray(inner?.content)) {
      const parts: string[] = [];
      for (const para of inner.content) {
        if (!Array.isArray(para)) continue;
        for (const node of para) {
          if (node?.tag === 'text' && typeof node.text === 'string') parts.push(node.text);
          else if (node?.tag === 'at' && typeof node.user_name === 'string') {
            const openId = typeof node.user_id === 'string' ? node.user_id : undefined;
            parts.push(opts?.renderAt && openId ? `<at id=${openId}></at>` : `@${node.user_name}`);
          }
        }
      }
      return parts.join('').trim() || null;
    }
  } catch { /* ignore malformed content */ }
  return null;
}

function renderMentionKeys(text: string, mentions: any[] | undefined): string {
  if (!mentions?.length) return text;
  let out = text;
  const sorted = [...mentions].sort((a, b) => String(b?.key ?? '').length - String(a?.key ?? '').length);
  for (const mention of sorted) {
    if (!mention?.key) continue;
    const openId = mentionOpenId(mention);
    if (!openId) continue;
    out = out.split(mention.key).join(`<at id=${openId}></at>`);
  }
  return out;
}

function isP2pThreadMode(larkAppId: string): boolean {
  try { return getBot(larkAppId).config.p2pMode !== 'chat'; } catch { return true; }
}

function dmAnchorFromMessage(message: any): string | undefined {
  return message?.thread_id ?? message?.root_id ?? message?.parent_id;
}

function isDmRootUnavailableError(err: unknown): boolean {
  if (err instanceof MessageWithdrawnError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /withdrawn|not found|invalid.*message|message.*invalid|thread.*invalid/i.test(message);
}

export async function forwardSubstituteGroupMessageToDm(input: {
  larkAppId: string;
  chatId: string;
  targetKey?: string;
  scope?: 'chat' | 'thread';
  anchor?: string;
  message: any;
  trigger: SubstituteTrigger;
  direct: { substituteOpenId: string; chat: SubstituteDirectChat };
}): Promise<boolean> {
  const targetOpenId = input.trigger.target.openId ?? input.direct.substituteOpenId;
  if (!targetOpenId) return false;
  const bindingOpenId = input.direct.substituteOpenId;
  const existing = input.direct.chat;
  if (!existing || existing.mode !== 'direct') return false;
  const p2pThreadMode = isP2pThreadMode(input.larkAppId);
  const loc = localeForBot(input.larkAppId);
  const body = textFromMessage(input.message, { renderAt: true });
  const chatName = await getChatName(input.larkAppId, input.chatId).catch(() => null);
  const forwardedContent = body
    ? body
    : t('substitute.direct.dm_non_text', {
        messageType: input.message?.message_type ?? input.message?.msg_type ?? t('substitute.direct.non_text_fallback', undefined, loc),
      }, loc);
  const content = t('substitute.direct.dm', {
    chat: chatName ?? input.chatId,
    target: input.trigger.target.name ?? targetOpenId,
    content: forwardedContent,
  }, loc);
  let dmRootMessageId = existing.dmRootMessageId;
  let dmThreadId = existing.dmThreadId;
  let dmMessageId: string;
  if (p2pThreadMode && dmRootMessageId && !dmRootMessageId.startsWith('omt_')) {
    try {
      dmMessageId = await replyMessage(input.larkAppId, dmRootMessageId, content, 'text', true);
      dmThreadId = dmThreadId ?? await getMessageThreadId(input.larkAppId, dmRootMessageId).catch(() => undefined);
    } catch (err) {
      if (!isDmRootUnavailableError(err)) throw err;
      logger.warn(`[substitute-direct:${input.larkAppId}] DM root ${dmRootMessageId.substring(0, 12)} unavailable, creating a new direct thread: ${err instanceof Error ? err.message : err}`);
      dmMessageId = await sendUserMessage(input.larkAppId, targetOpenId, content, 'text');
      dmRootMessageId = dmMessageId;
      dmThreadId = await getMessageThreadId(input.larkAppId, dmMessageId).catch(() => undefined);
    }
  } else {
    const previousThreadId = dmRootMessageId?.startsWith('omt_') ? dmRootMessageId : undefined;
    dmMessageId = await sendUserMessage(input.larkAppId, targetOpenId, content, 'text');
    if (p2pThreadMode) {
      dmRootMessageId = dmMessageId;
      dmThreadId = await getMessageThreadId(input.larkAppId, dmMessageId).catch(() => undefined) ?? previousThreadId;
    }
  }
  upsertSubstituteDirectChat({
    larkAppId: input.larkAppId,
    substituteOpenId: bindingOpenId,
    targetOpenId: input.trigger.target.openId,
    substituteUserId: input.trigger.target.userId,
    substituteUnionId: input.trigger.target.unionId,
    chatId: input.chatId,
    targetKey: input.targetKey ?? existing.targetKey,
    scope: input.scope ?? existing.scope,
    anchor: input.anchor ?? existing.anchor,
    title: existing.title,
    sessionId: existing.sessionId,
    chatType: existing.chatType,
    chatName,
    targetName: input.trigger.target.name,
    mode: 'direct',
    disclosure: input.trigger.disclosure,
    lastGroupMessageId: input.message?.message_id,
    dmRootMessageId,
    dmThreadId,
    preserveExistingChats: p2pThreadMode,
  });
  recordSubstituteDirectForwardedMessage({
    larkAppId: input.larkAppId,
    substituteOpenId: bindingOpenId,
    chatId: input.targetKey ?? existing.targetKey ?? substituteDirectTargetKey(input.scope ?? existing.scope, input.anchor ?? existing.anchor, input.chatId) ?? input.chatId,
    dmMessageId,
    groupMessageId: input.message?.message_id,
  });
  logger.info(`[substitute-direct:${input.larkAppId}] group ${input.chatId.substring(0, 12)} → DM ${targetOpenId.substring(0, 12)}`);
  return true;
}

export async function forwardSubstituteDmMessageToGroup(input: {
  larkAppId: string;
  message: any;
  senderOpenId: string | undefined;
}): Promise<boolean> {
  if (input.message?.chat_type !== 'p2p' || !input.senderOpenId) return false;
  const p2pThreadMode = isP2pThreadMode(input.larkAppId);
  const chat = p2pThreadMode
    ? getSubstituteDirectChatByDmAnchor(input.larkAppId, input.senderOpenId, dmAnchorFromMessage(input.message))
    : getActiveSubstituteDirectChat(input.larkAppId, input.senderOpenId);
  const loc = localeForBot(input.larkAppId);
  const rawBody = textFromMessage(input.message);
  const body = textFromMessage(input.message, { renderAt: true });
  const stripped = rawBody ? stripLeadingMentions(rawBody.trim(), input.message?.mentions ?? []).trim() : '';
  if (stripped.startsWith('/')) return false;
  const dmRootMessageId = p2pThreadMode ? input.message?.thread_id : undefined;
  const canMigrateToNewTopic = p2pThreadMode && !!dmRootMessageId;
  const migratedChat = !chat && canMigrateToNewTopic
    ? migrateActiveSubstituteDirectChatToDmRoot({
        larkAppId: input.larkAppId,
        substituteOpenId: input.senderOpenId,
        dmRootMessageId,
      })
    : undefined;
  const routedChat = chat ?? migratedChat;
  if (!routedChat) return false;
  if (!body) {
    await replyMessage(input.larkAppId, input.message.message_id, t('substitute.direct.unsupported_dm', undefined, loc), 'text', false)
      .catch(err => logger.warn(`[substitute-direct] unsupported DM notice failed: ${err?.message ?? err}`));
    return true;
  }
  const senderName = await resolveName(input.larkAppId, input.senderOpenId);
  const currentTarget = getBot(input.larkAppId).config.substituteMode?.targets?.find(t => t.openId === input.senderOpenId);
  const name = senderName || currentTarget?.name || routedChat.targetName || t('substitute.direct.group_fallback_name', undefined, loc);
  const content = routedChat.disclosure === 'none'
    ? t('substitute.direct.group', { name, content: body }, loc)
    : t('substitute.direct.group_prefix', { name, content: body }, loc);
  const card = buildMarkdownCard(content, undefined, resolveBrandLabel(input.larkAppId), loc);
  const hookContext = {
    source: 'substitute_direct',
    sourceMessageId: input.message?.message_id,
    substituteOpenId: input.senderOpenId,
  };
  const quotedGroupMessageId = getSubstituteDirectQuotedGroupMessageId(input.larkAppId, input.senderOpenId, input.message?.parent_id ?? input.message?.root_id);
  if (quotedGroupMessageId) {
    try {
      await replyMessage(input.larkAppId, quotedGroupMessageId, card, 'interactive', false, undefined, hookContext);
    } catch (err) {
      if (err instanceof MessageWithdrawnError) {
        if (routedChat.scope === 'thread' && routedChat.anchor) {
          await replyMessage(input.larkAppId, routedChat.anchor, card, 'interactive', true, undefined, hookContext);
        } else {
          await sendMessage(input.larkAppId, routedChat.chatId, card, 'interactive', undefined, hookContext);
        }
      } else {
        throw err;
      }
    }
  } else {
    if (routedChat.scope === 'thread' && routedChat.anchor) {
      await replyMessage(input.larkAppId, routedChat.anchor, card, 'interactive', true, undefined, hookContext);
    } else {
      await sendMessage(input.larkAppId, routedChat.chatId, card, 'interactive', undefined, hookContext);
    }
  }
  logger.info(`[substitute-direct:${input.larkAppId}] DM ${input.senderOpenId.substring(0, 12)} → group ${routedChat.chatId.substring(0, 12)}`);
  return true;
}
