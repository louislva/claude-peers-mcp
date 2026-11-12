#!/usr/bin/env bun
/**
 * Codex auto-drain poller.
 *
 * Problem: hook-backed peers are dormant between turns. Mail can be queued in
 * the broker while an otherwise healthy idle lane has no reason to run its
 * receive hook.
 *
 * How it works: every POLL_INTERVAL_MS, for each opted-in peer that (a) has
 * unread mail in the broker DB, (b) has a tmux pane, and (c) is IDLE (its pane
 * shows the prompt, not active work), it uses that pane's verified visible PID.
 *
 * The poller is wake-only. It submits a small notification to an exact idle
 * pane. Hook-backed lanes process the attached body; manual-drain lanes call
 * check_messages. The poller never reads, claims, renders, or acknowledges
 * message payloads, so a missed Enter cannot remove mail from the queue.
 *
 * Safety:
 *   - Reconciles visible Codex seats by exact pane registration and, when the
 *     pane status exposes it, an exact broker-side thread identity join.
 *   - Reads candidate unread counts and identity evidence from SQLite read-only.
 *   - Refuses to wake Codex rows without an exact pane seat. Legacy rows without
 *     thread/hook metadata receive an explicit compatibility instruction and log.
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
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { publishBrokerIdentityToTmux } from "../shared/tmux-identity.ts";
import type { BrokerIdentityForTmux } from "../shared/tmux-identity.ts";
import { durableSeatKey } from "../shared/seat.ts";
import { boundedCommand, commandBudgetRemaining, withCommandBudget } from "../shared/bounded-command.ts";
import { readProcessSnapshot } from "../shared/process-snapshot.ts";
import { LiveMailboxGroups, liveGroupPrefix, liveMailboxIdsSql } from "../shared/live-mailbox-groups.ts";
import type { ReconcilePaneThreadResponse, RegisterResponse } from "../shared/types.ts";
import { isVisibleCodexArgs, singleInteractiveCodexProcess } from "../shared/visible-codex.ts";
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
const HEARTBEAT_PATH = process.env.CLAUDE_PEERS_AUTODRAIN_HEARTBEAT ?? process.env.AUTODRAIN_HEARTBEAT ?? `${homedir()}/.claude-peers-autodrain.heartbeat`;
const NUDGE_BUDGET_PATH = process.env.CLAUDE_PEERS_NUDGE_BUDGET_FILE ?? `${homedir()}/.claude-peers-nudge-budget.json`;
// Receive paths can change when the nudge starts a native prompt hook.
// Keep hook classification for transport checks, not wake-content assumptions.
const HOOK_RECEIVE_MODES = new Set(["claude-channel", "codex-hook", "gemini-hook"]);

export function isHookReceivePath(lane: Lane): boolean {
  return HOOK_RECEIVE_MODES.has(lane.receiver_mode);
}

export function nudgeText(_lane: Lane): string {
  // Receive mode can change when this wake triggers the first native hook.
  // Queue emptiness after that hook says nothing about the attached batch.
  return "[peer-mail] Process the attached peer messages. If none are attached, fetch pending mail with check_messages. If the mail needs nothing from the user (an FYI, an acknowledgement, status with no question or decision), handle it and end the turn without a message to the user. Otherwise continue the work.";
}
// Give up nudging a lane after this many consecutive attempts with mail still
// unread — a lane whose drain hook is broken must NOT be keystroke-bombed
// forever. The counter resets to 0 the moment the lane has no unread mail.
const MAX_NUDGE_ATTEMPTS = Number(process.env.MAX_NUDGE_ATTEMPTS ?? 5);

/**
 * How long to wait for the TUI to visibly accept a submitted turn.
 *
 * Bounded on purpose: an unconfirmed submit is not an error state to sit in; the
 * mailbox remains queued and a later tick may retry the wake. Six checks at
 * 0.25s covers a busy TUI without stalling the poll loop for every other lane.
 */
const SUBMIT_CONFIRM_ATTEMPTS = Number(process.env.SUBMIT_CONFIRM_ATTEMPTS ?? 6);
const SUBMIT_CONFIRM_INTERVAL_S = process.env.SUBMIT_CONFIRM_INTERVAL_S ?? "0.25";

/**
 * Settle between pasting and Enter. Must clear Codex 0.146.0's paste-burst
 * window (~120ms measured), inside which an Enter is taken as a newline rather
 * than a submit. Bracketed paste is what actually fixes that race; this margin
 * only covers the tail, and is NOT a substitute for it.
 */
const SUBMIT_SETTLE_S = process.env.SUBMIT_SETTLE_S ?? "0.35";

/**
 * Seconds without keyboard input from an attached client viewing the pane
 * before a wake may be typed into it. Live 2026-10-11: a wake landed while an
 * operator was typing in a Claude seat's pane and split their input around the
 * injected prompt. The idle capture had shown an empty composer a moment
 * before; the operator's next keystrokes arrived between that check and the paste.
 */
