#!/usr/bin/env bun
/**
 * Codex auto-drain poller.
 *
 * Problem: Codex/Gemini peers are `manual-drain` — the broker has no push
 * channel to them, so mail sent to an IDLE Codex lane sits unread in the broker
 * until the lane takes a turn (its UserPromptSubmit/SessionStart/Stop drain hook
 * only fires on a turn boundary). The operator had to manually nudge idle Codex
 * lanes. This watchdog automates that nudge.
 *
 * How it works (verified live 2026-06-15): every POLL_INTERVAL_MS, for each
 * Codex/Gemini peer that (a) has unread mail in the broker DB, (b) has a tmux
 * pane, and (c) is IDLE (its pane shows the prompt, not active work), it
 * `tmux send-keys` a benign nudge into the pane. That fires the lane's
 * UserPromptSubmit drain hook, which pulls the mail from the broker and injects
 * it into the Codex context. The poller NEVER drains the broker itself (that
 * would consume the mail without showing it to Codex) — it only DETECTS (a
 * read-only DB count) and NUDGES. The drain stays owned by the hook.
 *
 * Safety:
 *   - Reconciles visible Codex seats by broker /register + /hook-heartbeat-by-pid
 *     only; it never reads, claims, or ACKs peer mail.
 *   - Reads unread count from the SQLite DB read-only (no /poll-by-pid, no drain).
 *   - Only nudges a pane that is IDLE: capture-pane must show the Codex prompt
 *     glyph and NOT a busy marker ("esc to interrupt" / "Working" / "Running").
 *   - Only nudges when the input line is empty (no queued operator text to
 *     accidentally submit).
 *   - Per-pane cooldown so a lane that's slow to drain isn't nudged repeatedly.
 *   - Verifies the pid is alive and the pane still maps to that Codex pid before
 *     sending keys (never types into a pane a different process now owns).
 *
 * Run: bun bin/codex-autodrain-poller.ts   (or as a systemd-user unit)
 * Env: CLAUDE_PEERS_DB (default ~/.claude-peers.db), POLL_INTERVAL_MS (15000),
 *      NUDGE_COOLDOWN_MS (60000), DRY_RUN=1 (log what it WOULD do, send nothing).
 */
import { Database } from "bun:sqlite";
import { readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { publishBrokerIdentityToTmux } from "../shared/tmux-identity.ts";
import type { RegisterResponse } from "../shared/types.ts";
import { isVisibleCodexArgs } from "../shared/visible-codex.ts";
import {
  parseTmuxPanes,
  bgSessionIdFromPtyHostArgs,
  resolveBgAttachPane,
  type ProcLike,
  type TmuxPaneInfo,
} from "../shared/tmux.ts";

// Env parse with validation: a bad value must NOT silently break the daemon.
// Number("") === 0 (a 0ms interval is a spin loop) and Number("abc") === NaN
// (setInterval(NaN) never fires) — both are caught here, falling back to the
// default with a warning rather than a silently-dead or runaway daemon.
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`[codex-autodrain] invalid ${name}="${raw}" — using default ${fallback}ms`);
    return fallback;
  }
  return n;
}

