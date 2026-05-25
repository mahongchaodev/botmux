// Team (federation) page: manage this deployment's team membership across
// deployments — show my bots + federated bots (search / filter / collapse /
// edit capability+role for LOCAL bots), mint invite codes (Hub), join other
// deployments' teams by invite (Spoke), and 拉群. All dashboard-token authed.
// See docs/federation-design.md.
import { escapeHtml } from './ui.js';

interface RosterBot {
  larkAppId: string; name: string; cliId: string; capability: string | null;
  hasTeamRole: boolean; deployment: { id: string; name: string; local: boolean; stale: boolean };
}
interface RosterDeployment { id: string; name: string; local: boolean; botCount: number; stale: boolean; }
interface LocalResp {
  ok: boolean; deployment: { deploymentId: string; name: string };
  suggestedHubUrl: string; deployments: RosterDeployment[]; bots: RosterBot[];
}

async function jget(u: string) { const r = await fetch(u); return { status: r.status, body: await r.json().catch(() => ({})) }; }
async function jpost(u: string, b?: unknown) {
  const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function jput(u: string, b: unknown) {
  const r = await fetch(u, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// Roster state. picked (for 拉群) is pruned when bots become hidden (filter /
// collapse) so a hidden row is never submitted. collapsed = deployment ids.
let rosterBots: RosterBot[] = [];
let rosterDeployments: RosterDeployment[] = [];
const picked = new Set<string>();
const collapsed = new Set<string>();

function $(id: string): HTMLElement { return document.getElementById(id)!; }

function pageHtml(): string {
  return `<section class="page">
<div class="page-heading">
  <div>
    <p class="eyebrow">团队</p>
    <h1>团队协作（跨部署）</h1>
    <p>把别的部署（同事自己跑的 botmux）邀请进同一个团队，互相发现机器人、协作。</p>
  </div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2 style="margin-top:0">本部署</h2>
  <p>名称：<b id="tf-dep-name">…</b>
    <button id="tf-rename" class="ghost" style="margin-left:8px">重命名</button></p>
  <p class="muted" style="font-size:13px">别人加入你的团队时，需要你的 Hub 地址 + 邀请码。邀请码发给<b>别的部署</b>的人用（不能加入自己）。</p>
  <p><button id="tf-invite" class="primary">生成邀请码</button></p>
  <div id="tf-invite-out" style="display:none;margin-top:8px"></div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2 style="margin-top:0">加入别人的团队</h2>
  <p style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <input id="tf-hub" placeholder="Hub 地址，如 http://10.0.0.5:7891" style="flex:1;min-width:240px">
    <input id="tf-code" placeholder="邀请码" style="min-width:160px">
    <button id="tf-join" class="primary">加入</button>
  </p>
  <div id="tf-join-out" style="display:none;margin-top:6px"></div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2 style="margin-top:0">团队花名册 <span class="muted" id="tf-roster-meta" style="font-size:13px"></span></h2>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;font-size:13px">
    <input id="tf-search" placeholder="搜索 名称/能力/CLI…" style="padding:5px 9px;min-width:180px">
    <select id="tf-cli" style="padding:5px"><option value="">全部 CLI</option></select>
    <label><input type="checkbox" id="tf-fcap"> 有能力标签</label>
    <label><input type="checkbox" id="tf-frole"> 有团队角色</label>
    <span class="muted" id="tf-count"></span>
  </div>
  <div id="tf-roster">加载中…</div>
  <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <input id="tf-grp-name" placeholder="群名（如：跨团队排障）" style="min-width:200px">
    <button id="tf-grp" class="primary">把勾选的机器人拉一个群</button>
    <span class="muted" style="font-size:13px">勾选机器人（可跨部署）→ 拉到一个飞书群（含 owner）</span>
  </div>
  <div id="tf-grp-out" style="display:none;margin-top:8px"></div>
</div>

<div class="card">
  <h2 style="margin-top:0">我加入的远端团队 <button id="tf-sync" class="ghost" style="float:right;font-size:13px">同步</button></h2>
  <div id="tf-remote">加载中…</div>
</div>

<div id="tf-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);align-items:center;justify-content:center;z-index:50">
  <div style="background:var(--card,#fff);color:var(--text,#1f2329);border-radius:10px;padding:18px 20px;width:min(560px,92vw)">
    <h2 id="tf-modal-title" style="margin-top:0">团队角色</h2>
    <p class="muted" style="font-size:13px">团队级角色（该机器人跨群的默认人设）。留空保存即删除。仅本部署的机器人可编辑。</p>
    <textarea id="tf-modal-text" style="width:100%;min-height:200px;font:13px/1.5 ui-monospace,Menlo,monospace;padding:10px;box-sizing:border-box"></textarea>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
      <button id="tf-modal-cancel">取消</button><button id="tf-modal-save" class="primary">保存</button>
    </div>
  </div>
</div>
</section>`;
}

function botMatch(b: RosterBot): boolean {
  const q = ((($('tf-search') as HTMLInputElement).value) || '').trim().toLowerCase();
  if (q && !((b.name || '') + ' ' + (b.cliId || '') + ' ' + (b.capability || '')).toLowerCase().includes(q)) return false;
  const cli = ($('tf-cli') as HTMLInputElement).value; if (cli && b.cliId !== cli) return false;
  if (($('tf-fcap') as HTMLInputElement).checked && !b.capability) return false;
  if (($('tf-frole') as HTMLInputElement).checked && !b.hasTeamRole) return false;
  return true;
}

function renderRoster(): void {
  const el = $('tf-roster');
  const filtered = rosterBots.filter(botMatch);
  // prune picks that are now hidden (filtered out OR in a collapsed group)
  const visible = new Set(filtered.filter(b => !collapsed.has(b.deployment.id)).map(b => b.larkAppId));
  [...picked].forEach(a => { if (!visible.has(a)) picked.delete(a); });

  if (!rosterBots.length) { el.innerHTML = '<p class="muted">还没有机器人。</p>'; $('tf-count').textContent = ''; return; }
  const ordered = [...rosterDeployments].sort((a, b) => (a.local === b.local ? 0 : a.local ? -1 : 1));
  let html = '';
  for (const dep of ordered) {
    const depBots = filtered.filter(x => x.deployment.id === dep.id);
    if (!depBots.length) continue;
    const isCol = collapsed.has(dep.id);
    const tag = dep.local ? '本部署' : (dep.stale ? '远端·离线？' : '远端');
    html += `<div class="tf-grp" data-dep="${escapeHtml(dep.id)}" style="cursor:pointer;margin:10px 0 4px;padding:4px 6px;background:var(--grp-bg,#f6f7f9);border-radius:6px">`
      + `<b>${isCol ? '▸' : '▾'} ${escapeHtml(dep.name)}</b> <span class="muted" style="font-size:12px">（${tag}）· ${depBots.length} 个</span></div>`;
    if (isCol) continue;
    html += '<table style="width:100%;border-collapse:collapse;font-size:14px"><tbody>';
    for (const b of depBots) {
      const app = escapeHtml(b.larkAppId);
      const ck = picked.has(b.larkAppId) ? ' checked' : '';
      const dim = b.deployment.stale ? 'opacity:.55' : '';
      // local bots: editable capability + role; federated: read-only text
      const capCell = b.deployment.local
        ? `<input class="tf-cap" data-app="${app}" value="${escapeHtml(b.capability || '')}" placeholder="能力标签…" style="width:92%;padding:3px 6px">`
        : (b.capability ? escapeHtml(b.capability) : '<span class="muted">—</span>');
      const roleCell = b.deployment.local
        ? `<button class="tf-role" data-app="${app}" data-name="${escapeHtml(b.name)}">${b.hasTeamRole ? '已设·改' : '设置'}</button>`
        : (b.hasTeamRole ? '有角色' : '<span class="muted">—</span>');
      html += `<tr style="${dim}"><td style="padding:4px 8px"><input type="checkbox" class="tf-pick" data-app="${app}"${ck}></td>`
        + `<td style="padding:4px 8px">${escapeHtml(b.name)}</td><td style="padding:4px 8px" class="muted">${escapeHtml(b.cliId)}</td>`
        + `<td style="padding:4px 8px">${capCell}</td><td style="padding:4px 8px">${roleCell}</td></tr>`;
    }
    html += '</tbody></table>';
  }
  el.innerHTML = html || '<p class="muted">没有符合条件的机器人。</p>';
  $('tf-count').textContent = `共 ${filtered.length} / ${rosterBots.length} 个 · 已选 ${picked.size}`;

  el.querySelectorAll<HTMLElement>('.tf-grp').forEach(g => {
    g.onclick = () => { const id = g.dataset.dep!; if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id); renderRoster(); };
  });
  el.querySelectorAll<HTMLInputElement>('.tf-pick').forEach(cb => {
    cb.onchange = () => { if (cb.checked) picked.add(cb.dataset.app!); else picked.delete(cb.dataset.app!); $('tf-count').textContent = `共 ${filtered.length} / ${rosterBots.length} 个 · 已选 ${picked.size}`; };
  });
  el.querySelectorAll<HTMLInputElement>('.tf-cap').forEach(inp => {
    inp.onchange = async () => {
      const app = inp.dataset.app!, val = inp.value;
      await jput('/api/team/local-bots/' + encodeURIComponent(app) + '/capability', { capability: val });
      const bot = rosterBots.find(b => b.larkAppId === app); if (bot) bot.capability = val.trim() || null;
    };
  });
  el.querySelectorAll<HTMLButtonElement>('.tf-role').forEach(btn => { btn.onclick = () => openRoleModal(btn.dataset.app!, btn.dataset.name || ''); });
}

async function openRoleModal(app: string, name: string): Promise<void> {
  const r = await jget('/api/team/local-bots/' + encodeURIComponent(app) + '/role');
  $('tf-modal-title').textContent = '团队角色 · ' + name;
  ($('tf-modal-text') as HTMLTextAreaElement).value = (r.body as any)?.role || '';
  $('tf-modal').dataset.app = app;
  $('tf-modal').style.display = 'flex';
}

async function loadLocal(): Promise<void> {
  const r = await jget('/api/team/local');
  const b = r.body as LocalResp;
  if (!b?.ok) { $('tf-roster').innerHTML = '<p class="muted">加载失败。</p>'; return; }
  $('tf-dep-name').textContent = b.deployment.name;
  ($('tf-roster') as HTMLElement).dataset.hub = b.suggestedHubUrl;
  rosterBots = b.bots || [];
  rosterDeployments = b.deployments || [];
  const remoteCount = rosterDeployments.filter(d => !d.local).length;
  $('tf-roster-meta').textContent = `· ${rosterBots.length} 个机器人 / ${rosterDeployments.length} 个部署${remoteCount ? `（含 ${remoteCount} 个远端）` : ''}`;
  const clis = Array.from(new Set(rosterBots.map(x => x.cliId).filter(Boolean))).sort();
  ($('tf-cli') as HTMLSelectElement).innerHTML = '<option value="">全部 CLI</option>' + clis.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  renderRoster();
}

async function loadRemote(): Promise<void> {
  const r = await jget('/api/team/remote-roster');
  const list = (r.body as any)?.memberships || [];
  const el = $('tf-remote');
  if (!list.length) { el.innerHTML = '<p class="muted">还没加入任何远端团队。用上方「加入别人的团队」粘对方的 Hub 地址 + 邀请码。</p>'; return; }
  el.innerHTML = list.map((m: any) => {
    const status = m.ok ? `<span class="ok">已连接</span>` : `<span class="err">连接失败：${escapeHtml(m.error || '')}</span>`;
    const bots = m.ok && m.roster ? `${m.roster.bots.length} 个机器人 / ${m.roster.deployments.length} 个部署` : '';
    return `<div style="padding:8px 0;border-bottom:1px solid var(--border,#eee)">
      <b>${escapeHtml(m.teamName || m.teamId)}</b> <span class="muted" style="font-size:12px">${escapeHtml(m.hubUrl)}</span> — ${status} <span class="muted">${bots}</span>
      <button class="ghost tf-leave" data-hub="${escapeHtml(m.hubUrl)}" data-team="${escapeHtml(m.teamId)}" style="float:right;font-size:12px">退出</button>
    </div>`;
  }).join('');
  el.querySelectorAll<HTMLButtonElement>('.tf-leave').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('退出该远端团队？将通知对方 Hub 移除你的部署。')) return;
      await jpost('/api/team/leave-remote', { hubUrl: btn.dataset.hub, teamId: btn.dataset.team });
      loadRemote();
    };
  });
}