const OPERATOR_QUIET_S = Number(process.env.OPERATOR_QUIET_S ?? 10);

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
  stripTail?: RegExp;    // strips client-owned input-box chrome after the typed text
  busy: RegExp[];        // any match => mid-turn => never nudge
  // Optional literal-placeholder escape hatch: some TUIs (Cursor) render the
  // terminal cursor as a reverse-video block ON the placeholder's first char,
  // which breaks the all-dim placeholder detection below (reverse resets dim).
  // When the stripped prompt text matches this, treat as empty input. Safe
  // direction: if the vendor changes the placeholder wording, nudges stop
  // (observable, benign) rather than ever submitting real operator input.
  placeholderText?: RegExp;
  // Optional raw-SGR guard for literal placeholders. OpenCode renders its
  // placeholder in a stable grey but operator text in the normal foreground;
  // requiring both text and style prevents identical typed words from being
  // mistaken for an empty composer.
  placeholderStyle?: RegExp;
  // Set when this client's BUSY vocabulary has never been observed on this host.
  // Idle detection then cannot distinguish "at the prompt" from "mid-turn", so the
  // caller must additionally require the pane to be QUIESCENT (byte-identical
  // across two consecutive ticks) before typing into it. Strictly safer than
  // guessing busy strings: an unknown-but-changing pane is simply never nudged.
  requiresQuiescence?: boolean;
}
const CONFIRMATION_BUSY = [
  /Would you like to run the following command/i,
  /Do you want to proceed/i,
  /Press enter to confirm/i,
  /esc to cancel/i,
];
const CODEX_BUSY = [
  /esc to interrupt/i,
  /\bWorking\b/,
  /\bRunning\b/,
  /Reviewing approval/i,
  /tokens used/i,
  ...CONFIRMATION_BUSY,
];
// Claude busy markers: the animated spinner verbs Claude cycles through mid-turn
// ("Cogitated", "Warping", "Evaporating", … — the set is open, so match the
// shared shape: a spinner verb immediately followed by the "(Ns ·" timer), the
// universal "esc to interrupt" hint, and the "· N tokens" in-flight status row.
const CLAUDE_BUSY = [
  /esc to interrupt/i,
  /\((?:\d+h\s*)?(?:\d+m\s*)?\d+s\s*·/,
  /Press up to edit queued messages/i,
  /·\s*[\d.]+k?\s*tokens/i,
  /\b(Esc to interrupt|Running…|Working…)/i,
  ...CONFIRMATION_BUSY,
];
// Cursor busy markers are provisional (vocabulary not yet observed mid-turn on
// this host): false-busy only delays a nudge, never misfires one.
const CURSOR_BUSY = [
  /esc to interrupt/i,
  /esc to cancel/i,
  /\bGenerating\b/,
  /\bWorking(?:…|\s*\(\d+s\b)/,
  /tokens used/i,
];
const PROFILES: Record<string, IdleProfile> = {
  codex:  { prompt: /(^|\n)\s*›\s/, promptLine: /^\s*›/, strip: /^.*?›\s?/, busy: CODEX_BUSY },
  gemini: { prompt: /(^|\n)\s*›\s/, promptLine: /^\s*›/, strip: /^.*?›\s?/, busy: CODEX_BUSY },
  claude: { prompt: /(^|\n)\s*❯\s/, promptLine: /^\s*❯/, strip: /^.*?❯\s?/, busy: CLAUDE_BUSY },
  // Cursor CLI ("agent"): input box glyph is → (U+2192). Idle placeholders are
  // "Plan, search, build anything" (fresh session) and "Add a follow-up"
  // (mid-conversation). placeholderText carries both because the SGR shapes
  // defeat the generic all-dim check twice over: focused panes reverse-block
  // the placeholder's first char (reset clears dim), and unfocused panes open
  // the dim span BEFORE the glyph so the strip regex swallows it.
  // requiresQuiescence for the same reason kimi has it: CURSOR_BUSY is provisional
  // — those strings were never observed mid-turn on this host. A busy marker that
  // fails to match is the dangerous direction (it nudges INTO a working agent),
  // and no amount of guessing fixes that. Quiescence needs no vocabulary at all.
  cursor: { prompt: /(^|\n)\s*→\s/, promptLine: /^\s*→/, strip: /^.*?→\s?/, busy: CURSOR_BUSY,
            placeholderText: /^(?:Plan, search, build anything|Add a follow-up)$/,
            requiresQuiescence: true },
  // agy / Antigravity CLI: bare ASCII `>` input prompt, but COLUMN-0 anchored.
  // All transcript/output lines are indented at least one space, so do not add
  // leading whitespace to these matchers. Version 1.1.13 can render an empty
  // composer with the literal Accept-edits mode label instead of a dim placeholder.
  // Completed transcript counters contain the word "thinking", so matching it
  // across the whole capture permanently false-busies an idle lane. Require
  // quiescence instead; typed text remains non-placeholder and still blocks.
  agy: { prompt: /(^|\n)>(\s|$)/, promptLine: /^>(\s|$)/,
         // Agy 1.1.19 emits the prompt colour SGR before the glyph. Match only
         // leading SGR sequences plus the already-validated column-zero `>`;
         // preserve every sequence after the glyph for placeholder dim/colour
         // analysis. Without this, the raw-line strip leaves `>` behind and an
         // empty mode placeholder is misclassified as typed operator input.
         strip: /^(?:\x1b\[[0-9;]*m)*>\s?/,
         busy: [/esc to (cancel|interrupt)/i],
         placeholderText: /^Accept-edits mode: file edits auto-approved \(shift\+tab to cycle\)$/i,
         requiresQuiescence: true },
  // kimi (Moonshot's CLI): input is drawn in a rounded box, prompt line is
  // U+2502 + ">" ("│ >"). The busy vocabulary has NOT been observed mid-turn on
  // this host and could not be recovered from the binary, so this profile carries
  // no busy markers and instead demands quiescence. That is why lanes running kimi
  // registered as client_type=unknown had no delivery path at all: polling is
  // disabled for unknown clients and there was no profile to nudge them with, so
  // their mail sat unread in real, live panes.
  kimi: { prompt: /(^|\n)\s*│\s*>/, promptLine: /^\s*│\s*>/, strip: /^.*?│\s*>\s?/,
          busy: [], requiresQuiescence: true },
  // Grok 4.6 draws its input as "│ ❯ ... │". Keep the older bare >/$ forms
  // for compatibility, but strip the box's right border before deciding whether
  // the input is empty. Real typed text remains and therefore still blocks a wake.
  // Busy regex is proven live (Thinking… / Esc:cancel). Do not require quiescence:
  // two unchanged idle ticks at a 15s interval is ~30s, which looks like "no
  // nudger" on grok/manual-drain seats. Match claude/codex: first idle tick may wake.
  grok: { prompt: /(^|\n)(?:\s*│\s*❯\s|\s*[>$]\s)/,
          promptLine: /^(?:\s*│\s*❯|\s*[>$])/,
          strip: /^(?:.*?❯\s?|.*?[>$]\s?)/,
          stripTail: /(?:\x1b\[[0-9;]*m|\s)*│(?:\x1b\[[0-9;]*m|\s)*$/,
          busy: [/esc(?::|\s+to\s+)(cancel|interrupt)/i] },
  // OpenCode 1.18.21 draws one boxed composer with a heavy vertical border.
  // The vendor placeholder wraps at word boundaries as pane width changes, so
  // accept only prefixes ending on those boundaries. Busy vocabulary remains
  // deliberately secondary to the fail-closed quiescence gate.
  opencode: {
    prompt: /(^|\n)\s*┃\s+Ask anything\.\.\./,
    promptLine: /^\s*┃\s+Ask anything\.\.\./,
    strip: /^.*?┃\s*/,
    busy: [
      /esc(?::|\s+to\s+)(?:cancel|interrupt|exit)/i,
      /\bPrompt loading\.\.\./i,
      /\bPermission required\b/i,
      /\bAllow (?:once|always)\b/i,
      /^\s*(?:┃\s*)?Stop(?:\s*┃)?\s*$/im,
    ],
    // OpenCode rotates the quoted example (and may clip it at a pane-width word
    // boundary). The exact 128-grey SGR below is the empty-input signal; keep
    // the text grammar structural so a new vendor example does not strand mail.
    placeholderText: /^Ask anything\.\.\.(?: "[^"\n]*"?)?$/,
    placeholderStyle: /^(?:\x1b\[[0-9;]*m|\s)*\x1b\[38;2;128;128;128m/,
    requiresQuiescence: true,
  },
};
export function profileFor(clientType: string): IdleProfile {
  return PROFILES[clientType] ?? PROFILES.codex!;
}

// Pane content from the previous tick, for the quiescence gate. Keyed by pane id.
const paneQuiescenceCache = new Map<string, string>();

/** Remove only known idle-only repaint counters before comparing pane snapshots. */
export function quiescenceFingerprint(capture: string): string {
  return capture.replace(
    /^(\s*Goal active \()(?:\d+d )?(?:\d+h )?(?:\d+m )?\d+s(\)\s*)$/gm,
    "$1<elapsed>$2",
  );
}

/**
 * True when this pane looks the same as it did last tick.
 *
 * Used for clients whose busy vocabulary is unknown (IdleProfile.requiresQuiescence).
 * A pane that is mid-turn is repainting — a spinner, a token counter, streaming
 * output — so identical consecutive captures are strong evidence nothing is in
 * flight. The first observation is never quiescent (no prior sample to compare),
 * which costs one extra tick of latency and cannot produce a false nudge.
 *
 * Client-agnostic on purpose. Reverse-engineering each TUI's busy strings is what
 * left kimi lanes undeliverable in the first place, and it fails again for every
 * new client; this needs nothing but the pane.
 */
export function paneQuiescent(paneId: string): boolean {
  const { ok, out } = sh(["tmux", "capture-pane", "-p", "-t", paneId, "-S", "-15"]);
  if (!ok) return false;
  const fingerprint = quiescenceFingerprint(out);
  const previous = paneQuiescenceCache.get(paneId);
  paneQuiescenceCache.set(paneId, fingerprint);
  return previous !== undefined && previous === fingerprint;
}

const lastNudge = new Map<string, number>();  // peer id -> epoch ms of last nudge
const nudgeAttempts = new Map<string, number>(); // peer id -> consecutive nudge count
const nudgeEpisode = new Map<string, number>(); // peer id -> broker-authored unread episode
const unreadyCodexWakeWarned = new Set<string>(); // avoid logging the same bad identity every tick
const legacyCodexWakeWarned = new Set<string>(); // compatibility metadata is visible once, without log spam
let nudgeBudgetPersistencePath: string | null = null;
let nudgeBudgetPersistenceHealthy = true;

interface PersistedNudgeBudgetEntry {
  episode: number;
  attempts: number;
  last_nudge_at?: number;
}

interface PersistedNudgeBudget {
  version: 1;
  peers: Record<string, PersistedNudgeBudgetEntry>;
}

function validBudgetEntry(value: unknown): value is PersistedNudgeBudgetEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Number.isSafeInteger(entry.episode) && Number(entry.episode) >= 0
    && Number.isSafeInteger(entry.attempts) && Number(entry.attempts) >= 0
    && (entry.last_nudge_at === undefined
      || (Number.isSafeInteger(entry.last_nudge_at) && Number(entry.last_nudge_at) >= 0));
}

function persistedNudgeBudget(): PersistedNudgeBudget {
  const peers = Object.create(null) as Record<string, PersistedNudgeBudgetEntry>;
  for (const [id, episode] of nudgeEpisode) {
    const attempts = nudgeAttempts.get(id) ?? 0;
    const lastNudgeAt = lastNudge.get(id);
    peers[id] = {
      episode,
      attempts,
      ...(lastNudgeAt === undefined ? {} : { last_nudge_at: lastNudgeAt }),
    };
  }
  return { version: 1, peers };
}

/**
 * Load the durable attempt ledger used by the daemon.
 *
 * A corrupt ledger fails closed: the process stays alive for observability but
 * refuses transport instead of silently minting five fresh attempts. Writes are
 * atomic and happen before each real pane submission, so a service restart
 * cannot replenish one continuous unread episode.
 */
export function loadNudgeBudgetState(path = NUDGE_BUDGET_PATH): boolean {
  nudgeBudgetPersistencePath = path;
  nudgeBudgetPersistenceHealthy = true;
  nextLaneId = null;
  nudgeAttempts.clear();
  nudgeEpisode.clear();
  lastNudge.clear();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root must be an object");
    const root = parsed as Record<string, unknown>;
    if (root.version !== 1 || !root.peers || typeof root.peers !== "object" || Array.isArray(root.peers)) {
      throw new Error("unsupported nudge-budget format");
    }
    for (const [id, value] of Object.entries(root.peers as Record<string, unknown>)) {
      if (!id || !validBudgetEntry(value)) throw new Error(`invalid entry for ${id || "<empty>"}`);
      nudgeEpisode.set(id, value.episode);
      nudgeAttempts.set(id, value.attempts);
      if (value.last_nudge_at !== undefined) lastNudge.set(id, value.last_nudge_at);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // The first installation has no prior budget to preserve. Materialize an
      // empty ledger immediately so every later service restart has durable
      // state; a missing parent or failed bootstrap still fails closed.
      log(`nudge budget ledger absent at ${path} — initializing empty ledger`);
      return persistNudgeBudgetState();
    }
    nudgeBudgetPersistenceHealthy = false;
    log(`nudge budget ledger unreadable at ${path}: ${error instanceof Error ? error.message : String(error)} — transport disabled`);
    return false;
  }
}

function persistNudgeBudgetState(): boolean {
  if (!nudgeBudgetPersistencePath) return true;
  if (!nudgeBudgetPersistenceHealthy) return false;
  const tmp = `${nudgeBudgetPersistencePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let fd: number | null = null;
  let directoryFd: number | null = null;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(persistedNudgeBudget())}\n`);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, nudgeBudgetPersistencePath);
    directoryFd = openSync(dirname(nudgeBudgetPersistencePath), "r");
    fsyncSync(directoryFd);
    closeSync(directoryFd);
    directoryFd = null;
    return true;
  } catch (error) {
    if (fd !== null) try { closeSync(fd); } catch { /* best effort */ }
    if (directoryFd !== null) try { closeSync(directoryFd); } catch { /* best effort */ }
    try { unlinkSync(tmp); } catch { /* best effort */ }
    nudgeBudgetPersistenceHealthy = false;
    log(`nudge budget ledger write failed at ${nudgeBudgetPersistencePath}: ${error instanceof Error ? error.message : String(error)} — transport disabled`);
    return false;
  }
}

export function nudgeBudgetHealthStatus(): "ready" | "degraded" {
  return nudgeBudgetPersistenceHealthy ? "ready" : "degraded";
}
// A lane with no unread mail has nothing to receive, so a nudge could only ever
// cost it a turn. Exported so the final defensive check remains independently
// assertable even though the candidate SQL also excludes empty inboxes.
export function hasNothingToDeliver(unread: number): boolean {
  return unread <= 0;
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
  return boundedCommand(cmd, {
    operation: cmd[0] === "ps" ? "poller-process-snapshot" : "poller-tmux", timeoutMs: 3000,
  });
}

const ANSI_ESCAPE_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const THREAD_UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const THREAD_UUID_SEGMENT_RE = new RegExp(`^${THREAD_UUID_SOURCE}$`, "i");
const TRUNCATED_THREAD_FIRST_STATUS_RE = new RegExp(`^(${THREAD_UUID_SOURCE}) ·\\s*(.*?)…$`, "i");

/**
 * Parse only the final non-empty pane line, where Codex renders configured
 * status-line items. A UUID elsewhere in the transcript is never identity
 * evidence. The managed status line puts thread-id first so a narrow pane
 * cannot spend the visible prefix on a title. Any additional full UUIDs must
 * agree with that first segment.
 */
export function threadIdFromCodexPaneStatus(capture: string): string | null {
  const finalLine = capture
    .replace(ANSI_ESCAPE_RE, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!finalLine) return null;
  const segments = finalLine
    .split(" · ")
    .map((segment) => segment.trim());
  if (!THREAD_UUID_SEGMENT_RE.test(segments[0] ?? "")) return null;
  const threadId = segments[0]!.toLowerCase();
  const matches = new Set(
    segments
      .filter((segment) => THREAD_UUID_SEGMENT_RE.test(segment))
      .map((segment) => segment.toLowerCase()),
  );
  if (matches.size !== 1 || !matches.has(threadId)) return null;

  // On a wide pane the two adjacent context gauges are the renderer signature.
  // Optional status items may disappear, so locate the pair instead of relying
  // on a fixed total segment count.
  const remainingIndex = segments.findIndex((segment) => /^Context \d+% left$/.test(segment));
  if (remainingIndex >= 1 && /^Context \d+% used$/.test(segments[remainingIndex + 1] ?? "")) {
    return threadId;
  }

  // On a narrow pane Codex preserves the configured left edge and terminates
  // the clipped status with an ellipsis. The second managed item is the model,
  // so require at least one non-UUID character from it. This deliberately
  // rejects both an ID-only line and the legacy title-first "UUID · UUID…"
  // shape; a pane too narrow to expose that extra evidence fails closed.
  const truncated = finalLine.match(TRUNCATED_THREAD_FIRST_STATUS_RE);
  if (!truncated) return null;
  const visibleSecondItem = truncated[2]!.trim().split(/\s*·\s*/, 1)[0]!.trim();
  if (!visibleSecondItem || /^[0-9a-f-]+$/i.test(visibleSecondItem)) return null;
  return threadId;
}

/** Reconcile identity only while the real Codex prompt and status row are visible. */
export function threadIdFromIdleCodexPaneCapture(capture: string): string | null {
  if (!paneTextIsIdle(capture, PROFILES.codex!)) return null;
  return threadIdFromCodexPaneStatus(capture);
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

export interface Lane {
  id: string;
  name: string | null;
  pid: number;
  client_type: string;
  tmux_pane_id: string | null;  // empty/null for a bg-claude lane → resolved lazily
  thread_id: string | null;
  seat_key: string | null;
  receiver_mode: string;
  unread: number;
  unread_episode: number;
  last_hook_seen_at: string | null;  // NULL = drain hook has not attached yet
}

export type CodexWakeBlockReason = "no-pane-id" | "no-seat-key" | "seat-pane-mismatch" | "no-thread-id";

/**
 * Why a Codex row cannot safely receive a pane wake. The poller never claims or
 * acknowledges mail. Exact pane-seat ownership prevents typing into the wrong
 * terminal, while a broker-bound thread prevents submitting a turn whose MCP
 * adapter cannot resolve that pane. Unbound Codex rows remain visible but are
 * never nudged; the app-server relay must first publish a successful root
 * thread/start or thread/resume lifecycle response.
 */
export function codexWakeBlockReason(lane: Lane): CodexWakeBlockReason | null {
  if (lane.client_type !== "codex") return null;
  const paneId = lane.tmux_pane_id?.trim();
  const seatKey = lane.seat_key?.trim();
  if (!paneId) return "no-pane-id";
  if (!seatKey) return "no-seat-key";
  if (seatKey !== `pane:${paneId}` && !seatKey.endsWith(`:${paneId}`)) return "seat-pane-mismatch";
  if (!lane.thread_id?.trim()) return "no-thread-id";
  return null;
}

export function codexWakeCompatibilityReasons(lane: Lane): string[] {
  if (lane.client_type !== "codex") return [];
  const reasons: string[] = [];
  if (lane.receiver_mode !== "codex-hook") reasons.push(`receiver-mode=${lane.receiver_mode || "unknown"}`);
  return reasons;
}

export function codexLaneReadyForWake(lane: Lane): boolean {
  return codexWakeBlockReason(lane) === null;
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
// To opt clients in, set NUDGE_CLIENTS, e.g.
//   NUDGE_CLIENTS=codex,claude   (comma-separated allowlisted client names)
// The whole resolution + idle-detection machinery below is kept intact so opting
// a client back in is a one-env-var change, not a code revert.
// Exported + raw-injectable so the parse rules (empty default, allowlist filter,
// dedup, case/space normalization) are unit-testable without mutating process.env.
export function parseNudgeClients(raw: string | undefined = process.env.NUDGE_CLIENTS): string[] {
  if (!raw) return []; // DEFAULT: nudge nobody
  const allowed = new Set(["codex", "gemini", "claude", "cursor", "agy", "kimi", "grok", "opencode"]);
  const picked = raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => allowed.has(s));
  return [...new Set(picked)];
}
const NUDGEABLE_CLIENTS = parseNudgeClients();
function currentNativeMailbox(db: Database, id: string): boolean {
  const current = new LiveMailboxGroups(db).current(id);
  return current?.native.id === id;
}
const correlatedMailboxIdsSql = liveMailboxIdsSql.replace("owner.id=?", "owner.id=p.id");

// A non-targetable row is never woken: CLI identities, live-group aliases, and
// Codex threads gated by pane close or bin/codex-thread-stop. Every broker
// database since storage v2 has the column (validateCurrentSchema requires it);
// the probe only keeps reduced-schema fixture databases readable.
const nonTargetableColumn = new WeakMap<Database, boolean>();
function hasNonTargetableColumn(db: Database): boolean {
  let known = nonTargetableColumn.get(db);
  if (known === undefined) {
    known = (db.query("PRAGMA table_info(peers)").all() as Array<{ name: string }>).some((column) => column.name === "non_targetable");
    nonTargetableColumn.set(db, known);
  }
  return known;
}

export function lanesWithUnread(db: Database, nudgeableClients: string[] = NUDGEABLE_CLIENTS,
  nativeIsCurrent: (id: string) => boolean = id => currentNativeMailbox(db,id)): Lane[] {
  // No nudgeable client types → nothing to nudge. Return empty WITHOUT building a
  // `WHERE ... IN ()` (invalid SQL in SQLite) — and the tick() caller short-circuits
  // before this on the same condition, so this is just a defensive second guard.
  if (nudgeableClients.length === 0) return [];
  const placeholders = nudgeableClients.map(() => "?").join(", ");
  // Candidate selection is fail-closed: only an exact peer/message join over a
  // currently undelivered row can produce a lane. Hook state, pane visibility,
  // and delivered history are never substitutes for real pending mail.
  return (db.query(`
    SELECT p.id, p.name, p.pid, p.client_type, p.tmux_pane_id, p.thread_id,
           p.seat_key, p.receiver_mode, p.last_hook_seen_at, p.unread_episode,
           COUNT(m.id) AS unread
    FROM peers p
    JOIN messages m ON m.to_id IN (${correlatedMailboxIdsSql}) AND m.delivered = 0
    WHERE p.client_type IN (${placeholders})${hasNonTargetableColumn(db) ? `
      AND p.non_targetable = 0` : ""}
    GROUP BY p.id
    HAVING unread > 0
  `).all(...nudgeableClients) as Lane[]).filter(lane => !liveGroupPrefix(lane.seat_key) || nativeIsCurrent(lane.id));
}

/**
 * Re-read the exact recipient mailbox at the final transport boundary.
 *
 * Candidate discovery and pane validation take long enough for a native client
 * hook to drain the mailbox in between. The initial Lane count is therefore
 * evidence for scheduling only; it must never authorize a later keystroke.
 */
export function pendingUnreadForPeer(db: Database, peerId: string,
  nativeIsCurrent: (id: string) => boolean = id => currentNativeMailbox(db,id)): number {
  const peer = db.query("SELECT seat_key FROM peers WHERE id=?").get(peerId) as {seat_key: string|null}|null;
  if (liveGroupPrefix(peer?.seat_key) && !nativeIsCurrent(peerId)) return 0;
  const row = db.query(`
    SELECT COUNT(*) AS unread
    FROM messages
    WHERE to_id IN (${liveMailboxIdsSql}) AND delivered = 0
  `).get(peerId) as { unread?: number } | null;
  const unread = Number(row?.unread ?? 0);
  return Number.isFinite(unread) && unread > 0 ? unread : 0;
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
/**
 * The tmux pane containing `pid`, found by walking its process ancestry until a
 * pane's pane_pid is hit. Returns null when the process is genuinely outside tmux.
 *
 * This is the inverse of paneOwnedByPid: that asks "is this pid under this pane",
 * this asks "which pane is this pid under". Used only as a fallback for lanes whose
 * registration row carries no tmux_pane_id.
 */
export function paneFromPidAncestry(pid: number, snap: TickSnapshot): string | null {
  const ppidMap = new Map<number, number>();
  for (const proc of snap.procs) ppidMap.set(proc.pid, proc.ppid);
  let walk: number | undefined = pid;
  for (let i = 0; i < 20 && walk !== undefined && walk > 1; i++) {
    const pane = snap.paneMap.get(walk);
    if (pane?.pane_id) return pane.pane_id;
    walk = ppidMap.get(walk);
  }
  return null;
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
  const afterGlyph = promptLine
    .replace(profile.strip, "")
    .replace(profile.stripTail ?? /$^/, "");  // keep SGR codes around actual input
  const afterPlain = stripAnsi(afterGlyph).trim();
  if (afterPlain === "") return true;                          // empty input — nudge
  // Clients with a known literal placeholder are fail-closed: only that exact
  // vendor text counts as empty. Cursor can render the previous submitted
  // prompt dim in its composer; falling through to the generic all-dim rule
  // would append a wake to that retained prompt and resubmit both together.
  if (profile.placeholderText) {
    if (!profile.placeholderText.test(afterPlain)) return false;
    return profile.placeholderStyle ? profile.placeholderStyle.test(afterGlyph) : true;
  }
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
// check. Linux scans procfs in a bounded child; other platforms use ps. Built
// fresh each tick so process discovery costs one scan regardless of lane count.
export interface TickSnapshot {
  procs: ProcLike[];
  paneByPid: Map<string, number>;          // pane_id → pane_pid (for paneSubtree)
  paneMap: ReturnType<typeof parseTmuxPanes>;
}
export function takeSnapshot(processSnapshot = readProcessSnapshot): TickSnapshot | null {
  const procs = processSnapshot();
  if (!procs) return null;
  const paneOut = sh(["tmux", "list-panes", "-a", "-F", "#{pane_pid}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_id}\t#{window_panes}"]);
  if (!paneOut.ok) return null;
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

interface VisibleCodexSeatCandidate {
  proc: ProcLike;
  seat: VisibleCodexSeat;
}

function processCommandName(args: string): string {
  return args.trim().split(/\s+/)[0]?.replace(/^.*\//, "") ?? "";
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
  const grouped = new Map<string, VisibleCodexSeatCandidate[]>();

  for (const proc of snap.procs) {
    if (!isVisibleCodexArgs(proc.args, proc.pid)) continue;

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
    const candidate = { proc, seat };
    if (existing) existing.push(candidate);
    else grouped.set(key, [candidate]);
  }

  const seats: VisibleCodexSeat[] = [];
  for (const group of grouped.values()) {
    const selected = singleInteractiveCodexProcess(group.map(({ proc }) => ({
      ...proc,
      comm: processCommandName(proc.args),
    })));
    if (!selected) continue;
    const candidate = group.find(({ proc }) => proc.pid === selected.pid);
    if (!candidate) continue;
    if (group.some(({ seat }) =>
      seat.name !== candidate.seat.name || seat.cwd !== candidate.seat.cwd || seat.tty !== candidate.seat.tty
    )) continue;
    seats.push(candidate.seat);
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

async function postBroker<T>(path: string, body: unknown, peerToken?: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (peerToken) headers["X-Peer-Token"] = peerToken;
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers,
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

type PostBrokerFn = typeof postBroker;
type PublishIdentityFn = typeof publishBrokerIdentityToTmux;

export type BoundCodexSeatIdentity =
  | { kind: "absent" }
  | { kind: "ambiguous" }
  | { kind: "bound"; identity: BrokerIdentityForTmux };

/** Discovery reads routing metadata only; it must not obtain a peer token. */
export function boundCodexSeatIdentity(db: Database, seat: VisibleCodexSeat): BoundCodexSeatIdentity {
  const rows = db.query(`SELECT id, name, resolved_name, client_type, receiver_mode,
      cwd, tmux_session, tmux_pane_id, seat_key FROM peers
    WHERE pid = ? AND tmux_pane_id = ? AND client_type = 'codex'
      AND thread_id IS NOT NULL AND length(thread_id) > 0`)
    .all(seat.pid, seat.tmux.pane_id ?? null) as Array<BrokerIdentityForTmux & {
      cwd: string; tmux_session: string | null; tmux_pane_id: string; seat_key: string | null;
    }>;
  if (rows.length === 0) return { kind: "absent" };
  const row = rows[0]!;
  if (rows.length !== 1 || row.cwd !== seat.cwd || row.tmux_session !== seat.tmux.session
    || row.seat_key !== durableSeatKey(row)) return { kind: "ambiguous" };
  const { id, name, resolved_name, client_type, receiver_mode } = row;
  return { kind: "bound", identity: { id, name, resolved_name, client_type, receiver_mode } };
}

export interface ReconcileVisibleCodexSeatsDeps {
  enabled?: boolean;
  dryRun?: boolean;
  now?: () => number;
  intervalMs?: number;
  visibleSeats?: (snap: TickSnapshot) => VisibleCodexSeat[];
  gitValue?: typeof gitValue;
  postBroker?: PostBrokerFn;
  publishBrokerIdentityToTmux?: PublishIdentityFn;
  threadIdForPane?: (paneId: string) => string | null;
  callerPid?: number;
  boundIdentityForSeat?: (seat: VisibleCodexSeat) => BoundCodexSeatIdentity;
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
    const seats = withCommandBudget(3000, () => (deps.visibleSeats ?? visibleCodexSeatsFromSnapshot)(snap));
    const git = deps.gitValue ?? gitValue;
    const post = deps.postBroker ?? postBroker;
    const publish = deps.publishBrokerIdentityToTmux ?? publishBrokerIdentityToTmux;
    // Production identity never comes from rendered terminal pixels. Tests may
    // inject a reader to exercise the legacy reconciliation seam, but live
    // thread ownership is authored only by the app-server lifecycle relay.
    const readThreadId = deps.threadIdForPane ?? (() => null);
    for (const seat of seats) {
      try {
        if (deps.dryRun ?? DRY_RUN) {
          log(`DRY_RUN would reconcile codex seat ${seat.name} pid=${seat.pid} pane=${seat.tmux.pane_id ?? "?"}`);
          continue;
        }
        const bound = deps.boundIdentityForSeat?.(seat);
        if (bound?.kind === "ambiguous") continue;
        if (bound?.kind === "bound") {
          withCommandBudget(8000, () => publish(bound.identity, seat.tmux));
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
          receiver_mode: "manual-drain",
          preserve_token: true,
          discovery_only: true,
          summary: "",
        });
        withCommandBudget(8000, () => publish(reg, seat.tmux));
        const paneId = seat.tmux.pane_id;
        const threadId = paneId ? readThreadId(paneId) : null;
        if (paneId && threadId) {
          await post<ReconcilePaneThreadResponse>("/reconcile-pane-thread", {
            id: reg.id,
            pid: seat.pid,
            caller_pid: deps.callerPid ?? process.pid,
            tmux_pane_id: paneId,
            thread_id: threadId,
          }, reg.token);
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        if (!error.includes("Codex pane already has a thread binding; discovery must observe it")) {
          log(`codex seat reconcile failed for ${seat.name} pid=${seat.pid} pane=${seat.tmux.pane_id ?? "?"}: ${error}`);
        }
      } finally {
        // Bound synchronous mirror work per seat and let the heartbeat timer
        // run between seats, including the already-bound fast path.
        await Bun.sleep(0);
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
  if (!bgId) {
    // No bg session id — but the lane may still BE in a pane whose id simply never
    // reached its registration row. Cursor does this: its MCP server registers with
    // tty set and tmux fields empty (seat_key falls back to tty:pts/N), so the row
    // says "no pane" while the process sits in one. Without a pane the poller can
    // never nudge, and for a manual-drain client the nudge is the only delivery
    // path — a live cursor lane accumulated 4 unread messages that way.
    //
    // Derive it the same way ownership is checked, just in reverse: walk the lane's
    // ancestry and take the pane whose pane_pid is on that chain.
    const derived = paneFromPidAncestry(lane.pid, snap);
    if (derived) {
      paneCache.set(lane.id, derived);
      return { paneId: derived, attachId: null };
    }
    return { paneId: "", attachId: null };
  }
  if (cached) return { paneId: cached, attachId: bgId };
  const pane = resolveBgAttachPane(bgId, snap.paneMap, snap.procs);
  if (pane?.pane_id) { paneCache.set(lane.id, pane.pane_id); return { paneId: pane.pane_id, attachId: bgId }; }
  return { paneId: "", attachId: null };   // bg session not attached anywhere → no pane to nudge
}

function paneIsInCopyMode(paneId: string): boolean {
  const mode = sh(["tmux", "display-message", "-p", "-t", paneId, "#{pane_in_mode}"]);
  return mode.ok && mode.out.trim() === "1";
}

/**
 * A fragment of the submitted text distinctive enough to spot in a pane capture.
 *
 * Deliberately taken from the FIRST line: the composer wraps long text, but the
 * opening run of characters lands adjacent to the prompt marker where we can
 * recognise it. Whitespace is collapsed because the TUI re-flows what it holds.
 */
/**
 * Deliver text as ONE bracketed paste rather than a burst of literal keystrokes.
 *
 * Root cause of the 2026-08-03 silent loss (diagnosed by infra.7): the poller
 * pushed ~7,932 characters through `tmux send-keys -l`, and Codex 0.146.0 treats
 * an Enter arriving during — or within ~120ms of — a rapid key burst as an
 * inserted NEWLINE, not a submit. The batch was typed, never submitted, and
 * acked anyway. The C-m-vs-Enter spelling was ruled out by probe: both deliver a
 * newline.
 *
 * `load-buffer` + `paste-buffer -p` wraps the payload in bracketed-paste markers,
 * so the TUI sees a single paste event instead of thousands of keypresses, and a
 * subsequent Enter is unambiguous. `-d` drops the buffer afterwards so a large
 * batch is not left in tmux's paste ring.
 *
 * A longer fixed sleep was explicitly rejected as a fix: it makes the race less
 * likely without removing it, and the failure it hides is silent.
 */
function pasteIntoPane(paneId: string, text: string): boolean {
  const name = `claude-peers-drain-${process.pid}-${Date.now()}`;
  const path = join(tmpdir(), `${name}.txt`);
  try {
    writeFileSync(path, text);
    if (!sh(["tmux", "load-buffer", "-b", name, path]).ok) return false;
    return sh(["tmux", "paste-buffer", "-p", "-d", "-b", name, "-t", paneId]).ok;
  } catch (e) {
    log(`paste failed for ${paneId}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  } finally {
    try { unlinkSync(path); } catch { /* best effort */ }
  }
}

export type WakeInputTransport = "literal" | "bracketed-paste";

/**
 * Pick the input event the target TUI actually consumes.
 *
 * Grok 4.6 ignores tmux's bracketed `paste-buffer -p` event entirely: the
 * command exits zero, but its composer remains empty. Wake notifications are
 * deliberately short, so literal keys avoid that incompatibility without
 * reviving the historical multi-kilobyte key-burst race on other clients.
 */
export function wakeInputTransport(clientType: string): WakeInputTransport {
  return clientType === "grok" ? "literal" : "bracketed-paste";
}

function enterWakeText(paneId: string, text: string, clientType: string): boolean {
  if (wakeInputTransport(clientType) === "literal") {
    return sh(["tmux", "send-keys", "-t", paneId, "-l", "--", text]).ok;
  }
  return pasteIntoPane(paneId, text);
}

export function submissionProbe(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 48);
}

/**
 * Is `probe` still sitting in the composer — i.e. typed but NOT submitted?
 *
 * The composer is the region from the last prompt marker to the end of the
 * capture. Text that has been submitted moves up into the transcript, so it
 * still appears in the capture; only its presence BELOW the marker means it is
 * unsent. Checking mere presence would report every successful submit as failed.
 */
export type ComposerSubmissionEvidence = "held" | "submitted" | "unknown";

function regionContainsSubmissionProbe(region: string, probe: string): boolean {
  // `capture-pane` preserves visual wrapping. In a very narrow pane Grok can
  // render one character per line, so whitespace-preserving substring checks
  // cannot recognise the turn. Compare a bounded compact form instead.
  const compactRegion = region.replace(/\s+/g, "");
  const compactHead = probe.slice(0, 24).replace(/\s+/g, "");
  if (!compactHead) return false;
  if (compactRegion.includes(compactHead)) return true;
  // Grok's prompt cell can visually consume the opening `[` at extreme widths.
  // The remaining `peer-mail]...` prefix is still specific to this wake.
  return compactHead.startsWith("[")
    && compactHead.length > 12
    && compactRegion.includes(compactHead.slice(1));
}

/**
 * Classify what the pane positively proves about one attempted submission.
 *
 * Absence is UNKNOWN, never success: Grok can clear a pasted wake without
 * starting a turn, leaving neither composer text nor a transcript echo. The
 * old boolean check treated that disappearance as submission and spent the
 * retry budget on five fictional successes while mail stayed queued.
 */
export function composerSubmissionEvidence(capture: string, probe: string): ComposerSubmissionEvidence {
  if (!probe) return "unknown";
  const lines = capture.split("\n");
  // OpenCode's composer has no prompt glyph. It is the final contiguous block
  // of heavy-border lines immediately above the bottom `╹▀...` edge. Detect a
  // held wake there before the generic glyph parser; after submission the same
  // probe may appear above the composer and must be classified as transcript.
  let opencodeBottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*╹▀+/.test(lines[i] ?? "")) { opencodeBottom = i; break; }
  }
  if (opencodeBottom >= 0) {
    let start = opencodeBottom;
    while (start > 0 && /^\s*┃/.test(lines[start - 1] ?? "")) start--;
    const opencodeComposer = lines.slice(start, opencodeBottom).join("\n");
    if (regionContainsSubmissionProbe(opencodeComposer, probe)) return "held";
  }
  let marker = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    // Match every managed TUI's actual composer, not only Codex/Gemini. A
    // missed marker is a false submit confirmation: the wake can remain typed
    // while the poller records a successful nudge and spends its attempt budget.
    // Modern Grok and Kimi put the prompt inside a left box border.
    if (/^\s*(?:│\s*[>❯]|[›>→❯$])(?:\s|$)/.test(lines[i] ?? "")) { marker = i; break; }
  }
  // Compare on a shortened head: the composer may truncate or re-wrap the tail.
  if (!probe.trim()) return "unknown";
  if (marker === -1) {
    return regionContainsSubmissionProbe(lines.join("\n"), probe) ? "submitted" : "unknown";
  }
  const composer = lines.slice(marker).join("\n");
  if (regionContainsSubmissionProbe(composer, probe)) return "held";
  const transcript = lines.slice(0, marker).join("\n");
  return regionContainsSubmissionProbe(transcript, probe) ? "submitted" : "unknown";
}

export function freshSubmissionObserved(before: string, after: string, probe: string): boolean {
  before = stripAnsi(before);
  after = stripAnsi(after);
  if (composerSubmissionEvidence(after, probe) !== "submitted") return false;
  // Compare the same compact prefix used by the composer classifier. Ignore
  // Grok's occasionally hidden opening bracket consistently in both captures.
  const head = probe.slice(0, 24).replace(/\s+/g, "").replace(/^\[/, "");
  if (!head) return false;
  const count = (capture: string) => capture.replace(/\s+/g, "").split(head).length - 1;
  // A held wake moving into the transcript is new evidence; an old transcript
  // echo surviving an ineffective paste/Enter is not. Scrolled-out evidence
  // remains unconfirmed rather than guessing that a new turn was submitted.
  const priorTranscriptCount = count(before) - Number(composerStillHolds(before, probe));
  return count(after) > priorTranscriptCount;
}

export function composerStillHolds(capture: string, probe: string): boolean {
  return composerSubmissionEvidence(capture, probe) === "held";
}

/**
 * Submit literal text as one turn. False means the wake was not observed.
 *
 * ⚠ tmux's exit code is NOT evidence of submission. `send-keys ... C-m` exits 0
 * once tmux has handed the keystroke to the pane; whether the TUI consumed it as
 * a submit is a separate question. Returning that exit code let the poller ACK
 * mail the model never saw — measured 2026-08-03: messages 14677/14688/14691
 * were stamped delivered_at 10:01:39.143 while the text sat unsubmitted in
 * infra.7's composer until the operator pressed Enter a minute later. Because
 * the ACK had already cleared them from the queue, nothing would have retried:
 * silent LOSS, not delay.
 *
 * Submission is OBSERVED. If the composer does not release the text, we return
 * false and do not count the wake. Mail remains untouched in the broker because
 * this poller has no claim or acknowledgement capability.
 */
/**
 * Did an operator press a key in `paneId` within `quietS` seconds? Reads
 * `tmux list-clients` output formatted as `#{client_activity}\t#{pane_id}`: a
 * client's activity time is its last keyboard or mouse input, and its pane is
 * the active pane of the window it shows. Clients showing other panes do not count.
 */
export function operatorTypedRecently(listClients: string, paneId: string, nowSec: number, quietS = OPERATOR_QUIET_S): boolean {
  for (const line of listClients.split("\n")) {
    const [activity = "", pane = ""] = line.split("\t");
    if (pane.trim() !== paneId) continue;
    const at = activity.trim() === "" ? NaN : Number(activity);
    if (!Number.isFinite(at) || nowSec - at < quietS) return true;   // unreadable time: assume active
  }
  return false;
}

function operatorActive(command: typeof sh, paneId: string, nowSec: number): boolean {
  const clients = command(["tmux", "list-clients", "-F", "#{client_activity}\t#{pane_id}"]);
  // Fail closed: if tmux cannot say who is typing, do not type into the pane.
  return !clients.ok || operatorTypedRecently(clients.out, paneId, nowSec);
}

export function submitPaneText(paneId: string, text: string, clientType: string, deps: {
  command?: typeof sh;
  enterText?: typeof enterWakeText;
  sleep?: (seconds: string) => void;
  nowSec?: () => number;
} = {}): boolean {
  const command = deps.command ?? sh;
  const nowSec = deps.nowSec ?? (() => Date.now() / 1000);
  const enterText = deps.enterText ?? enterWakeText;
  const sleep = deps.sleep ?? ((seconds: string) => { boundedCommand(["sleep", seconds], { operation: "wake-settle" }); });
  const probe = submissionProbe(text);

  // Do NOT re-type if a previous attempt is still sitting in the composer.
  // Confirmed submission means an unconfirmed batch is retried next tick, and
  // re-sending ~8KB each time would stack burst after burst into a composer that
  // is already failing to submit. Re-Enter the text that is already there.
  const before = command(["tmux", "capture-pane", "-p", "-e", "-t", paneId]);
  if (!before.ok) return false;
  const profile = profileFor(clientType);
  if (profile.busy.some((pattern) => pattern.test(stripAnsi(before.out)))) return false;
  const alreadyHeld = composerStillHolds(before.out, probe);
  // Ownership/idle discovery preceded budget persistence. Revalidate the
  // newest capture before writing: the operator or a hook may have acted.
  if (!alreadyHeld && !paneTextIsIdle(before.out, profile)) return false;
  // Never type into a pane an operator is typing in; a later tick retries.
  if (operatorActive(command, paneId, nowSec())) {
    log(`wake deferred for ${paneId}: operator input within ${OPERATOR_QUIET_S}s`);
    return false;
  }
  if (!alreadyHeld && !enterText(paneId, text, clientType)) return false;

  // Settle longer than the TUI's paste-burst window before submitting.
  sleep(SUBMIT_SETTLE_S);
  // Keys pressed while the wake was being entered are now mixed into the
  // composer. Submitting would send the operator's partial input with the wake;
  // leave everything unsent for the operator instead.
  if (operatorActive(command, paneId, nowSec())) {
    log(`wake left unsent in ${paneId}: operator typed while it was entered`);
    return false;
  }
  if (!command(["tmux", "send-keys", "-t", paneId, "Enter"]).ok) return false;

  // Poll rather than sleep once: submission latency varies with what the TUI is
  // doing, and a fixed wait either wastes time or reports a false failure.
  for (let attempt = 0; attempt < SUBMIT_CONFIRM_ATTEMPTS; attempt++) {
    sleep(SUBMIT_CONFIRM_INTERVAL_S);
    const capture = command(["tmux", "capture-pane", "-p", "-t", paneId]);
    if (!capture.ok) return false; // pane vanished — cannot claim delivery
    if (freshSubmissionObserved(before.out, capture.out, probe)) return true;
  }
  log(`wake submit unconfirmed for ${paneId} — no positive transcript evidence; mailbox remains queued`);
  return false;
}

export type WakeOnlyNudgeResult = "submitted" | "submit-failed";

/** Keep one bounded attempt budget for the entire non-zero unread episode. */
export function nudgeAttemptCountAfterUnread(
  current: number | undefined,
  unread: number,
): number | undefined {
  return unread <= 0 ? undefined : current;
}

/** Detect a broker-observed zero-to-nonzero boundary between poller ticks. */
export function unreadEpisodeRestartedBetweenTicks(
  observedEpisode: number,
  currentEpisode: number,
): boolean {
  return currentEpisode !== observedEpisode;
}

export interface WakeOnlyNudgeDeps {
  submit?: (paneId: string, text: string) => boolean;
}

/**
 * Submit only a wake notification. There is intentionally no broker dependency
 * in this seam: the lane's hook owns claim/ack after the notification starts a
 * turn, so a false return can never mutate queued mail.
 */
export function submitWakeOnlyNudge(
  lane: Lane,
  paneId: string,
  deps: WakeOnlyNudgeDeps = {},
): WakeOnlyNudgeResult {
  try {
    const text = nudgeText(lane);
    const submitted = deps.submit
      ? deps.submit(paneId, text)
      : submitPaneText(paneId, text, lane.client_type);
    return submitted
      ? "submitted"
      : "submit-failed";
  } catch {
    return "submit-failed";
  }
}

function nudge(lane: Lane, paneId: string): WakeOnlyNudgeResult {
  return submitWakeOnlyNudge(lane, paneId);
}

export function __resetNudgeBudgetStateForTest(): void {
  nudgeAttempts.clear();
  lastNudge.clear();
  nudgeEpisode.clear();
  nudgeBudgetPersistencePath = null;
  nudgeBudgetPersistenceHealthy = true;
}

export function __nudgeAttemptCountForTest(id: string): number | undefined {
  return nudgeAttempts.get(id);
}

// A tick whose wall-time crosses this fraction of the poll interval is logged as
// a canary: with the per-tick ps snapshot cached, fan-out is bounded mostly by
// the serial 0.3s nudge floor, which stays well under the window until ~30+
// simultaneous idle lanes. If this warns, lane width has grown past the design
// envelope and the nudge loop should be made concurrent (see decision-log).
const TICK_WARN_MS = Math.min(10_000, POLL_INTERVAL_MS * 0.66);

let nextLaneId: string | null = null;

export interface TickDeps {
  nudgeableClients?: string[];
  isPidAlive?: (pid: number) => boolean;
  paneIsIdle?: (paneId: string, profile: IdleProfile) => boolean;
  paneIsInCopyMode?: (paneId: string) => boolean;
  nudgeLane?: (lane: Lane, paneId: string) => WakeOnlyNudgeResult;
  now?: () => number;
}

export function tick(db: Database, snapOverride?: TickSnapshot, deps: TickDeps = {}): void {
  const clock = deps.now ?? Date.now;
  const tickStart = clock();
  const nudgeableClients = deps.nudgeableClients ?? NUDGEABLE_CLIENTS;
  // Auto-nudge disabled (no opted-in client types) → do no work this tick. The loop
  // still runs (heartbeat keeps the watchdog happy) but never touches a pane. This
  // is the steady state by default; opt a client in via NUDGE_CLIENTS to re-enable.
  if (nudgeableClients.length === 0) return;
  let lanes: Lane[];
  try { lanes = lanesWithUnread(db, nudgeableClients); } catch (e) {
    log(`DB read failed: ${e instanceof Error ? e.message : String(e)}`); return;
  }
  // Reconcile attempt state with current mailboxes. The in-memory seam prunes
  // absent lanes; the durable daemon prunes only rows proven to be at zero so a
  // temporary client exclusion, death, or rehydration cannot replenish a cap.
  const active = new Set(lanes.map((l) => l.id));
  let budgetDirty = false;
  // The durable ledger deliberately keeps absent lanes. A lane may be
  // temporarily excluded by client opt-in, die and rehydrate with the same id,
  // or disappear during reconciliation while its queued mailbox survives.
  // Its broker-authored episode changes on a real drain/refill boundary, so the
  // next candidate resets safely without us mistaking absence for zero unread.
  // The legacy in-memory test seam still prunes to retain its old bounded-map
  // behavior when persistence has not been enabled.
  if (!nudgeBudgetPersistencePath) {
    for (const id of nudgeAttempts.keys()) if (!active.has(id)) { nudgeAttempts.delete(id); budgetDirty = true; }
    for (const id of nudgeEpisode.keys()) if (!active.has(id)) { nudgeEpisode.delete(id); budgetDirty = true; }
  } else {
    // Pending messages, not peer-row presence, define a live unread episode.
    // This retains a mailbox while reconciliation temporarily deletes its peer
    // row, but reaps both drained live rows and deleted rows with no queued mail.
    const pendingRecipients = new Set((db.query(`
      SELECT DISTINCT to_id AS id
      FROM messages
      WHERE delivered = 0
      UNION SELECT p.id FROM peers p WHERE EXISTS (
        SELECT 1 FROM messages WHERE delivered=0 AND to_id IN (${correlatedMailboxIdsSql})
      )
    `).all() as Array<{ id: string }>).map(({ id }) => id));
    const budgetIds = new Set([
      ...nudgeAttempts.keys(),
      ...nudgeEpisode.keys(),
      ...lastNudge.keys(),
    ]);
    for (const id of budgetIds) {
      if (pendingRecipients.has(id)) continue;
      if (nudgeAttempts.delete(id)) budgetDirty = true;
      if (nudgeEpisode.delete(id)) budgetDirty = true;
      if (lastNudge.delete(id)) budgetDirty = true;
    }
  }
  // A budget belongs to one continuous non-zero unread episode. New senders and
  // partial drains cannot replenish it; only reaching zero and the broker
  // advancing unread_episode on a later refill starts a fresh future episode.
  for (const lane of lanes) {
    const attempts = nudgeAttemptCountAfterUnread(nudgeAttempts.get(lane.id), lane.unread);
    if (lane.unread <= 0) {
      nudgeAttempts.delete(lane.id);
      nudgeEpisode.delete(lane.id);
      lastNudge.delete(lane.id);
      budgetDirty = true;
      continue;
    }
    if (!nudgeEpisode.has(lane.id)) {
      nudgeEpisode.set(lane.id, lane.unread_episode);
      budgetDirty = true;
    } else if (unreadEpisodeRestartedBetweenTicks(
      nudgeEpisode.get(lane.id)!,
      lane.unread_episode,
    )) {
      nudgeAttempts.delete(lane.id);
      lastNudge.delete(lane.id);
      nudgeEpisode.set(lane.id, lane.unread_episode);
      budgetDirty = true;
      continue;
    }
    if (attempts === undefined) {
      if (nudgeAttempts.delete(lane.id)) budgetDirty = true;
    } else if (nudgeAttempts.get(lane.id) !== attempts) {
      nudgeAttempts.set(lane.id, attempts);
      budgetDirty = true;
    }
  }
  if (!nudgeBudgetPersistencePath) {
    for (const id of lastNudge.keys()) if (!active.has(id)) { lastNudge.delete(id); budgetDirty = true; }
  }
  // Persist pruning/episode transitions before any transport. If persistence is
  // enabled but unavailable, fail closed for this tick rather than forgetting a
  // budget and granting fresh attempts after the next restart.
  if (budgetDirty && !persistNudgeBudgetState()) return;
  for (const id of unreadyCodexWakeWarned) if (!active.has(id)) unreadyCodexWakeWarned.delete(id);
  for (const id of legacyCodexWakeWarned) if (!active.has(id)) legacyCodexWakeWarned.delete(id);
  for (const id of paneCache.keys()) if (!active.has(id)) paneCache.delete(id);
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

  const startIndex = Math.max(0, lanes.findIndex((lane) => lane.id === nextLaneId));
  const orderedLanes = [...lanes.slice(startIndex), ...lanes.slice(0, startIndex)];
  for (let laneIndex = 0; laneIndex < orderedLanes.length; laneIndex++) {
    if (commandBudgetRemaining() <= 0) break;
    const lane = orderedLanes[laneIndex]!;
    // Advance before attempting the lane: one repeatedly slow pane cannot
    // monopolize the next cycle, including when it exhausts this cycle's budget.
    nextLaneId = orderedLanes[(laneIndex + 1) % orderedLanes.length]!.id;
    // Per-lane crash isolation: a throw from any check (e.g. pstree missing,
    // tmux gone) must NOT escape the setInterval callback and kill the daemon.
    // Log it and move to the next lane.
    try {
      if (!(deps.isPidAlive ?? isPidAlive)(lane.pid)) continue; // dead lane — reaper handles it
      const codexBlockReason = codexWakeBlockReason(lane);
      if (codexBlockReason) {
        if (!unreadyCodexWakeWarned.has(lane.id)) {
          unreadyCodexWakeWarned.add(lane.id);
          log(`skip Codex wake for ${lane.name ?? lane.id}: reason=${codexBlockReason} pane=${lane.tmux_pane_id ?? "none"} seat=${lane.seat_key ?? "none"}`);
        }
        continue;
      }
      unreadyCodexWakeWarned.delete(lane.id);
      const compatibilityReasons = codexWakeCompatibilityReasons(lane);
      if (compatibilityReasons.length > 0 && !legacyCodexWakeWarned.has(lane.id)) {
        legacyCodexWakeWarned.add(lane.id);
        log(`compatibility Codex wake for ${lane.name ?? lane.id}: reason=${compatibilityReasons.join(",")} exact-pane-seat=verified; lane hook/manual drain owns claim+ack`);
      } else if (compatibilityReasons.length === 0) {
        legacyCodexWakeWarned.delete(lane.id);
      }
      if ((nudgeAttempts.get(lane.id) ?? 0) >= MAX_NUDGE_ATTEMPTS) {
        // Drain hook likely broken — stop hammering. One warning, then silent
        // until the mailbox drains and the broker advances unread_episode on a
        // later refill.
        if ((nudgeAttempts.get(lane.id) ?? 0) === MAX_NUDGE_ATTEMPTS) {
          log(`giving up on ${lane.name ?? lane.id}: ${MAX_NUDGE_ATTEMPTS} nudges, still ${lane.unread} unread (drain hook stuck?)`);
          nudgeAttempts.set(lane.id, MAX_NUDGE_ATTEMPTS + 1); // mark "warned", stop re-logging
          if (!persistNudgeBudgetState()) return;
        }
        continue;
      }
      // The candidate count is a snapshot. Reject malformed/stale candidates
      // before doing any pane work, then re-read SQLite immediately before the
      // irreversible tmux transport below.
      if (hasNothingToDeliver(lane.unread)) continue;
      const since = clock() - (lastNudge.get(lane.id) ?? 0);
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
      const laneProfile = profileFor(lane.client_type);
      if (!(deps.paneIsIdle ?? paneIsIdle)(paneId, laneProfile)) continue; // busy or has queued input — never disturb
      // Busy vocabulary unknown for this client → require the pane to be unchanged
      // since last tick before typing into it.
      if (laneProfile.requiresQuiescence && !paneQuiescent(paneId)) continue;
      const tag = `${lane.name ?? "?"}/${lane.id} pane=${paneId}`;
      if (DRY_RUN) { log(`DRY_RUN would nudge ${tag} (${lane.unread} unread)`); continue; }
      // A pane sitting in copy-mode (operator wheel-scrolled to read) treats
      // every nudge character as a copy-mode command. It is a safety skip and
      // therefore consumes no attempt.
      if ((deps.paneIsInCopyMode ?? paneIsInCopyMode)(paneId)) {
        log(`skip nudge ${tag} — pane in copy-mode (operator scrolled)`);
        continue;
      }

      // A native UserPromptSubmit/PostToolBatch/Stop hook may have drained the
      // inbox while this tick was resolving ownership and idle state. Never
      // press Enter from the stale discovery snapshot. Use the fresh count in
      // the notification too, so the visible wake cannot overstate the queue.
      const currentUnread = pendingUnreadForPeer(db, lane.id);
      if (hasNothingToDeliver(currentUnread)) continue;
      const currentLane = currentUnread === lane.unread ? lane : { ...lane, unread: currentUnread };

      // Write-ahead reservation: record the attempt and cooldown before tmux.
      // A service restart or crash after submission can never mint another five
      // attempts for the same broker-authored unread episode.
      // Do not burn a persisted attempt if the tick cannot start transport.
      if (commandBudgetRemaining() < 1500) break;
      const reservedAttempts = (nudgeAttempts.get(lane.id) ?? 0) + 1;
      nudgeAttempts.set(lane.id, reservedAttempts);
      lastNudge.set(lane.id, clock());
      if (!persistNudgeBudgetState()) return;
      const result = (deps.nudgeLane ?? nudge)(currentLane, paneId);
      if (result === "submitted") {
        log(`nudged ${lane.name ?? "?"}/${lane.id} pane=${paneId} (${currentUnread} unread, attempt ${reservedAttempts})`);
      } else {
        log(`wake submit unconfirmed for ${lane.name ?? "?"}/${lane.id} pane=${paneId} — attempt ${reservedAttempts} counted, mailbox remains queued`);
      }
      nudgedPanesThisTick.add(paneId);                           // A2: claim the pane for the rest of this tick
    } catch (e) {
      log(`tick: error handling lane ${lane.name ?? lane.id} — ${e instanceof Error ? e.message : String(e)} (continuing)`);
    }
  }

  const elapsed = clock() - tickStart;
  if (elapsed > TICK_WARN_MS) {
    log(`SLOW TICK: ${elapsed}ms over ${lanes.length} lane(s) (warn>${TICK_WARN_MS}ms, interval=${POLL_INTERVAL_MS}ms) — lane width may exceed design envelope`);
  }
}

// Touch the heartbeat file (mtime = "last completed a tick"). Best-effort: a
// write failure must never break the poll loop, so it is caught and logged once.
let heartbeatWriteWarned = false;
export function writeHeartbeat(path = HEARTBEAT_PATH): void {
  try {
    require("node:fs").writeFileSync(
      path,
      `${new Date().toISOString()}\nnudge_budget=${nudgeBudgetHealthStatus()}\n`,
    );
  } catch (e) {
    if (!heartbeatWriteWarned) {
      heartbeatWriteWarned = true;
      log(`heartbeat write failed (${path}): ${e instanceof Error ? e.message : String(e)} — watchdog may false-restart`);
    }
  }
}

// One scheduled iteration: run the tick, then ALWAYS touch the heartbeat — even
// if tick() threw past its own per-lane guards. The try/finally guarantees the
// liveness signal reflects "the loop is still cycling", and an unexpected tick
// throw is logged instead of silently stopping the timer.
function scheduledTick(db: Database): void {
  let snap: TickSnapshot | null = null;
  const started = Date.now();
  const stage = (name: "snapshot" | "wake" | "idle") => {
    try {
      require("node:fs").writeFileSync(`${HEARTBEAT_PATH}.stage`, JSON.stringify({
        stage: name, started_at: new Date(started).toISOString(), elapsed_ms: Date.now() - started,
      }) + "\n");
    } catch { /* Heartbeat write reports persistent filesystem failure. */ }
  };
  try {
    withCommandBudget(8000, () => {
      stage("snapshot");
      snap = takeSnapshot();
      stage("wake");
      if (snap) tick(db, snap);
      else log("tick: snapshot (ps/tmux) failed — skipping this tick");
    });
  } catch (e) {
    log(`tick threw at top level: ${e instanceof Error ? e.message : String(e)} (loop continues)`);
  } finally {
    stage("idle");
    if (Date.now() - started > TICK_WARN_MS) log(`scheduled tick completed elapsed_ms=${Date.now() - started} stage=idle`);
    writeHeartbeat();
  }
  // Start async reconciliation outside the tick's AsyncLocalStorage deadline.
  // Its existing in-flight guard and transport timeouts own its lifetime.
  if (snap) {
    void reconcileVisibleCodexSeats(snap, {
      boundIdentityForSeat: (seat) => boundCodexSeatIdentity(db, seat),
    }).catch((e) => {
      log(`codex seat reconcile threw: ${e instanceof Error ? e.message : String(e)} (loop continues)`);
    });
  }
}

function main(): void {
  const nudgeState = NUDGEABLE_CLIENTS.length
    ? `nudge=${NUDGEABLE_CLIENTS.join(",")}`
    : "nudge=DISABLED (set NUDGE_CLIENTS to enable)";
  log(`starting: db=${DB_PATH} interval=${POLL_INTERVAL_MS}ms cooldown=${NUDGE_COOLDOWN_MS}ms ${nudgeState} heartbeat=${HEARTBEAT_PATH}${DRY_RUN ? " DRY_RUN" : ""}`);
  loadNudgeBudgetState();
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