const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${homedir()}/.claude-peers.db`;
const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = envMs("POLL_INTERVAL_MS", 15_000);
const CODEX_SEAT_RECONCILE_INTERVAL_MS = envMs("CODEX_SEAT_RECONCILE_INTERVAL_MS", 30_000);
const CODEX_SEAT_GIT_TIMEOUT_MS = envMs("CODEX_SEAT_GIT_TIMEOUT_MS", 2_000);
const NUDGE_COOLDOWN_MS = envMs("NUDGE_COOLDOWN_MS", 60_000);
const DRY_RUN = process.env.DRY_RUN === "1";
const RECONCILE_CODEX_SEATS = process.env.RECONCILE_CODEX_SEATS !== "0";
// Liveness heartbeat: the END of every tick (success OR caught-error) touches
// this file with the current time. The watchdog (~/bin/ensure-codex-autodrain)
// restarts the poller if this file goes stale — a process that is alive but no
// longer TICKING (the 'silent for 16h' zombie) passes a bare pgrep check but
// fails the freshness check. mtime is the signal; the body is human-readable.
const HEARTBEAT_PATH = process.env.CLAUDE_PEERS_AUTODRAIN_HEARTBEAT ?? `${homedir()}/.claude-peers-autodrain.heartbeat`;
const NUDGE_TEXT = "check your peer inbox and handle any pending messages";
// Give up nudging a lane after this many consecutive attempts with mail still
// unread — a lane whose drain hook is broken must NOT be keystroke-bombed
// forever. The counter resets to 0 the moment the lane has no unread mail.
const MAX_NUDGE_ATTEMPTS = Number(process.env.MAX_NUDGE_ATTEMPTS ?? 5);

// Per-client idle profile. A lane is only nudged when its profile says the pane
// is at an empty/placeholder input prompt and shows no busy marker. The two TUIs
// render differently, so the prompt glyph and the busy vocabulary differ:
//   - Codex / Gemini: prompt glyph U+203A (›); busy = "esc to interrupt", etc.
//   - Claude: prompt glyph U+276F (❯); busy = its own spinner verbs + the
//     "· N tokens" status row Claude prints while a turn is in flight.
// ASCII '>' is never a glyph here — it also matches output lines (markdown
// blockquotes, diff context, heredoc continuations) and would mis-select a
// non-input line as the prompt.
export interface IdleProfile {
  prompt: RegExp;        // matches the line-leading input prompt glyph
  promptLine: RegExp;    // matches a single captured line that IS the prompt line
  strip: RegExp;         // strips up to & incl the glyph (+1 optional space); keeps SGR
  busy: RegExp[];        // any match => mid-turn => never nudge
}
const CODEX_BUSY = [/esc to interrupt/i, /\bWorking\b/, /\bRunning\b/, /Reviewing approval/i, /tokens used/i];
// Claude busy markers: the animated spinner verbs Claude cycles through mid-turn
// ("Cogitated", "Warping", "Evaporating", … — the set is open, so match the
// shared shape: a spinner verb immediately followed by the "(Ns ·" timer), the
// universal "esc to interrupt" hint, and the "· N tokens" in-flight status row.
const CLAUDE_BUSY = [/esc to interrupt/i, /\(\d+s\s*·/, /·\s*[\d.]+k?\s*tokens/i, /\b(Esc to interrupt|Running…|Working…)/i];
const PROFILES: Record<string, IdleProfile> = {
  codex:  { prompt: /(^|\n)\s*›\s/, promptLine: /^\s*›/, strip: /^.*?›\s?/, busy: CODEX_BUSY },
  gemini: { prompt: /(^|\n)\s*›\s/, promptLine: /^\s*›/, strip: /^.*?›\s?/, busy: CODEX_BUSY },
  claude: { prompt: /(^|\n)\s*❯\s/, promptLine: /^\s*❯/, strip: /^.*?❯\s?/, busy: CLAUDE_BUSY },
};
export function profileFor(clientType: string): IdleProfile {
  return PROFILES[clientType] ?? PROFILES.codex!;
}

const lastNudge = new Map<string, number>();  // peer id -> epoch ms of last nudge
const nudgeAttempts = new Map<string, number>(); // peer id -> consecutive nudge count
// A lane selected purely by the NULL-hook bootstrap path (zero unread mail, hook
// never attached) gets ONE bootstrap nudge for the LIFE OF THIS PROCESS — then
// never again from the bootstrap path. This Set is in-memory, so the cap does NOT
// survive a poller restart (a fresh process starts with an empty Set); the restart
// backstops are MAX_NUDGE_ATTEMPTS + the systemd StartLimitBurst, not this Set.
// Without this, a permanently-deaf seat (a registration row whose drain hook never
// binds — e.g. a detached bg-Claude lane) is re-nudged every MAX_NUDGE_ATTEMPTS
// window because nudgeAttempts resets when the lane briefly leaves the set. A
// bootstrap nudge has no mail to deliver, so one attempt to wake the hook is all
// that is ever useful. NOT pruned by the unread-clear sweep (that is what makes it
// a process-lifetime cap rather than a per-window one).
const bootstrapNudged = new Set<string>();       // peer id -> already got its one bootstrap nudge

// A1 nudge-storm guard (pure, exported for unit testing). A zero-mail lane is in
// the nudge set only via the NULL-hook bootstrap path; once it has had its one
// bootstrap nudge, block it (re-nudging a still-deaf lane just bombs the pane). A
// lane carrying real mail (unread > 0) is never blocked by this — the bootstrap cap
// applies only to the zero-mail bootstrap path. tick() calls this with the lane's
// live unread count and `bootstrapNudged.has(lane.id)`.
export function bootstrapCapBlocks(unread: number, alreadyBootstrapNudged: boolean): boolean {
  return unread === 0 && alreadyBootstrapNudged;
}

// A2 nudge-storm guard (pure, exported for unit testing). At most ONE nudge per
// physical pane per tick: when several lanes (a foreground seat + bg-Claude lanes
// whose attach client lives in that pane) resolve to the same pane, the first to
// claim it nudges and the rest are blocked this tick. tick() calls this with the
// resolved paneId and the per-tick `nudgedPanesThisTick` set.
export function paneAlreadyNudgedThisTick(paneId: string, nudgedPanesThisTick: Set<string>): boolean {
  return nudgedPanesThisTick.has(paneId);
}

function log(msg: string): void {
  console.error(`[codex-autodrain] ${new Date().toISOString()} ${msg}`);
}

function sh(cmd: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(cmd);
  return { ok: p.exitCode === 0, out: new TextDecoder().decode(p.stdout) };
}

function cwdOfPid(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function ttyOfPid(pid: number): string | null {
  try {
    const fd0 = readlinkSync(`/proc/${pid}/fd/0`);
    if (fd0.startsWith("/dev/")) return fd0;
  } catch {
    // Fall through to ps, which gives a short tty label when fd/0 is not useful.
  }
  try {
    const tty = sh(["ps", "-o", "tty=", "-p", String(pid)]).out.trim();
    return tty && tty !== "?" && tty !== "??" ? tty : null;
  } catch {
    return null;
  }
}

export function envRecordFromText(text: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const entry of text.split("\0")) {
    const idx = entry.indexOf("=");
    if (idx <= 0) continue;
    env[entry.slice(0, idx)] = entry.slice(idx + 1);
  }
  return env;
}

function environOfPid(pid: number): Record<string, string | undefined> {
  try {
    return envRecordFromText(readFileSync(`/proc/${pid}/environ`, "utf8"));
  } catch {
    return {};
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) {
    return (e as { code?: string }).code === "EPERM"; // alive under another uid
  }
}

interface Lane {
  id: string;
  name: string | null;
  pid: number;
  client_type: string;
  tmux_pane_id: string | null;  // empty/null for a bg-claude lane → resolved lazily
  unread: number;
  last_hook_seen_at: string | null;  // NULL = drain hook never attached (needs bootstrap nudge)
}

// Which client types the poller will auto-nudge. DEFAULT IS EMPTY — no lane is
// auto-woken. Rationale (operator decision 2026-06-18): an auto-nudge types a
// prompt into an idle session, which FORCES a turn. For Claude that is redundant
// (a Claude lane piggyback-drains pending mail on its own next turn via the MCP
// tool-response path, costing no extra turn). For Codex/Gemini it is real delivery
// but it wakes idle autonomous lanes into quota-costing turns to drain mostly
// low-value chatter ("inbox checked, nothing actionable"). Net: auto-nudging an
// idle fleet burns Claude usage + OpenAI quota for little benefit, so it is OFF.
//
// Mail still flows — it is delivered when a lane next takes a turn (piggyback for
// Claude, the lane's own drain hook on its next prompt for Codex/Gemini) or when
// the operator re-engages the lane. Auto-nudge is now opt-in, not automatic.
//
// To opt a client back in for a session, set NUDGE_CLIENTS, e.g.
//   NUDGE_CLIENTS=codex,gemini   (comma-separated; only codex/gemini/claude honored)
// The whole resolution + idle-detection machinery below is kept intact so opting
// a client back in is a one-env-var change, not a code revert.
// Exported + raw-injectable so the parse rules (empty default, allowlist filter,
// dedup, case/space normalization) are unit-testable without mutating process.env.
export function parseNudgeClients(raw: string | undefined = process.env.NUDGE_CLIENTS): string[] {
  if (!raw) return []; // DEFAULT: nudge nobody
  const allowed = new Set(["codex", "gemini", "claude"]);
  const picked = raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => allowed.has(s));
  return [...new Set(picked)];
}
const NUDGEABLE_CLIENTS = parseNudgeClients();
function lanesWithUnread(db: Database): Lane[] {
  // No nudgeable client types → nothing to nudge. Return empty WITHOUT building a
  // `WHERE ... IN ()` (invalid SQL in SQLite) — and the tick() caller short-circuits
  // before this on the same condition, so this is just a defensive second guard.
  if (NUDGEABLE_CLIENTS.length === 0) return [];
  const placeholders = NUDGEABLE_CLIENTS.map(() => "?").join(", ");
  // LEFT JOIN (not JOIN) + the HAVING clause below surface two kinds of lane:
  //   1. lanes with undelivered mail (unread > 0) — the normal case;
  //   2. lanes whose drain hook has NEVER attached (last_hook_seen_at IS NULL)
  //      even at unread=0. Without (2) a freshly-registered seat with a broken/
  //      unattached hook and no mail yet is never nudged, so its hook never
  //      attaches — the chicken-and-egg "deaf fresh seat" bug. One bootstrap
  //      nudge lets the hook bind. Both are bounded by MAX_NUDGE_ATTEMPTS in the
  //      caller, so a permanently-stuck seat is not keystroke-bombed forever.
  return db.query(`
    SELECT p.id, p.name, p.pid, p.client_type, p.tmux_pane_id, p.last_hook_seen_at,
           COUNT(m.id) AS unread
    FROM peers p
    LEFT JOIN messages m ON m.to_id = p.id AND m.delivered = 0
    WHERE p.client_type IN (${placeholders})
    GROUP BY p.id
    HAVING unread > 0 OR p.last_hook_seen_at IS NULL
  `).all(...NUDGEABLE_CLIENTS) as Lane[];
}

// Confirm the pane still belongs to the lane (not a recycled/reused pane), so we
// never type into a pane whose original lane exited and was replaced.
//
// Two ownership shapes, because a bg lane's process topology differs from a
// foreground one:
//   - Foreground / codex / gemini: the lane's pid is the pane_pid OR a descendant
//     of it. Validate by walking the pane subtree for the lane pid.
//   - Background claude: the lane's MCP server is DAEMON-hosted, NOT a descendant
//     of the pane — the pane's legitimate occupant is the `claude attach
//     <sessionId>` client. Validate by requiring that attach client in the pane
//     subtree (the same binding resolveLanePane used to find the pane).
function paneOwnedByPid(paneId: string, pid: number, snap: TickSnapshot): boolean {
  const tree = paneSubtree(paneId, snap);
  if (!tree) return false;
  return tree.panePid === pid || tree.text.includes(`(${pid})`);
}
function paneOwnedByAttachId(paneId: string, sessionId: string, snap: TickSnapshot): boolean {
  const tree = paneSubtree(paneId, snap);
  if (!tree) return false;
  return attachIdInTree(tree.text, sessionId);
}

