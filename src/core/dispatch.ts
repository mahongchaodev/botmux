/**
 * Phase 0 keystone — `botmux dispatch` pure core.
 *
 * The orchestrator (主 bot) splits a big project into sub-projects and assigns
 * each to a small group of bots (often a coder + a reviewer). To open a
 * sub-project it seeds a fresh Lark thread and @-mentions the assigned bots so
 * each spawns its own thread-scoped session (botmux's existing one-thread-one-
 * session routing; bot→bot @ inside a thread is ungated — see
 * event-dispatcher.ts decideRouting + the chat-scope-only foreign-bot gate).
 *
 * This module is the pure, I/O-free core: parse the `--bot` specs and build the
 * two messages (a top-level seed = the thread root, and the threaded kickoff
 * that @-mentions the bots with their roles + the brief). The CLI shell
 * (cli.ts) performs the actual sendMessage + replyMessage.
 */

export interface DispatchBot {
  /** open_id as seen by the orchestrator's app (from <available_bots>). */
  openId: string;
  /** Display name, for readable @ rendering / division-of-labor lines. */
  name?: string;
  /** Short role label, e.g. "coder" / "reviewer". */
  role?: string;
}

export type PostNode = { tag: 'text'; text: string } | { tag: 'at'; user_id: string };
export type PostParagraph = PostNode[];

export interface DispatchMessages {
  /** Plain-text seed (the thread root) — the human-visible "this sub-project exists" header. */
  seedText: string;
  /** Lark 'post' content (paragraphs of nodes) for the threaded kickoff. */
  threadContent: PostParagraph[];
  /** open_ids @-mentioned in the kickoff — the bots that will be triggered. */
  mentionedOpenIds: string[];
}

/**
 * Parse a `--bot` spec `openId[:name[:role]]` into a {@link DispatchBot}.
 * Mirrors the `--mention "open_id:Display Name"` convention, with an optional
 * trailing role segment.
 */
export function parseDispatchBotSpec(raw: string): DispatchBot {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('empty --bot spec');
  const parts = trimmed.split(':');
  const openId = parts[0]?.trim();
  if (!openId) throw new Error(`invalid --bot spec: ${JSON.stringify(raw)}`);
  const bot: DispatchBot = { openId };
  const name = parts[1]?.trim();
  const role = parts[2]?.trim();
  if (name) bot.name = name;
  if (role) bot.role = role;
  return bot;
}

/**
 * Build the seed + threaded-kickoff messages for one sub-project dispatch.
 * Throws when there is no title or no bot to dispatch to.
 */
export function buildDispatchMessages(input: {
  title: string;
  brief: string;
  bots: DispatchBot[];
}): DispatchMessages {
  const title = input.title.trim();
  if (!title) throw new Error('dispatch requires a title');
  if (input.bots.length === 0) throw new Error('dispatch requires at least one bot');

  const seedText = `📋 子项目：${title}`;

  const content: PostParagraph[] = [];

  // Line 1: @ every assigned bot (role suffix inline) so each gets triggered.
  const atLine: PostNode[] = [];
  input.bots.forEach((b, i) => {
    if (i > 0) atLine.push({ tag: 'text', text: ' ' });
    atLine.push({ tag: 'at', user_id: b.openId });
    if (b.role) atLine.push({ tag: 'text', text: `（${b.role}）` });
  });
  content.push(atLine);

  content.push([{ tag: 'text', text: '' }]);

  // The brief, one paragraph per line.
  for (const line of input.brief.split('\n')) {
    content.push([{ tag: 'text', text: line }]);
  }

  // Division of labour, when any role was given.
  if (input.bots.some(b => b.role)) {
    content.push([{ tag: 'text', text: '' }]);
    content.push([{ tag: 'text', text: '分工：' }]);
    for (const b of input.bots) {
      const label = b.name || b.openId;
      content.push([{ tag: 'text', text: `· ${label}：${b.role ?? '执行'}` }]);
    }
  }

  return {
    seedText,
    threadContent: content,
    mentionedOpenIds: input.bots.map(b => b.openId),
  };
}
