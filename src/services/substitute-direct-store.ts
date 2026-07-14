import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface SubstituteDirectChat {
  targetKey?: string;
  scope?: 'chat' | 'thread';
  anchor?: string;
  chatId: string;
  chatName?: string;
  title?: string;
  sessionId?: string;
  chatType?: 'group' | 'p2p';
  targetName?: string;
  mode?: 'direct';
  enabled?: boolean;
  disclosure?: 'prefix' | 'none';
  lastGroupMessageId?: string;
  dmRootMessageId?: string;
  dmToGroupMessageIds?: Record<string, string>;
  updatedAt: number;
}

export interface SubstituteDirectBinding {
  larkAppId: string;
  substituteOpenId: string;
  targetOpenId?: string;
  substituteUserId?: string;
  substituteUnionId?: string;
  targetName?: string;
  activeChatId?: string;
  chats: Record<string, SubstituteDirectChat>;
  updatedAt: number;
}

interface Store {
  bindings: Record<string, SubstituteDirectBinding>;
}

function filePath(): string {
  return join(config.session.dataDir, 'substitute-direct-bindings.json');
}

function key(larkAppId: string, substituteOpenId: string): string {
  return `${larkAppId}::${substituteOpenId}`;
}

export function substituteDirectTargetKey(scope: 'chat' | 'thread' | undefined, anchor: string | undefined, chatId?: string): string | undefined {
  if (scope === 'thread' && anchor) return `thread:${anchor}`;
  const id = anchor || chatId;
  return id ? `chat:${id}` : undefined;
}

function normalize(raw: unknown): Store {
  const bindings: Record<string, SubstituteDirectBinding> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { bindings };
  const rec = raw as Record<string, unknown>;
  const rawBindings = rec.bindings;
  if (!rawBindings || typeof rawBindings !== 'object' || Array.isArray(rawBindings)) return { bindings };
  for (const [k, v] of Object.entries(rawBindings)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const b = v as Record<string, unknown>;
    if (typeof b.larkAppId !== 'string' || !b.larkAppId) continue;
    if (typeof b.substituteOpenId !== 'string' || !b.substituteOpenId) continue;
    const chats: Record<string, SubstituteDirectChat> = {};
    if (b.chats && typeof b.chats === 'object' && !Array.isArray(b.chats)) {
      for (const [chatKey, rawChat] of Object.entries(b.chats)) {
        if (!rawChat || typeof rawChat !== 'object' || Array.isArray(rawChat)) continue;
        const c = rawChat as Record<string, unknown>;
        if (c.mode === 'intervene') continue;
        const scope = c.scope === 'thread' ? 'thread' : 'chat';
        const chatId = typeof c.chatId === 'string' && c.chatId ? c.chatId : chatKey.replace(/^chat:/, '');
        const anchor = typeof c.anchor === 'string' && c.anchor ? c.anchor : (scope === 'thread' ? chatKey.replace(/^thread:/, '') : chatId);
        const targetKey = typeof c.targetKey === 'string' && c.targetKey ? c.targetKey : substituteDirectTargetKey(scope, anchor, chatId) ?? chatKey;
        chats[targetKey] = {
          targetKey,
          scope,
          anchor,
          chatId,
          chatName: typeof c.chatName === 'string' ? c.chatName : undefined,
          title: typeof c.title === 'string' ? c.title : undefined,
          sessionId: typeof c.sessionId === 'string' ? c.sessionId : undefined,
          chatType: c.chatType === 'p2p' ? 'p2p' : 'group',
          targetName: typeof c.targetName === 'string' ? c.targetName : undefined,
          mode: 'direct',
          enabled: c.enabled !== false,
          disclosure: c.disclosure === 'none' ? 'none' : 'prefix',
          lastGroupMessageId: typeof c.lastGroupMessageId === 'string' ? c.lastGroupMessageId : undefined,
          dmRootMessageId: typeof c.dmRootMessageId === 'string' ? c.dmRootMessageId : undefined,
          dmToGroupMessageIds: c.dmToGroupMessageIds && typeof c.dmToGroupMessageIds === 'object' && !Array.isArray(c.dmToGroupMessageIds)
            ? Object.fromEntries(Object.entries(c.dmToGroupMessageIds).filter((e): e is [string, string] => typeof e[0] === 'string' && typeof e[1] === 'string'))
            : undefined,
          updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : 0,
        };
      }
    } else if (typeof b.chatId === 'string' && b.chatId) {
      // Backward-compatible read of the short-lived single-binding shape.
      const targetKey = substituteDirectTargetKey('chat', b.chatId, b.chatId) ?? b.chatId;
      chats[targetKey] = {
        targetKey,
        scope: 'chat',
        anchor: b.chatId,
        chatId: b.chatId,
        chatName: typeof b.chatName === 'string' ? b.chatName : undefined,
        targetName: typeof b.targetName === 'string' ? b.targetName : undefined,
        mode: 'direct',
        enabled: true,
        disclosure: b.disclosure === 'none' ? 'none' : 'prefix',
        lastGroupMessageId: typeof b.lastGroupMessageId === 'string' ? b.lastGroupMessageId : undefined,
        dmRootMessageId: typeof b.dmRootMessageId === 'string' ? b.dmRootMessageId : undefined,
        updatedAt: typeof b.updatedAt === 'number' ? b.updatedAt : 0,
      };
    }
    if (Object.keys(chats).length === 0) continue;
    const rawActiveChatId = typeof b.activeChatId === 'string' ? b.activeChatId : undefined;
    const activeKey = rawActiveChatId
      ? (chats[rawActiveChatId] ? rawActiveChatId : substituteDirectTargetKey('chat', rawActiveChatId, rawActiveChatId))
      : undefined;
    const activeChatId = activeKey && chats[activeKey]
      ? rawActiveChatId
      : Object.values(chats).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.chatId;
    bindings[k] = {
      larkAppId: b.larkAppId,
      substituteOpenId: b.substituteOpenId,
      targetOpenId: typeof b.targetOpenId === 'string' ? b.targetOpenId : b.substituteOpenId,
      substituteUserId: typeof b.substituteUserId === 'string' ? b.substituteUserId : undefined,
      substituteUnionId: typeof b.substituteUnionId === 'string' ? b.substituteUnionId : undefined,
      targetName: typeof b.targetName === 'string' ? b.targetName : undefined,
      activeChatId: activeKey && chats[activeKey] ? activeKey : activeChatId,
      chats,
      updatedAt: typeof b.updatedAt === 'number' ? b.updatedAt : 0,
    };
  }
  return { bindings };
}