/**
 * True iff a process-tree text shows a `claude attach <sessionId>` client.
 * Exported for unit testing without a live tmux.
 *
 * paneSubtree synthesizes one line per subtree process as `(pid) <full argv>`,
 * so the attach client appears as `(NNN) claude attach <id>` (or with an
 * absolute exe path, `(NNN) /usr/bin/claude attach <id>`). Anchor on `claude`
 * immediately before `attach` (review #4) — matching resolveBgAttachPane's
 * anchor — so a DIFFERENT tool whose args merely contain `attach <id>` (e.g.
 * `git attach <id>`, a `--attach <id>` flag) can never produce a false
 * ownership match and nudge the wrong pane. The exact-id right boundary
 * (whitespace or line end) stops a longer id sharing the same 8-hex prefix from
 * ghost-matching. sessionId is provably [0-9a-f]{8} (sole producers:
 * CLAUDE_CODE_SESSION_ID prefix + bgSessionIdFromPtyHostArgs) → no regex
 * metacharacter / injection.
 */
export function attachIdInTree(treeText: string, sessionId: string): boolean {
  if (!/^[0-9a-f]{8}$/.test(sessionId)) return false;
  return new RegExp(`(^|\\s|/)claude\\s+attach\\s+${sessionId}(\\s|$)`, "m").test(treeText);
}
export function paneSubtree(paneId: string, snap: TickSnapshot): { panePid: number; text: string } | null {
  // pane_pid + the whole subtree come from the per-tick `ps` snapshot — NO
  // per-lane `pstree -pa` fork. `pstree -pa` is O(all processes) (~3s on a host
  // with ~1700 procs, measured live) and ran once PER LANE, which blew ticks past
  // the 15s interval (SLOW TICK). snap.procs is exactly as fresh as a separate
  // pstree would be (same tick), so we walk DOWN from panePid in-memory instead.
  const panePid = snap.paneByPid.get(paneId);
  if (panePid === undefined) return null;          // pane gone since the snapshot
  // The synthesized `text` reproduces the two shapes the consumers depend on:
  //   - `(pid)` for each subtree pid       (paneOwnedByPid: text.includes(`(${pid})`))
  //   - `<args>` for each subtree process  (attachIdInTree: /attach <id>/ in args)
  // so paneOwnedByPid / attachIdInTree keep working unchanged.
  const lines: string[] = [];
  const childrenOf = snapChildren(snap);
  const queue: number[] = [panePid];
  const seen = new Set<number>();
  while (queue.length) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;                   // cycle guard
    seen.add(pid);
    const proc = snap.procs.find((p) => p.pid === pid);
    lines.push(`(${pid}) ${proc?.args ?? ""}`);
    for (const child of childrenOf.get(pid) ?? []) queue.push(child);
  }
  return { panePid, text: lines.join("\n") };
}

