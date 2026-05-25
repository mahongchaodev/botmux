/**
 * Same-name bot disambiguation for `botmux send` cross-ref reverse lookup.
 *
 * bots-info.json can hold multiple entries with the same `botName` when a
 * deployment runs two apps under the same display name. Cross-ref files key
 * on botName (`{ <name>: <sender-scoped open_id> }`), so the reverse path
 * — botName → larkAppId — is ambiguous: `Array.find` silently routes to
 * whichever entry sorts first, often the wrong one. Prefer the entry whose
 * `oncallChats` includes the outbound chat — that's the deployment intent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BOTS_JSON = join(homedir(), '.botmux', 'bots.json');

export function loadOncallChatsByApp(botsJsonPath?: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const path = botsJsonPath
    ?? (process.env.BOTS_CONFIG ? resolve(process.env.BOTS_CONFIG) : DEFAULT_BOTS_JSON);
  try {
    if (!existsSync(path)) return map;
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(parsed)) return map;
    for (const cfg of parsed) {
      if (!cfg?.larkAppId || !Array.isArray(cfg.oncallChats)) continue;
      const chats = new Set<string>();
      for (const c of cfg.oncallChats) {
        if (typeof c?.chatId === 'string') chats.add(c.chatId);
      }
      if (chats.size > 0) map.set(cfg.larkAppId, chats);
    }
  } catch { /* */ }
  return map;
}

export function pickBotEntryByName<T extends { larkAppId: string; botName: string | null }>(
  botEntries: T[],
  name: string,
  targetChatId: string | undefined,
  oncallChatsByApp: Map<string, Set<string>>,
): T | undefined {
  const lower = name.toLowerCase();
  const candidates = botEntries.filter(e => e.botName?.toLowerCase() === lower);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1 || !targetChatId) return candidates[0];
  return candidates.find(e => oncallChatsByApp.get(e.larkAppId)?.has(targetChatId)) ?? candidates[0];
}

export type BotMentionEntry = {
  larkAppId: string;
  botOpenId?: string | null;
  botName: string | null;
  cliId?: string | null;
};

export type OutgoingMention = {
  open_id: string;
  name?: string;
};

function knownBotNames(entries: BotMentionEntry[], selfAppId?: string): Set<string> {
  const names = new Set<string>();
  for (const entry of entries) {
    if (selfAppId && entry.larkAppId === selfAppId) continue;
    for (const name of [entry.botName, entry.cliId]) {
      if (name) names.add(name.toLowerCase());
    }
  }
  return names;
}

export function knownBotOpenIdsFromCrossRef(
  crossRef: Record<string, string>,
  entries: BotMentionEntry[] = [],
  selfAppId?: string,
): Set<string> {
  const out = new Set(Object.values(crossRef).filter(Boolean));
  for (const entry of entries) {
    if (selfAppId && entry.larkAppId === selfAppId) continue;
    if (entry.botOpenId) out.add(entry.botOpenId);
  }
  return out;
}

export function hasKnownBotMention(
  _text: string,
  mentions: OutgoingMention[],
  entries: BotMentionEntry[],
  crossRef: Record<string, string>,
  selfAppId?: string,
): boolean {
  const names = knownBotNames(entries, selfAppId);
  const openIds = knownBotOpenIdsFromCrossRef(crossRef, entries, selfAppId);

  for (const mention of mentions) {
    if (openIds.has(mention.open_id)) return true;
    if (mention.name && names.has(mention.name.toLowerCase())) return true;
  }

  return false;
}

/**
 * Decide who a botmux-generated reply should @ in the footer.
 *
 * The footer is an implicit convenience for human readers. It must not wake a
 * bot: bot-to-bot routing should be explicit in the message body/--mention.
 * When the body already contains an explicit bot target, keep the footer on a
 * human owner if one exists; only bot recipients are suppressed.
 */
export function buildFooterAddressing(
  s: { ownerOpenId?: string; lastCallerOpenId?: string },
  opts: {
    isOncall: boolean;
    hasExplicitBotMention?: boolean;
    knownBotOpenIds?: Set<string>;
  },
): { sendTo: string | undefined; cc: string[] } {
  const owner = s.ownerOpenId;
  const botIds = opts.knownBotOpenIds ?? new Set<string>();
  const ownerHuman = owner && !botIds.has(owner) ? owner : undefined;

  if (!opts.isOncall) return { sendTo: ownerHuman, cc: [] };

  const caller = s.lastCallerOpenId ?? owner;
  const callerIsBot = !!caller && botIds.has(caller);

  if (opts.hasExplicitBotMention || callerIsBot) {
    return { sendTo: ownerHuman, cc: [] };
  }

  return { sendTo: caller, cc: [] };
}
