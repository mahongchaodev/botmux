/**
 * Shared 拉群 orchestration for federation — used by BOTH the local team page
 * (`/api/team/federated-group`, dashboard token) and the hub endpoint a spoke
 * calls (`/api/federation/group`, syncToken). Keeps the create-or-delegate +
 * owner-invite logic in one place so the two entry points can't drift.
 *
 * Invite set (union_id, deduped) = the OPERATOR (whoever initiated; for a spoke
 * request it's the hub-derived spoke owner — NEVER client-supplied) + each
 * selected bot's owner. Bots are added by app_id (see docs/federation-design.md).
 */
import { buildFederatedRoster } from '../services/federation-roster.js';
import { listFederatedDeployments } from '../services/federation-store.js';
import { DEFAULT_TEAM_ID } from '../services/team-store.js';
import type { LiveBot } from '../services/team-roster.js';

const HUB_TIMEOUT_MS = 8000;

/** Thrown by fetchWithTimeout when a hub/spoke call doesn't answer in time. */
export class HubTimeout extends Error { constructor() { super('hub_timeout'); this.name = 'HubTimeout'; } }

export type Fetcher = typeof fetch;

/** Wrap an outbound call with an abort timeout; surface a distinguishable timeout. */
export async function fetchWithTimeout(fetcher: Fetcher, url: string, init: RequestInit = {}, ms = HUB_TIMEOUT_MS): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetcher(url, { ...init, signal: ac.signal });
  } catch (e: any) {
    if (e?.name === 'AbortError' || e instanceof HubTimeout) throw new HubTimeout();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Map an outbound call failure to a stable {status, error}. */
export function hubError(e: unknown): { status: number; error: string } {
  return e instanceof HubTimeout ? { status: 504, error: 'hub_timeout' } : { status: 502, error: 'hub_unreachable' };
}

export interface OrchestrateGroupDeps {
  /** Picks a LOCAL online creator + proxies to its daemon (federated bots added by app_id). */
  createTeamGroup: (args: { name: string; larkAppIds: string[]; ownerUnionIds?: string[] }) => Promise<{
    ok: boolean; chatId?: string; shareLink?: string; invalidBotIds?: string[]; invalidOwnerUnionIds?: string[]; error?: string;
  }>;
  fetcher: Fetcher;
  /** Live daemon-registry bots (authoritative local roster source). */
  live?: LiveBot[];
}

export interface OrchestrateGroupArgs {
  name: string;
  larkAppIds: string[];
  /** Hub-derived/local operator union_id (the person who initiated). Undefined ⇒
   *  operator identity not bound (missingOperatorIdentity surfaced). NEVER trust
   *  a client-supplied value — callers derive this from auth. */
  operatorUnionId?: string;
  /** Idempotency key for delegate calls (one per 拉群). */
  requestId: string;
  /** Team whose aggregated roster gates the selection (hub may host non-default teams). */
  teamId?: string;
}

/**
 * Validate selection against the team's aggregated roster, collect invitees
 * (operator + selected bots' owners), then create locally if a local online bot
 * exists, else delegate to a federated deployment that owns a selected bot.
 * Returns a transport-agnostic {status, body}.
 */
export async function orchestrateFederatedGroup(
  dataDir: string,
  args: OrchestrateGroupArgs,
  deps: OrchestrateGroupDeps,
): Promise<{ status: number; body: any }> {
  const { name, larkAppIds, operatorUnionId, requestId } = args;
  const teamId = args.teamId ?? DEFAULT_TEAM_ID;
  if (larkAppIds.length === 0) return { status: 400, body: { ok: false, error: 'no_bots_selected' } };
  const roster = buildFederatedRoster(dataDir, teamId, undefined, undefined, deps.live);
  const byId = new Map(roster.bots.map(b => [b.larkAppId, b]));
  const unknown = larkAppIds.filter(id => !byId.has(id));
  if (unknown.length) return { status: 400, body: { ok: false, error: 'unknown_bot', unknown } };

  // Invitees = operator (if bound) + each selected bot's owner. union_id, deduped.
  const ownerUnionIds = Array.from(new Set([
    ...(operatorUnionId ? [operatorUnionId] : []),
    ...larkAppIds.map(id => byId.get(id)?.owner?.unionId).filter((u): u is string => !!u),
  ]));
  const missingOperatorIdentity = !operatorUnionId;

  const r = await deps.createTeamGroup({ name, larkAppIds, ownerUnionIds });
  if (r.ok) return { status: 200, body: { ...r, missingOperatorIdentity } };

  // No local online creator → delegate to a reachable deployment that owns a
  // selected bot (hub→spoke). requestId makes each delegate idempotent.
  if (r.error === 'no_online_daemon') {
    const selected = new Set(larkAppIds);
    let lastErr = 'no_creator_available';
    for (const dep of listFederatedDeployments(dataDir, teamId)) {
      if (!dep.callbackUrl || !dep.delegationToken) continue;
      if (!dep.bots.some(b => selected.has(b.larkAppId))) continue;
      try {
        const dr = await fetchWithTimeout(deps.fetcher, `${dep.callbackUrl}/api/federation/delegate-group`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${dep.delegationToken}` },
          body: JSON.stringify({ name, larkAppIds, ownerUnionIds, requestId }),
        });
        const dj = await dr.json().catch(() => ({} as any));
        if (dr.ok && dj?.ok && dj.chatId) return { status: 200, body: { ...dj, delegatedTo: dep.name, missingOperatorIdentity } };
        lastErr = dj?.error || `hub_${dr.status}`;
      } catch (e) {
        // Timeout ⇒ the delegate MAY have created the group (lost response). Stop —
        // trying another deployment would risk a duplicate.
        if (e instanceof HubTimeout) return { status: 504, body: { ok: false, error: 'delegation_timeout', delegatedTo: dep.name } };
        lastErr = 'hub_unreachable'; // never connected → safe to try next
      }
    }
    return { status: 502, body: { ok: false, error: lastErr } };
  }
  return { status: 502, body: r };
}