// Per-tick memoized pid → children[] map, built once from snap.procs and reused
// by every paneSubtree walk in the tick (replaces N pstree forks with one O(procs)
// pass). Cached on the snapshot object so it is rebuilt fresh each tick.
const snapChildrenCache = new WeakMap<TickSnapshot, Map<number, number[]>>();
function snapChildren(snap: TickSnapshot): Map<number, number[]> {
  let m = snapChildrenCache.get(snap);
  if (m) return m;
  m = new Map<number, number[]>();
  for (const p of snap.procs) {
    const arr = m.get(p.ppid);
    if (arr) arr.push(p.pid);
    else m.set(p.ppid, [p.pid]);
  }
  snapChildrenCache.set(snap, m);
  return m;
}

// Strip SGR escape sequences to a plain-text view.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Pure idle/empty-input decision over a `tmux capture-pane -e` output (ANSI
 * intact). Exported for unit testing without a live tmux. Returns true only when
 * the lane is idle (no busy marker, prompt glyph present) AND the input line is
 * empty OR holds only a DIM (ESC[2m) placeholder — never bright queued text.
 */
export function paneTextIsIdle(captureWithAnsi: string, profile: IdleProfile = PROFILES.codex!): boolean {
  const plain = stripAnsi(captureWithAnsi);
  if (profile.busy.some((re) => re.test(plain))) return false; // mid-turn
  if (!profile.prompt.test(plain)) return false;               // no idle prompt visible

  // Last line whose stripped form starts with this client's prompt glyph.
  const promptLine = [...captureWithAnsi.split("\n")].reverse()
    .find((l) => profile.promptLine.test(stripAnsi(l))) ?? "";
  if (!promptLine) return false;
  // Strip everything up to and including the client's glyph (and one optional
  // space), keeping SGR codes after it so the dim/bright check below is exact.
  const afterGlyph = promptLine.replace(profile.strip, "");  // keep SGR codes
  const afterPlain = stripAnsi(afterGlyph).trim();
  if (afterPlain === "") return true;                          // empty input — nudge
  // Non-empty: it is a placeholder (safe to nudge) ONLY if the ENTIRE visible
  // text is rendered dim. Merely CONTAINING a dim span is not enough — real
  // bright operator input with a dim ghost-autocomplete suffix or a dim inline
  // @mention (e.g. "deploy to prod\x1b[2muction\x1b[0m") would otherwise be
  // misread as empty and the nudge would SUBMIT the operator's text. We verify
  // dimness by reconstructing only the text that is under an active dim (ESC[2m)
  // SGR state and checking it covers the whole non-space input.
  return everyVisibleCharIsDim(afterGlyph);
}

/**
 * True iff every non-space visible character in an SGR-bearing string is
 * rendered under an active dim (ESC[2m) state. Returns false if any visible
 * char is bright (no dim active) — i.e. there is real, non-placeholder input.
 * Dim is turned on by ESC[2m and cleared by ESC[0m or ESC[22m (and a fresh
 * ESC[<other>m without 2 does not clear dim, per SGR semantics).
 */
export function everyVisibleCharIsDim(s: string): boolean {
  let dim = false;
  let sawVisible = false;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b" && s[i + 1] === "[") {
      const m = /^\x1b\[([0-9;]*)m/.exec(s.slice(i));
      if (m) {
        const codes = m[1]!.split(";").filter((c) => c !== "");
        for (const c of codes.length ? codes : ["0"]) {
          if (c === "2") dim = true;
          else if (c === "0" || c === "22") dim = false;
        }
        i += m[0].length;
        continue;
      }
    }
    const ch = s[i]!;
    if (ch.trim() !== "") {           // a visible, non-space char
      sawVisible = true;
      if (!dim) return false;          // a bright visible char => real input
    }
    i++;
  }
  return sawVisible;                    // all visible chars were dim (placeholder)
}

function paneIsIdle(paneId: string, profile: IdleProfile): boolean {
  // Capture WITH escape sequences (-e) so paneTextIsIdle can read SGR colors.
  const { ok, out } = sh(["tmux", "capture-pane", "-p", "-e", "-t", paneId, "-S", "-15"]);
  if (!ok) return false;
  return paneTextIsIdle(out, profile);
}

// One process snapshot per tick, shared across every lane's resolution + ownership
// check. A `ps -ww` is ~0.5s on a loaded host; doing it per-lane made a 12-lane
// fan-out tick ~12s (83% of the poll window). Snapshotting once drops the whole
// tick's resolution cost to a single ps regardless of lane count. Built fresh each
// tick (cheap relative to the interval) so it never goes stale within a tick.
export interface TickSnapshot {
  procs: ProcLike[];
  paneByPid: Map<string, number>;          // pane_id → pane_pid (for paneSubtree)
  paneMap: ReturnType<typeof parseTmuxPanes>;
}
export function takeSnapshot(): TickSnapshot | null {
  const psOut = sh(["ps", "-eo", "pid=,ppid=,args="]);
  const paneOut = sh(["tmux", "list-panes", "-a", "-F", "#{pane_pid}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_id}"]);
  if (!psOut.ok || !paneOut.ok) return null;
  const procs: ProcLike[] = [];
  for (const line of psOut.out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]! });
  }
  const paneMap = parseTmuxPanes(paneOut.out);
  const paneByPid = new Map<string, number>();
  for (const [panePid, info] of paneMap) if (info.pane_id) paneByPid.set(info.pane_id, panePid);
  return { procs, paneByPid, paneMap };
}