export function renderTeamFederationPage(root: HTMLElement): void {
  root.innerHTML = pageHtml();
  picked.clear(); collapsed.clear();

  ['tf-search', 'tf-cli', 'tf-fcap', 'tf-frole'].forEach(id => { const el = $(id); el.oninput = renderRoster; el.onchange = renderRoster; });

  $('tf-modal-cancel').onclick = () => { $('tf-modal').style.display = 'none'; };
  $('tf-modal-save').onclick = async () => {
    const app = $('tf-modal').dataset.app!;
    await jput('/api/team/local-bots/' + encodeURIComponent(app) + '/role', { role: ($('tf-modal-text') as HTMLTextAreaElement).value });
    $('tf-modal').style.display = 'none';
    loadLocal();
  };

  $('tf-rename').onclick = async () => {
    const name = prompt('部署名称：', $('tf-dep-name').textContent || '');
    if (!name || !name.trim()) return;
    await jpost('/api/team/rename-deployment', { name: name.trim() });
    loadLocal();
  };

  $('tf-invite').onclick = async () => {
    const r = await jpost('/api/team/local-invite');
    const out = $('tf-invite-out');
    out.style.display = '';
    if ((r.body as any)?.code) {
      const hub = ($('tf-roster') as HTMLElement).dataset.hub || '';
      const code = (r.body as any).code;
      out.innerHTML = `<p class="muted" style="font-size:13px">把下面两项发给<b>别的部署</b>的人，让 ta 在自己 dashboard「团队」页里填（24 小时内、单次有效）：</p>
        <p>Hub 地址：<code>${escapeHtml(hub)}</code></p>
        <p>邀请码：<code style="font-size:16px">${escapeHtml(code)}</code></p>`;
    } else { out.innerHTML = '<span class="err">生成失败。</span>'; }
  };

  $('tf-join').onclick = async () => {
    const hubUrl = ($('tf-hub') as HTMLInputElement).value.trim();
    const inviteCode = ($('tf-code') as HTMLInputElement).value.trim();
    const out = $('tf-join-out');
    out.style.display = '';
    if (!hubUrl || !inviteCode) { out.innerHTML = '<span class="err">请填 Hub 地址和邀请码。</span>'; return; }
    out.innerHTML = '<span class="muted">加入中…</span>';
    const r = await jpost('/api/team/join-remote', { hubUrl, inviteCode });
    if ((r.body as any)?.ok) {
      out.innerHTML = `<span class="ok">已加入「${escapeHtml((r.body as any).teamName || '')}」</span>`;
      ($('tf-code') as HTMLInputElement).value = '';
      loadRemote();
    } else {
      const e = (r.body as any)?.error || r.status;
      const msg = e === 'cannot_join_self' ? '这是你自己的部署，不能加入自己（邀请码要发给别的部署的人用）' : e === 'deployment_already_joined' ? '你的部署已经加入过这个团队了' : e === 'hub_unreachable' ? '连不上对方 Hub（检查地址/网络）' : e === 'hub_timeout' ? '对方 Hub 响应超时' : `加入失败：${e}`;
      out.innerHTML = `<span class="err">${escapeHtml(String(msg))}</span>`;
    }
  };

  $('tf-sync').onclick = async () => { await jpost('/api/team/sync-remote'); loadRemote(); };

  $('tf-grp').onclick = async () => {
    const apps = [...picked];
    const out = $('tf-grp-out');
    out.style.display = '';
    if (!apps.length) { out.innerHTML = '<span class="err">请先勾选至少一个机器人。</span>'; return; }
    const name = ($('tf-grp-name') as HTMLInputElement).value.trim() || '协作群';
    out.innerHTML = '<span class="muted">建群中…</span>';
    const r = await jpost('/api/team/federated-group', { name, larkAppIds: apps });
    const b: any = r.body;
    if (b?.ok && b.chatId) {
      const link = b.shareLink || ('https://applink.feishu.cn/client/chat/open?openChatId=' + encodeURIComponent(b.chatId));
      const invalid = (b.invalidBotIds || []).length ? `<p class="hint err">未能加入的机器人：${escapeHtml((b.invalidBotIds || []).join(', '))}</p>` : '';
      const invOwners = (b.invalidOwnerUnionIds || []).length ? `<p class="hint err">未能拉进群的 owner（${(b.invalidOwnerUnionIds || []).length} 人，可能不在本租户或已离职）</p>` : '';
      const by = b.delegatedTo ? `（由「${escapeHtml(b.delegatedTo)}」部署的机器人建群）` : '';
      out.innerHTML = `<span class="ok">群已创建</span>${by}（已把所选机器人的 owner 一并拉进群） · <a href="${escapeHtml(link)}" target="_blank">在飞书打开</a>${invalid}${invOwners}`;
      loadLocal();
    } else {
      const e = b?.error || r.status;
      const msg = e === 'no_creator_available'
        ? '没有可用的建群发起方：所选机器人所属的部署都没有在线机器人能建群，或对方部署不可达。请确保至少一方有在线机器人。'
        : `建群失败：${e}`;
      out.innerHTML = `<span class="err">${escapeHtml(String(msg))}</span>`;
    }
  };

  void loadLocal();
  void loadRemote();
}
