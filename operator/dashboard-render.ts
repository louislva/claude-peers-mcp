/**
 * Read-only human dashboard rendering (open item 6). Pure functions so the
 * escaping and grouping rules are unit-tested. Everything agent-authored is
 * rendered as inert, escaped text: no HTML, links, images or previews.
 */

export interface DashMessage {
  id: number; from_id: string; to_id: string; text: string; sent_at: string;
  offer_count: number; delivered: number; acknowledged_at: string | null;
  reply_to: number | null; root_id: number | null; hop: number;
  woken_at: number | null; wake_attempts: number; wake_error: string | null;
}
export interface DashPeer { id: string; online: number; harness?: string | null; wake_policy?: string; wake_choice?: string | null; dnd_until?: number; summary: string; last_seen: string }
export interface DashAttempt { id: number; peer_id: string; message_ids: string; status: string; claimed_at: number; finished_at: number | null; error: string | null }
export interface DashProblem { message_id: number; from_id: string; to_id: string; reason: string; detail?: string }

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));

/** Conversations: by root_id (reply chains); legacy rows without a root group by participant pair. */
export function groupThreads(messages: DashMessage[]): { key: string; messages: DashMessage[] }[] {
  const groups = new Map<string, DashMessage[]>();
  for (const m of messages) {
    const key = m.root_id !== null ? `root:${m.root_id}` : `pair:${[m.from_id, m.to_id].sort().join("↔")}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return [...groups.entries()]
    .map(([key, ms]) => ({ key, messages: ms.sort((a, b) => a.id - b.id) }))
    .sort((a, b) => b.messages.at(-1)!.id - a.messages.at(-1)!.id);
}

/** Receipt and wake are independent tracks (Astra R1.1): never merged into one "progress" state. */
export function receiptTrack(m: DashMessage): string {
  if (m.delivered) return "acked";
  if (m.offer_count > 0) return `offered×${m.offer_count}`;
  return "queued";
}
export function wakeTrack(m: DashMessage): string {
  if (m.woken_at) return `rung (${m.wake_attempts} attempt${m.wake_attempts === 1 ? "" : "s"})`;
  if (m.wake_attempts > 0) return m.wake_error ? `failed ×${m.wake_attempts}` : `claimed ×${m.wake_attempts}`;
  return "—";
}

const time = (iso: string) => { try { return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return iso; } };
const msTime = (ms: number | null) => ms ? time(new Date(ms).toISOString()) : "—";

export function renderPage(d: { messages: DashMessage[]; peers: DashPeer[]; attempts: DashAttempt[]; problems: DashProblem[]; filter: { peer?: string; root?: string }; generatedAt: string }): string {
  const name = (id: string) => {
    const p = d.peers.find(x => x.id === id);
    return p?.summary ? `${id.slice(0, 8)} · ${p.summary.slice(0, 40)}` : id;
  };
  let threads = groupThreads(d.messages);
  if (d.filter.peer) threads = threads.filter(t => t.messages.some(m => m.from_id === d.filter.peer || m.to_id === d.filter.peer));
  if (d.filter.root) threads = threads.filter(t => t.key === `root:${d.filter.root}`);

  const attention = d.problems.length
    ? `<ul>${d.problems.map(p => `<li><b>#${p.message_id}</b> ${esc(name(p.from_id))} → ${esc(name(p.to_id))}: <code>${esc(p.reason)}</code>${p.detail ? ` — ${esc(p.detail)}` : ""}</li>`).join("")}</ul>`
    : `<p class="ok">Every recent message has arrived or is on its way.</p>`;

  const roster = `<table><tr><th>peer</th><th>online</th><th>wake</th><th>last seen</th></tr>${d.peers
    .filter(p => p.online || p.wake_policy === "on")
    .map(p => `<tr><td><a href="?peer=${encodeURIComponent(p.id)}">${esc(p.id)}</a><br><small>${esc(p.summary.slice(0, 80))}</small></td><td>${p.online ? "●" : "○"}</td><td>${p.wake_policy === "on" ? `on (${esc(p.harness ?? "?")})` : p.wake_choice === "off" ? "opted out" : "off"}${p.dnd_until && p.dnd_until > Date.parse(d.generatedAt) ? " · DND" : ""}</td><td>${esc(time(p.last_seen))}</td></tr>`).join("")}</table>`;

  const threadHtml = threads.slice(0, 60).map(t => `
    <details ${t.messages.at(-1)!.delivered ? "" : "open"}>
      <summary>${esc(t.key.startsWith("root:") ? `conversation #${t.key.slice(5)}` : t.key.slice(5))} · ${t.messages.length} msg · last ${esc(time(t.messages.at(-1)!.sent_at))}</summary>
      ${t.messages.map(m => `
        <div class="msg">
          <div class="meta">#${m.id}${m.reply_to ? ` ↩ #${m.reply_to}` : ""} · ${esc(name(m.from_id))} → ${esc(name(m.to_id))} · ${esc(time(m.sent_at))}
            <span class="track">receipt: <b>${esc(receiptTrack(m))}</b></span> <span class="track">wake: <b>${esc(wakeTrack(m))}</b></span></div>
          <pre>${esc(m.text)}</pre>
        </div>`).join("")}
    </details>`).join("");

  const attempts = `<table><tr><th>#</th><th>peer</th><th>messages</th><th>status</th><th>claimed</th><th>error</th></tr>${d.attempts.slice(0, 30)
    .map(a => `<tr><td>${a.id}</td><td>${esc(a.peer_id)}</td><td>${esc(a.message_ids)}</td><td>${esc(a.status)}</td><td>${esc(msTime(a.claimed_at))}</td><td>${esc((a.error ?? "").slice(0, 120))}</td></tr>`).join("")}</table>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15"><title>claude-peers switchboard</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#6b6a65;--line:#e4e1d8;--card:#fff;--warn:#9a3412;--ok:#166534}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--muted:#9c9a92;--line:#2c2b28;--card:#1f1f1d;--warn:#fb923c;--ok:#4ade80}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:18px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 8px}
small,.meta{color:var(--muted)}.ok{color:var(--ok)}
section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin:10px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}
details{border-bottom:1px solid var(--line);padding:6px 0}summary{cursor:pointer;font-weight:600}
.msg{margin:8px 0 8px 12px;padding-left:10px;border-left:2px solid var(--line)}
pre{white-space:pre-wrap;word-break:break-word;margin:4px 0;font:13px/1.4 ui-monospace,Menlo,monospace}
.track{margin-left:8px}#attn li{color:var(--warn)}a{color:inherit}
</style></head><body><main>
<h1>claude-peers switchboard</h1><small>read-only · refreshes every 15s · generated ${esc(time(d.generatedAt))}${d.filter.peer || d.filter.root ? ` · filtered — <a href="?">clear</a>` : ""}</small>
<h2>Needs attention</h2><section id="attn">${attention}</section>
<h2>Conversations</h2><section>${threadHtml || "<p>No messages in this window.</p>"}</section>
<h2>On the board</h2><section>${roster}</section>
<h2>Recent wake attempts</h2><section>${attempts}</section>
</main></body></html>`;
}