export interface VisibleCodexSeat {
  pid: number;
  cwd: string;
  tty: string | null;
  name: string;
  tmux: TmuxPaneInfo;
}

export interface VisibleCodexSeatReaders {
  environOf?: (pid: number) => Record<string, string | undefined>;
  cwdOf?: (pid: number) => string | null;
  ttyOf?: (pid: number) => string | null;
}

export function tmuxInfoByPaneId(snap: TickSnapshot, paneId: string): TmuxPaneInfo | null {
  for (const info of snap.paneMap.values()) {
    if (info.pane_id === paneId) return info;
  }
  return null;
}

export function visibleCodexSeatsFromSnapshot(
  snap: TickSnapshot,
  readers: VisibleCodexSeatReaders = {},
): VisibleCodexSeat[] {
  const envReader = readers.environOf ?? environOfPid;
  const cwdReader = readers.cwdOf ?? cwdOfPid;
  const ttyReader = readers.ttyOf ?? ttyOfPid;
  const grouped = new Map<string, VisibleCodexSeat[]>();

  for (const proc of snap.procs) {
    if (!isVisibleCodexArgs(proc.args)) continue;

    const env = envReader(proc.pid);
    const name = env.CLAUDE_PEER_NAME?.trim();
    const paneId = env.TMUX_PANE?.trim();
    if (!name || !paneId?.startsWith("%")) continue;

    const tmux = tmuxInfoByPaneId(snap, paneId);
    if (!tmux) continue;
    if (!paneOwnedByPid(paneId, proc.pid, snap)) continue;

    const cwd = env.PWD?.startsWith("/") ? env.PWD : cwdReader(proc.pid);
    if (!cwd) continue;

    const seat: VisibleCodexSeat = {
      pid: proc.pid,
      cwd,
      tty: ttyReader(proc.pid),
      name,
      tmux,
    };
    const key = tmux.pane_id ?? paneId;
    const existing = grouped.get(key);
    if (existing) existing.push(seat);
    else grouped.set(key, [seat]);
  }

  const seats: VisibleCodexSeat[] = [];
  for (const group of grouped.values()) {
    if (group.length === 1) seats.push(group[0]!);
  }
  return seats.sort((a, b) => a.pid - b.pid);
}

interface GitProbeProcess {
  stdout: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(signal?: string | number): void;
}

type GitProbeSpawner = (cmd: string[], options: {
  cwd: string;
  stdout: "pipe";
  stderr: "ignore";
}) => GitProbeProcess;

export async function gitValue(
  cwd: string,
  args: string[],
  timeoutMs = CODEX_SEAT_GIT_TIMEOUT_MS,
  spawnGit: GitProbeSpawner = (cmd, options) => Bun.spawn(cmd, options) as GitProbeProcess,
): Promise<string | null> {
  let proc: GitProbeProcess | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    proc = spawnGit(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const value = (async () => {
      const text = proc?.stdout ? await new Response(proc.stdout).text() : "";
      return await proc!.exited === 0 ? text.trim() : null;
    })().catch(() => null);
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        try {
          proc?.kill("SIGKILL");
        } catch {
          // Best-effort kill; returning null releases the reconcile in-flight guard.
        }
        resolve(null);
      }, timeoutMs);
    });
    return await Promise.race([value, timeout]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function postBroker<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = typeof json === "object" && json && "error" in json ? String((json as { error: unknown }).error) : res.statusText;
    throw new Error(`${path} ${res.status}: ${err}`);
  }
  return json as T;
}

let lastCodexSeatReconcileAt = 0;
let codexSeatReconcileInFlight = false;

type PostBrokerFn = <T>(path: string, body: unknown) => Promise<T>;
type PublishIdentityFn = typeof publishBrokerIdentityToTmux;

export interface ReconcileVisibleCodexSeatsDeps {
  enabled?: boolean;
  dryRun?: boolean;
  now?: () => number;
  intervalMs?: number;
  visibleSeats?: (snap: TickSnapshot) => VisibleCodexSeat[];
  gitValue?: typeof gitValue;
  postBroker?: PostBrokerFn;
  publishBrokerIdentityToTmux?: PublishIdentityFn;
}

export function __resetCodexSeatReconcileStateForTest(): void {
  lastCodexSeatReconcileAt = 0;
  codexSeatReconcileInFlight = false;
}