function readStore(): Store {
  try {
    if (!existsSync(filePath())) return { bindings: {} };
    return normalize(JSON.parse(readFileSync(filePath(), 'utf-8')));
  } catch {
    return { bindings: {} };
  }
}

function writeStore(store: Store): void {
  atomicWriteFileSync(filePath(), JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
}

export function getSubstituteDirectBinding(
  larkAppId: string,
  substituteOpenId: string | undefined,
): SubstituteDirectBinding | undefined {
  if (!substituteOpenId) return undefined;
  return readStore().bindings[key(larkAppId, substituteOpenId)];
}

export function getActiveSubstituteDirectChat(
  larkAppId: string,
  substituteOpenId: string | undefined,
): SubstituteDirectChat | undefined {
  const binding = getSubstituteDirectBinding(larkAppId, substituteOpenId);
  if (!binding?.activeChatId) return undefined;
  const chat = binding.chats[binding.activeChatId] ?? binding.chats[substituteDirectTargetKey('chat', binding.activeChatId, binding.activeChatId) ?? ''];
  return chat?.enabled === false ? undefined : chat;
}

export function getSubstituteDirectChat(
  larkAppId: string,
  substituteOpenId: string | undefined,
  chatIdOrTargetKey: string | undefined,
): SubstituteDirectChat | undefined {
  if (!chatIdOrTargetKey) return undefined;
  const binding = getSubstituteDirectBinding(larkAppId, substituteOpenId);
  const chat = binding?.chats[chatIdOrTargetKey]
    ?? binding?.chats[substituteDirectTargetKey('chat', chatIdOrTargetKey, chatIdOrTargetKey) ?? ''];
  return chat?.enabled === false ? undefined : chat;
}

export function getSubstituteDirectChatByTarget(
  larkAppId: string,
  target: { openId?: string; userId?: string; unionId?: string; name?: string } | undefined,
  chatId: string | undefined,
  targetKey?: string,
): { chat: SubstituteDirectChat; substituteOpenId: string } | undefined {
  if (!target || !chatId) return undefined;
  const strictTarget = !!targetKey && targetKey.startsWith('thread:');
  if (target.openId) {
    const chat = getSubstituteDirectChat(larkAppId, target.openId, targetKey)
      ?? (strictTarget ? undefined : getSubstituteDirectChat(larkAppId, target.openId, chatId));
    if (chat) return { chat, substituteOpenId: target.openId };
  }
  const store = readStore();
  for (const binding of Object.values(store.bindings)) {
    if (binding.larkAppId !== larkAppId) continue;
    const bindingTargetOpenId = binding.targetOpenId ?? binding.substituteOpenId;
    const matched = (target.openId && binding.substituteOpenId === target.openId)
      || (target.openId && bindingTargetOpenId === target.openId)
      || (target.userId && binding.substituteUserId === target.userId)
      || (target.unionId && binding.substituteUnionId === target.unionId)
      || (!!target.name && (binding.targetName === target.name || (targetKey && binding.chats[targetKey]?.targetName === target.name) || (!strictTarget && binding.chats[substituteDirectTargetKey('chat', chatId, chatId) ?? chatId]?.targetName === target.name)));
    if (!matched) continue;
    const chat = (targetKey ? binding.chats[targetKey] : undefined)
      ?? (strictTarget ? undefined : binding.chats[substituteDirectTargetKey('chat', chatId, chatId) ?? chatId]);
    if (chat && chat.enabled !== false) return { chat, substituteOpenId: binding.substituteOpenId };
  }
  return undefined;
}

export function getSubstituteDirectChatByTargetKey(
  larkAppId: string,
  chatId: string | undefined,
  targetKey?: string,
): { chat: SubstituteDirectChat; substituteOpenId: string; targetOpenId?: string; substituteUserId?: string; substituteUnionId?: string; targetName?: string } | undefined {
  if (!chatId) return undefined;
  const strictTarget = !!targetKey && targetKey.startsWith('thread:');
  const chatKey = substituteDirectTargetKey('chat', chatId, chatId) ?? chatId;
  const store = readStore();
  for (const binding of Object.values(store.bindings)) {
    if (binding.larkAppId !== larkAppId) continue;
    const chat = (targetKey ? binding.chats[targetKey] : undefined)
      ?? (strictTarget ? undefined : binding.chats[chatKey]);
    if (!chat || chat.enabled === false || chat.mode !== 'direct') continue;
    return {
      chat,
      substituteOpenId: binding.substituteOpenId,
      targetOpenId: binding.targetOpenId ?? binding.substituteOpenId,
      substituteUserId: binding.substituteUserId,
      substituteUnionId: binding.substituteUnionId,
      targetName: binding.targetName ?? chat.targetName,
    };
  }
  return undefined;
}

export function upsertSubstituteDirectChat(input: {
  larkAppId: string;
  substituteOpenId: string;
  targetOpenId?: string;
  substituteUserId?: string;
  substituteUnionId?: string;
  chatId: string;
  targetKey?: string;
  scope?: 'chat' | 'thread';
  anchor?: string;
  title?: string;
  sessionId?: string;
  chatType?: 'group' | 'p2p';
  chatName?: string | null;
  targetName?: string;
  mode?: 'direct';
  disclosure?: 'prefix' | 'none';
  lastGroupMessageId?: string;
  dmRootMessageId?: string;
  resetDmHistory?: boolean;
  preserveExistingChats?: boolean;
}): SubstituteDirectBinding {
  const store = readStore();
  const k = key(input.larkAppId, input.substituteOpenId);
  const current = store.bindings[k] ?? {
    larkAppId: input.larkAppId,
    substituteOpenId: input.substituteOpenId,
    chats: {},
    updatedAt: 0,
  };
  current.targetOpenId = input.targetOpenId;
  current.substituteUserId = input.substituteUserId;
  current.substituteUnionId = input.substituteUnionId;
  current.targetName = input.targetName;
  if (!input.preserveExistingChats) current.chats = {};
  const scope = input.scope === 'thread' ? 'thread' : 'chat';
  const anchor = input.anchor || (scope === 'thread' ? input.targetKey?.replace(/^thread:/, '') : input.chatId);
  const targetKey = input.targetKey ?? substituteDirectTargetKey(scope, anchor, input.chatId) ?? input.chatId;
  current.chats[targetKey] = {
    targetKey,
    scope,
    anchor,
    chatId: input.chatId,
    chatName: input.chatName || undefined,
    title: input.title,
    sessionId: input.sessionId,
    chatType: input.chatType ?? 'group',
    targetName: input.targetName,
    mode: 'direct',
    enabled: true,
    disclosure: input.disclosure === 'none' ? 'none' : 'prefix',
    lastGroupMessageId: input.lastGroupMessageId,
    dmRootMessageId: input.dmRootMessageId ?? current.chats[targetKey]?.dmRootMessageId,
    dmToGroupMessageIds: input.resetDmHistory ? undefined : current.chats[targetKey]?.dmToGroupMessageIds,
    updatedAt: Date.now(),
  };
  current.activeChatId = targetKey;
  current.updatedAt = Date.now();
  store.bindings[k] = current;
  writeStore(store);
  return current;
}

export function getSubstituteDirectChatByDmAnchor(
  larkAppId: string,
  substituteOpenId: string | undefined,
  dmMessageId: string | undefined,
): SubstituteDirectChat | undefined {
  if (!substituteOpenId || !dmMessageId) return undefined;
  const binding = getSubstituteDirectBinding(larkAppId, substituteOpenId);
  if (!binding) return undefined;
  for (const chat of Object.values(binding.chats)) {
    if (chat.enabled === false) continue;
    if (chat.dmRootMessageId === dmMessageId) return chat;
    if (chat.dmToGroupMessageIds?.[dmMessageId]) return chat;
  }
  return undefined;
}

export function recordSubstituteDirectForwardedMessage(input: {
  larkAppId: string;
  substituteOpenId: string | undefined;
  chatId: string | undefined;
  dmMessageId: string | undefined;
  groupMessageId: string | undefined;
}): void {
  if (!input.substituteOpenId || !input.chatId || !input.dmMessageId || !input.groupMessageId) return;
  const store = readStore();
  const binding = store.bindings[key(input.larkAppId, input.substituteOpenId)];
  const chat = binding?.chats?.[input.chatId] ?? binding?.chats?.[substituteDirectTargetKey('chat', input.chatId, input.chatId) ?? ''];
  if (!binding || !chat) return;
  const pairs = Object.entries(chat.dmToGroupMessageIds ?? {});
  pairs.push([input.dmMessageId, input.groupMessageId]);
  chat.dmToGroupMessageIds = Object.fromEntries(pairs.slice(-50));
  chat.updatedAt = Date.now();
  binding.updatedAt = Date.now();
  writeStore(store);
}

export function getSubstituteDirectQuotedGroupMessageId(
  larkAppId: string,
  substituteOpenId: string | undefined,
  dmMessageId: string | undefined,
): string | undefined {
  if (!substituteOpenId || !dmMessageId) return undefined;
  const binding = getSubstituteDirectBinding(larkAppId, substituteOpenId);
  if (!binding) return undefined;
  for (const chat of Object.values(binding.chats)) {
    if (chat.enabled === false) continue;
    const hit = chat.dmToGroupMessageIds?.[dmMessageId];
    if (hit) return hit;
  }
  return undefined;
}

export function clearSubstituteDirectChat(larkAppId: string, substituteOpenId: string | undefined, chatId?: string): boolean {
  if (!substituteOpenId) return false;
  const store = readStore();
  const k = key(larkAppId, substituteOpenId);
  const binding = store.bindings[k];
  if (!binding) return false;
  if (!chatId) {
    const existed = Object.keys(binding.chats).length > 0;
    delete store.bindings[k];
    if (existed) writeStore(store);
    return existed;
  }
  const targetKey = binding.chats[chatId] ? chatId : substituteDirectTargetKey('chat', chatId, chatId) ?? chatId;
  const existed = !!binding.chats[targetKey];
  delete binding.chats[targetKey];
  if (binding.activeChatId === targetKey || binding.activeChatId === chatId) {
    binding.activeChatId = Object.values(binding.chats).filter(c => c.enabled !== false).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.targetKey;
  }
  binding.updatedAt = Date.now();
  if (Object.keys(binding.chats).length === 0) delete store.bindings[k];
  else store.bindings[k] = binding;
  if (existed) writeStore(store);
  return existed;
}

export function deactivateSubstituteDirectChat(larkAppId: string, substituteOpenId: string | undefined, targetKeyOrChatId?: string): boolean {
  if (!substituteOpenId || !targetKeyOrChatId) return false;
  const store = readStore();
  const k = key(larkAppId, substituteOpenId);
  const binding = store.bindings[k];
  if (!binding) return false;
  const targetKey = binding.chats[targetKeyOrChatId] ? targetKeyOrChatId : substituteDirectTargetKey('chat', targetKeyOrChatId, targetKeyOrChatId) ?? targetKeyOrChatId;
  const chat = binding.chats[targetKey];
  if (!chat || chat.enabled === false) return false;
  chat.enabled = false;
  chat.updatedAt = Date.now();
  if (binding.activeChatId === targetKey || binding.activeChatId === targetKeyOrChatId) {
    binding.activeChatId = Object.values(binding.chats).filter(c => c.enabled !== false).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.targetKey;
  }
  binding.updatedAt = Date.now();
  store.bindings[k] = binding;
  writeStore(store);
  return true;
}