export async function reconcileVisibleCodexSeats(snap: TickSnapshot, deps: ReconcileVisibleCodexSeatsDeps = {}): Promise<void> {
  if (!(deps.enabled ?? RECONCILE_CODEX_SEATS)) return;
  if (codexSeatReconcileInFlight) return;
  const now = deps.now?.() ?? Date.now();
  const intervalMs = deps.intervalMs ?? CODEX_SEAT_RECONCILE_INTERVAL_MS;
  if (now - lastCodexSeatReconcileAt < intervalMs) return;
  lastCodexSeatReconcileAt = now;
  codexSeatReconcileInFlight = true;

  try {
    const seats = (deps.visibleSeats ?? visibleCodexSeatsFromSnapshot)(snap);
    const git = deps.gitValue ?? gitValue;
    const post = deps.postBroker ?? postBroker;
    const publish = deps.publishBrokerIdentityToTmux ?? publishBrokerIdentityToTmux;
    for (const seat of seats) {
      try {
        if (deps.dryRun ?? DRY_RUN) {
          log(`DRY_RUN would reconcile codex seat ${seat.name} pid=${seat.pid} pane=${seat.tmux.pane_id ?? "?"}`);
          continue;
        }
        const gitRoot = await git(seat.cwd, ["rev-parse", "--show-toplevel"]);
        const bare = await git(seat.cwd, ["rev-parse", "--is-bare-repository"]);
        const absoluteGitDir = bare === "true" ? null : await git(seat.cwd, ["rev-parse", "--absolute-git-dir"]);
        const reg = await post<RegisterResponse>("/register", {
          pid: seat.pid,
          cwd: seat.cwd,
          git_root: gitRoot,
          absolute_git_dir: absoluteGitDir,
          tty: seat.tty,
          name: seat.name,
          tmux_session: seat.tmux.session,
          tmux_window_index: seat.tmux.window_index ?? null,
          tmux_window_name: seat.tmux.window_name ?? null,
          tmux_pane_id: seat.tmux.pane_id ?? null,
          client_type: "codex",
          receiver_mode: "codex-hook",
          preserve_token: true,
          summary: "",
        });
        publish(reg, seat.tmux);
        await post("/hook-heartbeat-by-pid", {
          pid: seat.pid,
          caller_pid: process.pid,
          client_type: "codex",
          receiver_mode: "codex-hook",
          status: "ok",
          drained: 0,
        });
        publish({
          ...reg,
          client_type: "codex",
          receiver_mode: "codex-hook",
        }, seat.tmux);
      } catch (e) {
        log(`codex seat reconcile failed for ${seat.name} pid=${seat.pid} pane=${seat.tmux.pane_id ?? "?"}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    codexSeatReconcileInFlight = false;
  }
}

// Memoized lane-id → pane-id. A bg-claude lane's session→pane mapping is stable
// for the life of the attach (changes only on re-attach), so we resolve it once
// and reuse. Only bg-claude lanes are cached (resolveLanePane writes here only on
// the bg-attach path), so the cache self-invalidates via paneOwnedByAttachId():
// it runs before every nudge and a stale entry (re-attached elsewhere → the old
// pane no longer runs `attach <id>`) fails that check, which deletes the entry
// and drops the lane back to re-resolution next tick.
const paneCache = new Map<string, string>();   // peer id → pane id

// Resolve a lane's pane. Codex/gemini register WITH a pane → return it directly.
// A claude bg lane registers with an empty pane → resolve lazily: find its bg
// session id from the MCP-server process ancestry, then locate the tmux pane
// whose subtree runs `claude attach <id>` (resolveBgAttachPane). Returns "" when
// a bg lane has no live attach client (truly detached → unreachable by design).
//
// Session-id source matters: a bg session hosted on a pre-warm SPARE slot has a
// pty-host `.sock` basename = the SPARE id (e.g. fdf1dffd), which is NOT the
// promoted session id the `claude attach <id>` client uses (e.g. 719595a7).
// resolveBgAttachPane keys on the attach id, so the spare id never matches. The
// reliable id is in the MCP server process's OWN environ: CLAUDE_CODE_SESSION_ID
// (8-hex prefix) == the attach id, for both spare- and pty-hosted bg sessions
// (verified live 2026-06-15). We read environ first and only fall back to the
// ancestry `.sock` walk if environ is unreadable.
/**
 * Parse the 8-hex session id from a NUL-separated /proc/<pid>/environ blob.
 * Exported as a pure function for unit testing without /proc. Returns the
 * CLAUDE_CODE_SESSION_ID prefix (== the `claude attach <id>` token) or null.
 */
export function sessionIdFromEnvironText(environ: string): string | null {
  for (const kv of environ.split("\0")) {
    if (kv.startsWith("CLAUDE_CODE_SESSION_ID=")) {
      const m = kv.slice("CLAUDE_CODE_SESSION_ID=".length).match(/^([0-9a-f]{8})/);
      if (m) return m[1]!;
    }
  }
  return null;
}
function sessionIdFromEnviron(pid: number): string | null {
  try {
    return sessionIdFromEnvironText(require("node:fs").readFileSync(`/proc/${pid}/environ`, "utf8"));
  } catch { /* /proc unreadable (not Linux, perms, race) → caller falls back */ return null; }
}

// Resolution result: the pane to nudge, plus the bg session id IF the pane was
// resolved via the bg-attach path (null for a directly-registered pane). The
// tick uses attachId to pick the correct ownership check — a bg lane's MCP
// server is NOT in its pane subtree, so the lane-pid check would wrongly reject.
export interface ResolvedPane { paneId: string; attachId: string | null; }
// `readEnviron` is injectable ONLY so the environ-first / .sock-fallback ordering
// and the attachId branch selection can be unit-tested without /proc or live tmux
// (the two bugs fixed in 6039612 lived in this ordering + the tick's ownership
// ternary, not in the leaf matchers). Production always uses the real reader.
export function resolveLanePane(
  lane: Lane,
  snap: TickSnapshot,
  readEnviron: (pid: number) => string | null = sessionIdFromEnviron,
): ResolvedPane {
  if (lane.tmux_pane_id) return { paneId: lane.tmux_pane_id, attachId: null }; // codex/gemini/attached
  const cached = paneCache.get(lane.id);
  // Primary: the promoted session id from the MCP server's environ (correct for
  // spare-hosted bg sessions). Fallback: walk ancestry for the pty-host `.sock`
  // id (correct only for pty-hosted, but harmless to try when environ is absent).
  let bgId: string | null = readEnviron(lane.pid);
  if (!bgId) {
    const ppidMap = new Map<number, number>();
    for (const p of snap.procs) ppidMap.set(p.pid, p.ppid);
    let walk: number | undefined = lane.pid;
    for (let i = 0; i < 20 && walk !== undefined; i++) {
      const info = snap.procs.find((p) => p.pid === walk);
      if (info) { bgId = bgSessionIdFromPtyHostArgs(info.args); if (bgId) break; }
      const parent = ppidMap.get(walk);
      if (parent === undefined || parent <= 1 || parent === walk) break;
      walk = parent;
    }
  }
  if (!bgId) return { paneId: "", attachId: null };
  if (cached) return { paneId: cached, attachId: bgId };
  const pane = resolveBgAttachPane(bgId, snap.paneMap, snap.procs);
  if (pane?.pane_id) { paneCache.set(lane.id, pane.pane_id); return { paneId: pane.pane_id, attachId: bgId }; }
  return { paneId: "", attachId: null };   // bg session not attached anywhere → no pane to nudge
}

function nudge(lane: Lane, paneId: string): void {
  const tag = `${lane.name ?? "?"}/${lane.id} pane=${paneId}`;
  if (DRY_RUN) { log(`DRY_RUN would nudge ${tag} (${lane.unread} unread)`); return; }
  // Type the literal prompt text then submit, with a short settle BETWEEN the
  // two so the Codex TUI commits the typed input before the Enter arrives — a
  // C-m that races ahead of the not-yet-committed text is dropped (verified
  // live). `-l` sends NUDGE_TEXT literally (no key-name interpretation); the
  // settle is the reliability fix; C-m is the submit (the Codex TUI ignores the
  // "Enter" key-name but submits on C-m). We do NOT re-capture to "verify"
  // submission: after submit the TUI echoes the prompt into its transcript, so a
  // capture can't distinguish "still in input" from "submitted + shown in
  // scrollback" — and a stuck row is already bounded by MAX_NUDGE_ATTEMPTS.
  const sent = sh(["tmux", "send-keys", "-l", "-t", paneId, NUDGE_TEXT]);
  if (!sent.ok) { log(`nudge send-keys failed for ${tag} — pane gone? skipping`); return; }
  Bun.spawnSync(["sleep", "0.3"]); // let the TUI commit the typed text before Enter
  const submitted = sh(["tmux", "send-keys", "-t", paneId, "C-m"]);
  if (!submitted.ok) {
    // Text typed but the C-m submit failed (pane vanished in the 0.3s settle). The
    // keystroke was never delivered as a turn, so this nudge did NOT happen: do not
    // burn the A1 lifetime bootstrap cap or the attempt budget on it. Next tick
    // re-evaluates the lane cleanly. (Gating the cap on submit success is what makes
    // A1 safe — a one-shot cap must only be consumed by a nudge that actually fired.)
    log(`nudge C-m submit failed for ${tag} — pane gone after type? not counting`);
    return;
  }
  lastNudge.set(lane.id, Date.now());
  nudgeAttempts.set(lane.id, (nudgeAttempts.get(lane.id) ?? 0) + 1);
  // A zero-mail nudge is a bootstrap (hook-wake) nudge — record it so the lane is
  // never bootstrap-nudged again (A1 lifetime cap). A real-mail nudge does NOT set
  // this, so a lane that later receives actual mail still nudges normally.
  if (lane.unread === 0) bootstrapNudged.add(lane.id);
  log(`nudged ${tag} (${lane.unread} unread, attempt ${nudgeAttempts.get(lane.id)})`);
}

// A tick whose wall-time crosses this fraction of the poll interval is logged as
// a canary: with the per-tick ps snapshot cached, fan-out is bounded mostly by
// the serial 0.3s nudge floor, which stays well under the window until ~30+
// simultaneous idle lanes. If this warns, lane width has grown past the design
// envelope and the nudge loop should be made concurrent (see decision-log).
const TICK_WARN_MS = Math.min(10_000, POLL_INTERVAL_MS * 0.66);

function tick(db: Database, snapOverride?: TickSnapshot): void {
  const tickStart = Date.now();
  // Auto-nudge disabled (no opted-in client types) → do no work this tick. The loop
  // still runs (heartbeat keeps the watchdog happy) but never touches a pane. This
  // is the steady state by default; opt a client in via NUDGE_CLIENTS to re-enable.
  if (NUDGEABLE_CLIENTS.length === 0) return;
  let lanes: Lane[];
  try { lanes = lanesWithUnread(db); } catch (e) {
    log(`DB read failed: ${e instanceof Error ? e.message : String(e)}`); return;
  }
  // Prune per-lane state for lanes that no longer have unread mail: reset their
  // attempt counter (so a future stuck episode starts fresh) AND bound all maps
  // to current lanes so they cannot grow unbounded over a multi-day run.
  const active = new Set(lanes.map((l) => l.id));
  for (const id of nudgeAttempts.keys()) if (!active.has(id)) nudgeAttempts.delete(id);
  for (const id of lastNudge.keys()) if (!active.has(id)) lastNudge.delete(id);
  for (const id of paneCache.keys()) if (!active.has(id)) paneCache.delete(id);
  // bootstrapNudged is pruned ONLY when the lane leaves the set entirely (session
  // gone / hook finally attached → no longer NULL-hook). It is deliberately NOT
  // pruned on the unread-clear path above — that retention is what enforces the A1
  // lifetime cap. Pruning here keeps the Set bounded over a multi-day run.
  for (const id of bootstrapNudged) if (!active.has(id)) bootstrapNudged.delete(id);

  if (lanes.length === 0) return;

  // A2: at most ONE nudge per physical pane per tick. Multiple lanes can resolve
  // to the same pane — a foreground seat and one or more bg-Claude lanes whose
  // attach client lives in that pane all map to it. Nudging once per lane would
  // keystroke-bomb that single pane N times per cycle. Track panes already nudged
  // this tick and skip any later lane that lands on one.
  const nudgedPanesThisTick = new Set<string>();

  // ONE process+pane snapshot for the whole tick — shared across every lane's
  // pane resolution and ownership check (see takeSnapshot). Without this the
  // per-lane `ps -ww` made a 12-lane tick ~12s; with it the tick's resolution
  // cost is a single ps regardless of lane count.
  const snap = snapOverride ?? takeSnapshot();
  if (!snap) { log("tick: snapshot (ps/tmux) failed — skipping this tick"); return; }

  for (const lane of lanes) {
    // Per-lane crash isolation: a throw from any check (e.g. pstree missing,
    // tmux gone) must NOT escape the setInterval callback and kill the daemon.
    // Log it and move to the next lane.
    try {
      if (!isPidAlive(lane.pid)) continue;                       // dead lane — reaper handles it
      if ((nudgeAttempts.get(lane.id) ?? 0) >= MAX_NUDGE_ATTEMPTS) {
        // Drain hook likely broken — stop hammering. One warning, then silent
        // until the lane's unread clears (which resets the counter via the prune
        // above) or it drops out of the lane set.
        if ((nudgeAttempts.get(lane.id) ?? 0) === MAX_NUDGE_ATTEMPTS) {
          log(`giving up on ${lane.name ?? lane.id}: ${MAX_NUDGE_ATTEMPTS} nudges, still ${lane.unread} unread (drain hook stuck?)`);
          nudgeAttempts.set(lane.id, MAX_NUDGE_ATTEMPTS + 1); // mark "warned", stop re-logging
        }
        continue;
      }
      // A1: a zero-mail lane is here only via the NULL-hook bootstrap path. Nudge
      // it AT MOST ONCE in this process lifetime — one keystroke to try to wake an
      // unattached drain hook is all that is ever useful (there is no mail to
      // deliver). A lane that is still here after its bootstrap nudge has a hook
      // that did not bind; re-nudging it just bombs the pane. (A lane that later
      // gets real mail has unread > 0 and bypasses this guard entirely.)
      if (bootstrapCapBlocks(lane.unread, bootstrapNudged.has(lane.id))) continue;
      const since = Date.now() - (lastNudge.get(lane.id) ?? 0);
      if (since < NUDGE_COOLDOWN_MS) continue;                   // recently nudged — give it time to drain
      const { paneId, attachId } = resolveLanePane(lane, snap);
      if (!paneId) continue;                                     // bg lane not attached anywhere → unreachable, skip
      // A2: this pane was already nudged this tick by an earlier lane (a foreground
      // seat + bg lanes can all resolve to the same pane). One nudge per pane per
      // cycle — skip without consuming this lane's cooldown/attempt budget so it is
      // re-evaluated cleanly next tick if it is still the rightful occupant.
      if (paneAlreadyNudgedThisTick(paneId, nudgedPanesThisTick)) continue;
      // Ownership: bg lane → require its attach client in the pane subtree (its
      // MCP server is daemon-hosted, not under the pane). Else → lane pid in subtree.
      const owned = attachId ? paneOwnedByAttachId(paneId, attachId, snap) : paneOwnedByPid(paneId, lane.pid, snap);
      if (!owned) { paneCache.delete(lane.id); continue; }       // pane gone/reused → drop cache
      if (!paneIsIdle(paneId, profileFor(lane.client_type))) continue; // busy or has queued input — never disturb
      nudge(lane, paneId);
      nudgedPanesThisTick.add(paneId);                           // A2: claim the pane for the rest of this tick
    } catch (e) {
      log(`tick: error handling lane ${lane.name ?? lane.id} — ${e instanceof Error ? e.message : String(e)} (continuing)`);
    }
  }

  const elapsed = Date.now() - tickStart;
  if (elapsed > TICK_WARN_MS) {
    log(`SLOW TICK: ${elapsed}ms over ${lanes.length} lane(s) (warn>${TICK_WARN_MS}ms, interval=${POLL_INTERVAL_MS}ms) — lane width may exceed design envelope`);
  }
}

// Touch the heartbeat file (mtime = "last completed a tick"). Best-effort: a
// write failure must never break the poll loop, so it is caught and logged once.
let heartbeatWriteWarned = false;
export function writeHeartbeat(): void {
  try {
    require("node:fs").writeFileSync(HEARTBEAT_PATH, `${new Date().toISOString()}\n`);
  } catch (e) {
    if (!heartbeatWriteWarned) {
      heartbeatWriteWarned = true;
      log(`heartbeat write failed (${HEARTBEAT_PATH}): ${e instanceof Error ? e.message : String(e)} — watchdog may false-restart`);
    }
  }
}

// One scheduled iteration: run the tick, then ALWAYS touch the heartbeat — even
// if tick() threw past its own per-lane guards. The try/finally guarantees the
// liveness signal reflects "the loop is still cycling", and an unexpected tick
// throw is logged instead of silently stopping the timer.
function scheduledTick(db: Database): void {
  try {
    const snap = takeSnapshot();
    if (snap) {
      void reconcileVisibleCodexSeats(snap).catch((e) => {
        log(`codex seat reconcile threw: ${e instanceof Error ? e.message : String(e)} (loop continues)`);
      });
      tick(db, snap);
    } else {
      tick(db);
    }
  } catch (e) {
    log(`tick threw at top level: ${e instanceof Error ? e.message : String(e)} (loop continues)`);
  } finally {
    writeHeartbeat();
  }
}

function main(): void {
  const nudgeState = NUDGEABLE_CLIENTS.length
    ? `nudge=${NUDGEABLE_CLIENTS.join(",")}`
    : "nudge=DISABLED (set NUDGE_CLIENTS to enable)";
  log(`starting: db=${DB_PATH} interval=${POLL_INTERVAL_MS}ms cooldown=${NUDGE_COOLDOWN_MS}ms ${nudgeState} heartbeat=${HEARTBEAT_PATH}${DRY_RUN ? " DRY_RUN" : ""}`);
  // A stray unhandled rejection must NOT kill the process (which would strand the
  // watchdog with a dead poller that never writes its heartbeat — though the
  // watchdog would then restart it; logging here makes the cause visible).
  process.on("unhandledRejection", (reason) => {
    log(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  // Write the heartbeat IMMEDIATELY at startup, before the first tick — not only
  // in scheduledTick's finally. The first tick can be slow (the very SLOW-TICK
  // case this poller guards against), and the watchdog must see a fresh heartbeat
  // within its stale window from the moment we start, so a slow first tick is
  // never mistaken for a wedge.
  writeHeartbeat();
  const db = new Database(DB_PATH, { readonly: true });
  scheduledTick(db);
  setInterval(() => scheduledTick(db), POLL_INTERVAL_MS);
}

// Run the daemon only when executed directly — importing this module (e.g. from
// a unit test of paneTextIsIdle) must NOT start the poll loop.
if (import.meta.main) main();
