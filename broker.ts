#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, renameSync, chmodSync, statSync, existsSync, truncateSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
// L6: top-level node:fs import (was inline require() in verifyPidUid hot path).
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  SetSummaryRequest,
  SetNameRequest,
  BroadcastRequest,
  ListPeersRequest,
  SendMessageRequest,
  SendMessageResponse,
  SendToPeerRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  AckMessagesRequest,
  ClaimByPidRequest,
  ClaimByPidResponse,
  AckByPidRequest,
  HookHeartbeatByPidRequest,
  ClientType,
  ReceiverMode,
  Peer,
  PeerSelector,
  PeerTarget,
  PeerResolveErrorCode,
  Message,
} from "./shared/types.ts";
// #7 narrow (2026-05-14): predicate + TTL constant extracted to shared/
// so tests can import the real symbol without spawning broker.ts (which
// has top-level Bun.serve at line ~930 — module import would conflict
// on port 7899). Full broker.ts module-extraction is a separate larger
// follow-up; this narrow extraction unlocks load-bearing test mirrors
// for the reap predicate without touching the broker's startup shape.
import { isReapable, deadSeatMailExpired, shouldRotateLog, PEER_GHOST_AFTER_MS } from "./shared/reaper.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
// S1 + M4: bind to 127.0.0.1 literal so the post-bind assertion below can
// compare against a fixed string. The HOST_OVERRIDE env vars are NOT honoured
// for the actual bind — they only exist to fail-loud if someone sets them
// expecting a non-loopback bind. Allowed loopback aliases are documented for
// the operator but ignored at the bind layer (always 127.0.0.1).
const HOSTNAME = "127.0.0.1";
const LOOPBACK_ALIASES = new Set(["127.0.0.1", "localhost", "::1"]);
const HOST_OVERRIDE = process.env.CLAUDE_PEERS_HOST ?? process.env.CLAUDE_PEERS_HOSTNAME;
if (HOST_OVERRIDE && !LOOPBACK_ALIASES.has(HOST_OVERRIDE)) {
  console.error(`[claude-peers broker] FATAL: refusing non-loopback bind (${HOST_OVERRIDE}). Phase-1 spec requires 127.0.0.1.`);
  process.exit(2);
}
if (PORT < 1 || PORT > 65535 || Number.isNaN(PORT)) {
  console.error(`[claude-peers broker] FATAL: invalid port ${PORT}`);
  process.exit(2);
}

// --- S5: limits ---
const MAX_MSG_BYTES = 32 * 1024;       // 32 KB per message body
const MAX_SUMMARY_BYTES = 1024;        // 1 KB per summary
const MAX_NAME_BYTES = 128;            // 128 B per peer name
const MAX_REQ_BYTES = 64 * 1024;       // 64 KB per HTTP request body
const RATE_WINDOW_MS = 60_000;         // 1-minute rolling window
const RATE_MAX_MSGS = 60;              // max messages sent per peer per window
const RATE_MAX_REQS = 600;             // max broker requests per peer per window (10/s avg)
const MAX_BROADCAST_TARGETS = RATE_MAX_MSGS; // hard cap = 60 — ties fanout to per-minute msg quota
const CLAIM_TTL_MS = 30_000;
const CLAIM_MAX_MESSAGES = 25;
const CLAIM_MAX_BYTES = 64 * 1024;
const BROKER_VERSION = "0.1.0";
const BROKER_CAPABILITIES = {
  hookDrain: {
    pollByPid: true,
    claimByPid: true,
    ackByPid: true,
    hookHeartbeatByPid: true,
  },
  bridge: {
    messagesSinceId: true,
  },
  delivery: {
    sendToPeer: true,
  },
} as const;

// --- S7: ghost reaping ---
// PEER_GHOST_AFTER_MS now imported from ./shared/reaper.ts (#7 narrow).

// --- AP-063: bridge auth ---
// File-backed bridge token for the Mission Control Hub bridge daemon.
// Re-minted on every broker startup; daemon re-reads on EBADTOKEN.
// Loopback-only bind means filesystem ACLs (chmod 0600) are the auth boundary.
const BRIDGE_TOKEN_FILE = process.env.CLAUDE_PEERS_BRIDGE_TOKEN_FILE ?? `${process.env.HOME}/.claude-peers-bridge.token`;
const BRIDGE_RATE_KEY = "__bridge__";  // dedicated rate-limit bucket

// --- Rehydration: when a peer dies and re-launches in the same tmux pane,
// inherit its ID so orphaned mail (addressed to the old ID) surfaces. Window
// is (last_seen age) < REHYDRATE_WINDOW_MS AND PID no longer alive.
const REHYDRATE_WINDOW_MS = 3600_000;  // 1h
// Parse a POSITIVE-millisecond env override, falling back to `def` for any value
// that isn't a finite number > 0. A bare `parseInt(...) || def` does NOT catch a
// NEGATIVE override (negatives are truthy), and a negative TTL makes the purge
// cutoff land in the FUTURE → `delivered_at < cutoff` matches every row → a full
// history wipe from one fat-fingered env var. This rejects <= 0 and NaN, logs the
// rejection (no silent swallow of an explicit operator value), and keeps ONE
// default literal (no string-vs-numeric drift hazard).
function positiveEnvMs(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) return n;
  console.error(`[broker] invalid ${name}="${raw}" (must be a positive integer ms) — using default ${def}`);
  return def;
}
// TTL ceiling on preserving a DEAD seat that still holds undelivered mail. Past
// this, the row + its stranded mail are reaped instead of kept forever (the
// mutual-protection leak: reaper won't drop a row with mail, orphan-sweep won't
// drop mail whose to_id still has a row). Default 24h; a session gone a full day
// isn't returning to inherit. Floored at REHYDRATE_WINDOW_MS so a seat is always
// inheritable for >= the rehydrate window. Env-overridable.
const DEAD_MAIL_TTL_MS = positiveEnvMs("CLAUDE_PEERS_DEAD_MAIL_TTL_MS", 86_400_000);
// TTL on DELIVERED messages. delivered=1 rows are otherwise never purged (they
// only ever get marked, never deleted) → unbounded DB growth. Default 7 days of
// retained history (audit/debug), then swept on the periodic reaper tick.
const DELIVERED_MSG_TTL_MS = positiveEnvMs("CLAUDE_PEERS_DELIVERED_MSG_TTL_MS", 604_800_000);
// TTL on UNDELIVERED messages to a peer with NO resolved receive path
// (receiver_mode='unknown' — a send-only or misregistered client like a one-way
// bridge). Such a peer can heartbeat (so its row never goes stale and the reaper
// never reaps it) yet never drain, trapping mail forever: the orphan sweep skips
// it (its to_id IS a live row), the dead-seat TTL skips it (the seat is alive),
// and the delivered TTL skips it (the row is delivered=0). This is the only bound
// on that mail. Gated on receiver_mode='unknown' so a real but merely-idle
// Claude/Codex/Gemini peer NEVER loses mail — real clients resolve receiver_mode
// within seconds of their first hook/drain, far inside this window. Default 7d.
const UNDELIVERED_MSG_TTL_MS = positiveEnvMs("CLAUDE_PEERS_UNDELIVERED_MSG_TTL_MS", 604_800_000);
// Cap the broker's OWN log file. The register hook rotates on register; this
// bounds it on the periodic reaper tick too, so the log can't grow unbounded
// during a flood with no new registrations (how it reached 24MB on 2026-06-19).
const BROKER_LOG_MAX_BYTES = 10 * 1024 * 1024; // 10MB (mirrors the register hook)
const BROKER_LOG_PATH = `${process.env.HOME}/.claude-peers-broker.log`;
const MY_UID = process.getuid?.() ?? -1;

// M3: warn loudly if we can't enforce S3 (non-Linux dev environment).
if (MY_UID < 0) {
  console.error("[claude-peers broker] WARN: process.getuid() unavailable — S3 PID/UID validation is DISABLED on this platform. Production deployments MUST be Linux.");
}

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// --- Idempotent schema migrations (F1+F2) ---
const migrationColumns = [
  { name: "name", type: "TEXT" },
  { name: "tmux_session", type: "TEXT" },
  { name: "tmux_window_index", type: "TEXT" },
  { name: "tmux_window_name", type: "TEXT" },
  { name: "tmux_pane_id", type: "TEXT" },
  // S2: per-peer auth token issued at /register
  { name: "token", type: "TEXT" },
  { name: "resolved_name", type: "TEXT" },
  { name: "absolute_git_dir", type: "TEXT" },
  { name: "client_type", type: "TEXT NOT NULL DEFAULT 'unknown'" },
  { name: "receiver_mode", type: "TEXT NOT NULL DEFAULT 'unknown'" },
  { name: "last_hook_seen_at", type: "TEXT" },
  { name: "last_drain_at", type: "TEXT" },
  { name: "last_drain_error", type: "TEXT" },
];
for (const col of migrationColumns) {
  try {
    db.run(`ALTER TABLE peers ADD COLUMN ${col.name} ${col.type}`);
  } catch (e) {
    // ONLY swallow "duplicate column name" errors (the idempotent re-run case).
    // Disk full, permission denied, corruption, etc. should crash loudly so the
    // broker doesn't silently start with a half-migrated schema.
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("duplicate column name")) {
      throw e;
    }
  }
}

// One-time compatibility backfill for rows written before name/resolved_name
// split. Old brokers stored broker-deduped values like codex.2#4 directly in
// `name`; restore `name` to the operator label and preserve the old value as
// `resolved_name`. Only strip labels ending in .N#M so legitimate custom names
// containing # are left alone.
const backfillPeerIdentity = db.prepare(`
  UPDATE peers SET name = ?, resolved_name = ? WHERE id = ?
`);
for (const row of db.query("SELECT id, name, resolved_name FROM peers WHERE name IS NOT NULL").all() as { id: string; name: string; resolved_name: string | null }[]) {
  const resolved = row.resolved_name ?? row.name;
  const operatorMatch = row.name.match(/^(.+\.[0-9]+)#[0-9]+$/);
  const operatorName = operatorMatch ? operatorMatch[1]! : row.name;
  if (operatorName !== row.name || row.resolved_name === null) {
    backfillPeerIdentity.run(operatorName, resolved, row.id);
  }
}

// Messages-table migrations: delivered_at populated by /ack-messages, used
// to compute queue→deliver latency for the idle-peer delivery investigation.
const messageMigrationColumns = [
  { name: "delivered_at", type: "TEXT" },
  { name: "claimed_by", type: "TEXT" },
  { name: "claimed_at", type: "TEXT" },
];
for (const col of messageMigrationColumns) {
  try {
    db.run(`ALTER TABLE messages ADD COLUMN ${col.name} ${col.type}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("duplicate column name")) {
      throw e;
    }
  }
}

// Periodic stale-peer sweep. D2 (2026-05-14): collapsed to a thin delegate
// over liveAndFreshPeers (the single source of truth for the reap predicate
// + side effects). Previously cleanStalePeers and liveAndFreshPeers carried
// duplicate predicates that could drift; the D2 refactor (per bmad-code-review
// Code Simplifier Option B) moved the undelivered-messages cleanup into
// liveAndFreshPeers so both call sites reach the same end state.
//
// The discard return is intentional — the side effects (DELETE rows, DELETE
// undelivered messages, bucket cleanup) are what the periodic sweep needs;
// the returned "live" list is unused here.
function cleanStalePeers() {
  // Per-mechanism crash isolation. The three mechanisms below (peer reap /
  // orphan+delivered mail purge / log rotation) are independent — a throw in one
  // must not abort the others on this tick, nor recur into starving them on every
  // future tick. A poison row that makes liveAndFreshPeers throw would otherwise
  // permanently disable the mail purge and log cap. Each stage catches its own
  // throw and logs once-per-failure (the rate is bounded by the 30s tick).
  // rotateBrokerLogIfLarge is already self-guarding (its own try/catch), so it is
  // not re-wrapped here.
  try {
    liveAndFreshPeers(selectAllPeers.all() as Peer[]);
  } catch (e) {
    if (!reapStageWarned) {
      reapStageWarned = true;
      console.error(`[broker] peer-reap stage failed (sweep continues): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  try {
    // Orphan-mail backstop: delete undelivered messages whose target peer row no
    // longer exists. liveAndFreshPeers cleans a peer's mail at the moment it
    // reaps the ROW, but mail can outlive its peer by other paths (a re-register
    // that assigned a new id and abandoned the old row, a crash between delete
    // and cleanup). Without this sweep those rows live forever — unbounded
    // messages-table growth. Bounded, indexed by to_id; runs on the same 30s tick.
    const orphaned = db.run("DELETE FROM messages WHERE delivered = 0 AND to_id NOT IN (SELECT id FROM peers)");
    if (orphaned.changes > 0) {
      console.error(`[broker] orphan-mail sweep: removed ${orphaned.changes} undelivered message(s) with no live peer`);
    }
    // Delivered-mail TTL: delivered=1 rows are only ever marked, never deleted, so
    // they accumulate forever (unbounded DB growth). Purge delivered mail older than
    // DELIVERED_MSG_TTL_MS — keeps a window of history for audit/debug, then drops it.
    const cutoffIso = new Date(Date.now() - DELIVERED_MSG_TTL_MS).toISOString();
    const purged = db.run("DELETE FROM messages WHERE delivered = 1 AND delivered_at IS NOT NULL AND delivered_at < ?", [cutoffIso]);
    if (purged.changes > 0) {
      console.error(`[broker] delivered-mail TTL: purged ${purged.changes} delivered message(s) older than ${DELIVERED_MSG_TTL_MS}ms`);
    }
    // Undelivered-mail TTL for no-receive-path peers: a peer with
    // receiver_mode='unknown' (send-only / misregistered, e.g. a one-way bridge)
    // heartbeats but never drains → its mail is bounded by nothing else here. Cap
    // it by absolute age, scoped to receiver_mode='unknown' so a real idle peer is
    // never affected. See UNDELIVERED_MSG_TTL_MS for the full leak rationale.
    const undelivCutoff = new Date(Date.now() - UNDELIVERED_MSG_TTL_MS).toISOString();
    const staleUndeliv = db.run(
      `DELETE FROM messages WHERE delivered = 0 AND sent_at < ?
         AND to_id IN (SELECT id FROM peers WHERE receiver_mode = 'unknown')`,
      [undelivCutoff],
    );
    if (staleUndeliv.changes > 0) {
      console.error(`[broker] undelivered-mail TTL: dropped ${staleUndeliv.changes} message(s) older than ${UNDELIVERED_MSG_TTL_MS}ms to non-draining peer(s)`);
    }
  } catch (e) {
    if (!mailPurgeStageWarned) {
      mailPurgeStageWarned = true;
      console.error(`[broker] mail-purge stage failed (sweep continues): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  rotateBrokerLogIfLarge();
}
// Once-per-failure latches for the two sweep stages (mirrors brokerLogRotateWarned).
// Bounded by the 30s tick; reset only on broker restart. Keeps a recurring poison
// row from flooding the log every 30s while still surfacing the first occurrence.
let reapStageWarned = false;
let mailPurgeStageWarned = false;

// Cap the broker's own log on the periodic tick (the register hook only rotates
// at register time, so a flood with no new registrations grows it unbounded —
// how it reached 24MB on 2026-06-19).
//
// TRUNCATE-IN-PLACE, not rename. The broker's stdout/stderr are the systemd
// `StandardOutput=append:` fd, opened ONCE at process start and held for the
// process lifetime. A `renameSync` would move the file to `.old` while that held
// fd keeps writing to the SAME inode → systemd appends to `.old`, no fresh log is
// created, and disk still grows (a silent no-op — the bug code review caught).
// `truncateSync(path, 0)` resets the SAME inode the held fd points at, so the next
// append lands at offset 0 and disk is freed immediately. Cost: the current tail
// is lost (acceptable for a cap-on-flood backstop). Best-effort: a failure must
// never break the sweep, so it is caught and logged once.
let brokerLogRotateWarned = false;
function rotateBrokerLogIfLarge() {
  try {
    if (!existsSync(BROKER_LOG_PATH)) return;
    if (!shouldRotateLog(statSync(BROKER_LOG_PATH).size, BROKER_LOG_MAX_BYTES)) return;
    truncateSync(BROKER_LOG_PATH, 0);
    console.error(`[broker] log truncated: exceeded ${BROKER_LOG_MAX_BYTES} bytes (in-place; systemd append fd preserved)`);
  } catch (e) {
    if (!brokerLogRotateWarned) {
      brokerLogRotateWarned = true;
      console.error(`[broker] log truncate failed (${BROKER_LOG_PATH}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// D3 cold-start grace (2026-05-14): defer the first reap AND the periodic
// schedule kickoff by 60s after broker startup. Without this delay, an
// operator-facing session whose `bun` is alive but whose `last_seen` is stale
// at boot (e.g., a session parked on a long task across a broker bounce, a
// redeploy, or a host reboot) would be reaped by the new TTL gate (R5(b))
// before it can re-heartbeat — wiping its undelivered-mail queue.
//
// Trade-off: PID-dead peers from before the restart linger up to 60s longer
// than under the old immediate-reap behavior. Acceptable — they were already
// dead, and the on-demand `liveAndFreshPeers` (used by handleListPeers /
// handleBroadcast) still applies the full predicate from the first request.
//
// Mirrored by tests/phase-b-r5b-ttl-reaper.test.ts describe block 7 (sentinel).
const COLD_START_GRACE_MS = 60_000;
setTimeout(() => {
  cleanStalePeers();
  // Periodically clean stale peers (every 30s) AFTER the grace expires.
  setInterval(cleanStalePeers, 30_000);
}, COLD_START_GRACE_MS);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, absolute_git_dir, tty, name, resolved_name, tmux_session, tmux_window_index, tmux_window_name, tmux_pane_id, client_type, receiver_mode, summary, registered_at, last_seen, token)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updatePeerRegistration = db.prepare(`
  UPDATE peers
  SET pid = ?,
      cwd = ?,
      git_root = ?,
      absolute_git_dir = ?,
      tty = ?,
      name = ?,
      resolved_name = ?,
      tmux_session = ?,
      tmux_window_index = ?,
      tmux_window_name = ?,
      tmux_pane_id = ?,
      client_type = ?,
      receiver_mode = ?,
      -- Preserve a live summary on re-registration: a lane that re-registers
      -- (e.g. 401 auth-reset recovery) re-sends its FROZEN startup summary,
      -- which is empty/stale when the operator set the real summary later via
      -- /set-summary (that updates the DB row, not the lane's closure var).
      -- Binding it unconditionally would silently overwrite the live summary
      -- with "". NULLIF(?, '') keeps the new value only when non-empty.
      summary = COALESCE(NULLIF(?, ''), summary),
      last_seen = ?,
      token = ?
  WHERE id = ?
`);

const selectPeerByToken = db.prepare(`
  SELECT id, pid, token FROM peers WHERE id = ? AND token = ?
`);

const selectPeerById = db.prepare(`
  SELECT * FROM peers WHERE id = ?
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateHeartbeatSeen = db.prepare(`
  UPDATE peers
  SET last_seen = ?,
      client_type = CASE
        WHEN ? = 'unknown' THEN client_type
        ELSE ?
      END,
      receiver_mode = CASE
        WHEN ? = 'unknown' THEN receiver_mode
        WHEN receiver_mode = 'codex-hook' AND ? = 'manual-drain' THEN receiver_mode
        WHEN receiver_mode = 'gemini-hook' AND ? = 'manual-drain' THEN receiver_mode
        ELSE ?
      END
  WHERE id = ?
`);

const updateReceiverHealth = db.prepare(`
  UPDATE peers
  SET last_seen = ?,
      client_type = ?,
      receiver_mode = ?,
      last_hook_seen_at = ?,
      last_drain_at = COALESCE(?, last_drain_at),
      last_drain_error = ?
  WHERE id = ?
`);

// Claude /poll-by-pid drain telemetry. Touches ONLY the two health columns so
// it cannot overwrite client_type or receiver_mode for any peer. Scoped to
// client_type='claude' so a stray PID collision can never corrupt a codex row.
const updateClaudeDrainHealth = db.prepare(`
  UPDATE peers
  SET last_hook_seen_at = ?,
      last_drain_at = COALESCE(?, last_drain_at)
  WHERE id = ? AND client_type = 'claude'
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const updateName = db.prepare(`
  UPDATE peers SET name = ?, resolved_name = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages
  WHERE to_id = ? AND delivered = 0
    AND (claimed_at IS NULL OR claimed_at < ?)
  ORDER BY sent_at ASC
`);

const markDeliveredScoped = db.prepare(`
  UPDATE messages SET delivered = 1, delivered_at = ?, claimed_by = NULL, claimed_at = NULL WHERE id = ? AND to_id = ?
`);

const markDeliveredClaimedScoped = db.prepare(`
  UPDATE messages SET delivered = 1, delivered_at = ?, claimed_by = NULL, claimed_at = NULL
  WHERE id = ? AND to_id = ? AND claimed_by = ?
`);

// Companion lookup for latency telemetry: reads sent_at + from_id BEFORE
// the ack marks the row delivered, so we can log queue→ack ms per message.
const selectMsgForLatency = db.prepare(`
  SELECT from_id, sent_at FROM messages WHERE id = ? AND to_id = ?
`);

// /poll-by-pid: resolves an MCP server PID to its peer row. Used by the
// UserPromptSubmit hook to drain the inbox without holding the peer's auth
// token (which lives in the MCP server's memory only). Security model:
// caller_pid is verified same-UID via verifyPidUid, and loopback-only bind
// means the attacker boundary is already "other user on this machine".
const selectPeerIdByPid = db.prepare(`
  SELECT id FROM peers WHERE pid = ?
`);

const claimMessage = db.prepare(`
  UPDATE messages
  SET claimed_by = ?, claimed_at = ?
  WHERE id = ? AND to_id = ? AND delivered = 0
    AND (claimed_at IS NULL OR claimed_at < ?)
`);

// Rehydration candidate lookup. Pane identity is preferred: same tmux session,
// pane id, and cwd, with window metadata required to match only when both sides
// know it. Window fallback applies only to legacy rows that never had a pane id.
// A stored null git_root may upgrade to a known git_root on the same pane/cwd,
// but an incoming null git_root cannot steal a concrete stored repo identity.
// Excludes the caller's own PID: live same-PID refresh is handled by PID-dedup,
// not rehydration.
const selectRehydrateCandidatesByPane = db.prepare(`
  SELECT id, pid, last_seen, git_root FROM peers
  WHERE tmux_session = ?
    AND tmux_pane_id = ?
    AND cwd = ?
    AND (git_root = ? OR git_root IS NULL)
    AND ((? IS NULL OR ? IS NULL) OR tmux_window_index IS NULL OR tmux_window_name IS NULL OR (tmux_window_index = ? AND tmux_window_name = ?))
    AND pid != ?
  ORDER BY CASE WHEN (? IS NOT NULL AND git_root = ?) THEN 0 ELSE 1 END, last_seen DESC LIMIT 3
`);

const selectRehydrateCandidatesByWindow = db.prepare(`
  SELECT id, pid, last_seen, git_root FROM peers
  WHERE tmux_session = ?
    AND tmux_pane_id IS NULL
    AND tmux_window_index = ?
    AND tmux_window_name = ?
    AND cwd = ?
    AND (git_root = ? OR git_root IS NULL)
    AND pid != ?
  ORDER BY CASE WHEN (? IS NOT NULL AND git_root = ?) THEN 0 ELSE 1 END, last_seen DESC LIMIT 3
`);

// Stale self-duplicates on the same pane: rows on the EXACT (tmux_session,
// tmux_pane_id) seat that are the SAME logical session (same cwd AND same name)
// as the one registering, but a different (dead) PID. These are the
// close-then-reopen leftovers that pile up as pr.1, pr.1#2..#6 on one pane.
// Ordered newest-first: the caller KEEPS the single most-recent dead row so the
// rehydration path below can inherit it (its undelivered mail then follows the
// reopened session), and purges only the OLDER extras. The cwd+name match is
// deliberately narrow: it never touches a DIFFERENT session sharing the pane
// (different cwd → the recovery/rehydration path owns that). PID-liveness is
// checked in code (the query returns candidates; we act only on the dead ones).
const selectSamePaneSelfDuplicates = db.prepare(`
  SELECT id, pid FROM peers
  WHERE tmux_session = ? AND tmux_pane_id = ? AND cwd = ? AND name = ? AND pid != ?
  ORDER BY last_seen DESC
`);

// Broadcast target-selection. Each filter is optional; NULL means "don't
// filter on this field." Always excludes the sender. Filters AND together —
// e.g. tmux_session='rag' AND name_like='reviewer' matches peers in rag
// whose name contains "reviewer" (case-insensitive).
//
// LIKE metacharacters in name_like: escaped in the caller (handleBroadcast)
// with ESCAPE '\'. Without this, a caller passing name_like='%' bypasses
// the "at least one scope filter" guard (the % becomes a SQL wildcard
// matching everything, defeating the scope requirement).
//
// receiver_mode != 'unknown': exclude peers with no resolved receive path
// (send-only / misregistered clients like a one-way bridge). They heartbeat so
// handleBroadcast's active-peer filter passes them, but they NEVER drain — a
// broadcast to them queues mail that nothing can deliver (the leak fixed
// 2026-06-28: pieces-bridge.linux trapped 7 broadcasts for up to 7 days). Direct
// send_message (by explicit id) is intentionally NOT filtered this way — a 1:1
// send to a known peer mid-registration should still land; UNDELIVERED_MSG_TTL_MS
// is the backstop for that rarer case.
const selectBroadcastTargets = db.prepare(`
  SELECT id FROM peers
  WHERE id != ?
    AND receiver_mode != 'unknown'
    AND (? IS NULL OR tmux_session = ?)
    AND (? IS NULL OR git_root = ?)
    AND (? IS NULL OR lower(COALESCE(name,'')) LIKE '%' || lower(?) || '%' ESCAPE '\\')
`);

// /message-status: sender-scoped status lookup. Only the ORIGINAL sender
// can read a message's delivery state — otherwise a peer could enumerate
// another peer's message history by guessing ids.
const selectMessageStatus = db.prepare(`
  SELECT id, delivered, delivered_at FROM messages WHERE id = ? AND from_id = ?
`);

// AP-063: bridge cursor read. Returns ALL messages with id > cursor, regardless
// of delivery state — the bridge is an observer, not a recipient. Bridge tokens
// are file-backed and loopback-only; this is intentionally bypass-the-peer-model.
const selectMessagesSinceId = db.prepare(`
  SELECT id, from_id, to_id, text, sent_at, delivered FROM messages
  WHERE id > ? ORDER BY id ASC LIMIT ?
`);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// S2: cryptographically-random per-peer token. 24 random bytes encoded as
// base64url — exactly 192 bits of entropy in 32 URL-safe characters. The
// previous base36 encoding wasted 4 bytes via slice() and used a non-uniform
// 256-of-1296-symbol distribution per pair (M1).
function generateToken(): string {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString("base64url");
}

// AP-063: bridge token — 32 random bytes, file-backed at chmod 0600. Minted
// once per broker process; daemon reads from BRIDGE_TOKEN_FILE on startup
// and on every 401 response (handles broker restart).
function mintBridgeToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString("base64url");
}
const BRIDGE_TOKEN = mintBridgeToken();

function publishBridgeTokenFile(): void {
  // Atomic write: tmp + chmod + rename. Avoids partial-token race during read.
  //
  // Publish only after Bun.serve successfully binds below. A failed second broker
  // start on the same port must not clobber the live broker's token file while the
  // original process keeps its in-memory token.
  const tmp = `${BRIDGE_TOKEN_FILE}.tmp`;
  try {
    writeFileSync(tmp, BRIDGE_TOKEN, { mode: 0o600 });
    chmodSync(tmp, 0o600);  // belt-and-braces: writeFileSync mode is umask-affected
    renameSync(tmp, BRIDGE_TOKEN_FILE);
    console.error(`[broker] bridge token written to ${BRIDGE_TOKEN_FILE}`);
  } catch (e) {
    console.error(`[broker] FATAL: cannot write bridge token to ${BRIDGE_TOKEN_FILE}:`, e);
    process.exit(2);
  }
}

// S3: verify the claimed PID is alive and owned by this broker's UID.
// Reads /proc/<pid>/status — Linux-only, which matches the deployment target.
// Returns null on success, error string on rejection.
function verifyPidUid(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return `invalid pid ${pid}`;
  try {
    process.kill(pid, 0);
  } catch {
    return `pid ${pid} not alive`;
  }
  if (MY_UID < 0) return null; // M3: non-Linux fallback (warned at startup).
  // L5: PID-reuse race window between kill(0) above and readFileSync below
  // is a known limitation. On a single-user Linux box the impact is bounded
  // to the same UID space, so worst-case the new PID also passes the UID
  // check — no security regression, just a wasted slot.
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/^Uid:\s+(\d+)/m);
    if (!m || !m[1]) return `cannot read uid for pid ${pid}`;
    const uid = parseInt(m[1], 10);
    if (uid !== MY_UID) {
      // H4 + L4: log security-relevant rejection on the broker side so
      // operators see PID-spoofing attempts that the client otherwise
      // sees only as a 403.
      console.error(`[broker] S3 reject: pid ${pid} owned by uid ${uid}, broker uid ${MY_UID}`);
      return `pid ${pid} owned by uid ${uid}, broker uid ${MY_UID}`;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // ENOENT here means the PID died between kill(0) and the read — benign
    // race, treat as "not alive". EPERM is genuinely security-relevant.
    if (msg.includes("ENOENT")) return `pid ${pid} died during verify`;
    console.error(`[broker] S3 /proc read failed for pid ${pid}: ${msg}`);
    return `proc read failed: ${msg}`;
  }
  return null;
}

// AP-063: bridge auth via Authorization: Bearer. Constant-time compare to
// prevent timing attacks. Distinct from authPeer (X-Peer-Token) so a leaked
// peer token cannot reach bridge endpoints and vice versa.
function authBridge(req: Request, path: string): { ok: true } | { ok: false; status: number; error: string } {
  const hdr = req.headers.get("authorization");
  if (!hdr || !hdr.startsWith("Bearer ")) {
    console.error(`[broker] bridge auth fail on ${path}: missing Bearer`);
    return { ok: false, status: 401, error: "missing bridge token" };
  }
  const presented = Buffer.from(hdr.slice(7));
  const expected = Buffer.from(BRIDGE_TOKEN);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    console.error(`[broker] bridge auth fail on ${path}: invalid token`);
    return { ok: false, status: 401, error: "invalid bridge token" };
  }
  return { ok: true };
}

// S2/S6: resolve `X-Peer-Token` header to an authenticated peer row. The
// caller's claimed peer ID comes from the URL path (?id=...) or body.id, but
// we ALWAYS overwrite from this lookup — body-supplied IDs are untrusted.
function authPeer(req: Request, claimedId: string | undefined, path: string): { ok: true; id: string } | { ok: false; status: number; error: string } {
  const token = req.headers.get("x-peer-token");
  if (!token) {
    // L4: log auth failures so brute-force / misconfig is visible to operators.
    console.error(`[broker] auth fail on ${path}: missing x-peer-token`);
    return { ok: false, status: 401, error: "missing x-peer-token" };
  }
  if (!claimedId) {
    console.error(`[broker] auth fail on ${path}: missing peer id`);
    return { ok: false, status: 401, error: "missing peer id" };
  }
  const row = selectPeerByToken.get(claimedId, token) as { id: string; pid: number; token: string } | null;
  if (!row) {
    console.error(`[broker] auth fail on ${path}: invalid token for ${claimedId}`);
    return { ok: false, status: 401, error: "invalid token for peer" };
  }
  return { ok: true, id: row.id };
}

// --- Seat-supersede signal ---
// When a NEWER process registers for an existing peer's exact tmux seat (same
// session + pane_id + name, different pid) and the older peer is STILL ALIVE, the
// old server is a leftover (its session was `--resume`d / replaced but its MCP
// server kept running). Two live registrations on one seat make the broker
// ping-pong `last_seen` between them → unreliable 1:1 delivery ("seat churn").
// We mark the older peer's id here; its NEXT /heartbeat returns superseded:true,
// and the old server exits cleanly. One-shot per id (cleared on send). In-memory:
// a broker restart simply re-derives the state on the next register.
const supersededPeerIds = new Set<string>();

// Pure decision (exported for unit testing). Given the same-seat self-duplicate
// rows (newest-first, EXCLUDING the registering pid) and a liveness oracle, return
// the ids of LIVE older duplicates that must be told to step down. Dead rows are
// left for the rehydration/dedup paths; only LIVE leftovers are superseded.
export function liveDuplicatesToSupersede(
  dups: { id: string; pid: number }[],
  isAlive: (pid: number) => boolean,
): string[] {
  return dups.filter((d) => isAlive(d.pid)).map((d) => d.id);
}

// --- S5: token-bucket rate limit (in-memory, per peer) ---
type Bucket = { reqs: number[]; msgs: number[] };
const buckets = new Map<string, Bucket>();
// M2: expose to cleanStalePeers via a global tag (it runs at startup before
// this declaration is visible via lexical scope on first invocation).
(globalThis as { __cpBuckets?: Map<string, Bucket> }).__cpBuckets = buckets;
function rateCheck(peerId: string, isMessage: boolean): string | null {
  const now = Date.now();
  let b = buckets.get(peerId);
  if (!b) {
    b = { reqs: [], msgs: [] };
    buckets.set(peerId, b);
  }
  // Drop entries older than the window
  const cutoff = now - RATE_WINDOW_MS;
  while (b.reqs.length && (b.reqs[0] ?? Infinity) < cutoff) b.reqs.shift();
  while (b.msgs.length && (b.msgs[0] ?? Infinity) < cutoff) b.msgs.shift();
  if (b.reqs.length >= RATE_MAX_REQS) return `rate limit: ${RATE_MAX_REQS} req/min`;
  if (isMessage && b.msgs.length >= RATE_MAX_MSGS) return `rate limit: ${RATE_MAX_MSGS} msg/min`;
  b.reqs.push(now);
  if (isMessage) b.msgs.push(now);
  return null;
}

function reserveMessageSlots(peerId: string, count: number): string | null {
  if (count <= 0) return null;
  const now = Date.now();
  let b = buckets.get(peerId);
  if (!b) {
    b = { reqs: [], msgs: [] };
    buckets.set(peerId, b);
  }
  const cutoff = now - RATE_WINDOW_MS;
  while (b.msgs.length && (b.msgs[0] ?? Infinity) < cutoff) b.msgs.shift();
  if (b.msgs.length + count > RATE_MAX_MSGS) return `rate limit: ${RATE_MAX_MSGS} msg/min`;
  for (let i = 0; i < count; i++) b.msgs.push(now);
  return null;
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

// L2: only string ids count. Numbers/null/objects → empty string → caller
// rejects with a precise "missing peer id" rather than a confusing
// type-coercion error inside the prepared statement.
function reqStrict(s: unknown): string {
  return typeof s === "string" ? s : "";
}

function validClientType(value: unknown): ClientType {
  return value === "claude" || value === "codex" || value === "gemini" || value === "unknown" ? value : "unknown";
}

function validReceiverMode(value: unknown, clientType: ClientType): ReceiverMode {
  if (clientType === "claude") return "claude-channel";
  if (clientType === "codex") {
    return value === "codex-hook" || value === "manual-drain" ? value : "manual-drain";
  }
  if (clientType === "gemini") {
    return value === "gemini-hook" || value === "manual-drain" ? value : "manual-drain";
  }
  return "unknown";
}

function initialReceiverModeFromRegistration(value: unknown, clientType: ClientType): ReceiverMode {
  const mode = validReceiverMode(value, clientType);
  if ((clientType === "codex" && mode === "codex-hook") || (clientType === "gemini" && mode === "gemini-hook")) {
    return "manual-drain";
  }
  return mode;
}

function hookMetadata(peerId: string, body: { client_type?: ClientType; receiver_mode?: ReceiverMode }): { clientType: ClientType; receiverMode: ReceiverMode } {
  const explicitClient = validClientType(body.client_type);
  if (explicitClient !== "unknown") {
    return { clientType: explicitClient, receiverMode: validReceiverMode(body.receiver_mode, explicitClient) };
  }
  if (body.receiver_mode === "gemini-hook") return { clientType: "gemini", receiverMode: "gemini-hook" };
  if (body.receiver_mode === "codex-hook") return { clientType: "codex", receiverMode: "codex-hook" };
  const current = db.query("SELECT client_type, receiver_mode FROM peers WHERE id = ?").get(peerId) as {
    client_type: ClientType | null;
    receiver_mode: ReceiverMode | null;
  } | null;
  const currentClient = validClientType(current?.client_type);
  if (currentClient === "claude") {
    return { clientType: "claude", receiverMode: validReceiverMode(current?.receiver_mode, "claude") };
  }
  if (currentClient === "gemini") {
    return { clientType: "gemini", receiverMode: "gemini-hook" };
  }
  if (currentClient === "codex") {
    return { clientType: "codex", receiverMode: "codex-hook" };
  }
  return { clientType: "unknown", receiverMode: validReceiverMode(current?.receiver_mode, "unknown") };
}

function nullableStableValueCompatible(existingValue: string | null | undefined, incomingValue: string | null | undefined): boolean {
  const existing = existingValue ?? null;
  const incoming = incomingValue ?? null;
  return existing === incoming || existing === null || incoming === null;
}

function normalizedTtyForIdentity(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^\/dev\//, "");
}

function ttyCompatibleForSamePid(existingValue: string | null | undefined, incomingValue: string | null | undefined): boolean {
  const existing = normalizedTtyForIdentity(existingValue);
  const incoming = normalizedTtyForIdentity(incomingValue);
  return existing === incoming || existing === null || incoming === null;
}

function claimCutoffIso(nowMs = Date.now()): string {
  return new Date(nowMs - CLAIM_TTL_MS).toISOString();
}

function selectAvailableMessages(peerId: string): Message[] {
  return selectUndelivered.all(peerId, claimCutoffIso()) as Message[];
}

function generateDrainId(peerId: string): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  return `drain:${peerId}:${Date.now()}:${Buffer.from(buf).toString("base64url")}`;
}

// --- Request handlers ---

// L3: tagged-union return so the discriminator is unambiguous and future
// fields on RegisterResponse can never collide with the error path.
type RegisterResult =
  | { ok: true; value: RegisterResponse }
  | { ok: false; status: number; error: string };

function handleRegister(body: RegisterRequest): RegisterResult {
  // S3: PID/UID validation before issuing any token.
  const pidErr = verifyPidUid(body.pid);
  if (pidErr) return { ok: false, status: 403, error: `S3 PID/UID rejected: ${pidErr}` };

  // S5: bound the summary at registration too.
  if (body.summary && utf8Bytes(body.summary) > MAX_SUMMARY_BYTES) {
    return { ok: false, status: 413, error: `summary exceeds ${MAX_SUMMARY_BYTES} bytes` };
  }

  // Bound the name at registration too — /set-name enforces MAX_NAME_BYTES at
  // line 876-878 but /register previously didn't, so a peer could register a
  // 10MB name and DoS list_peers output. Also rejects non-string types so the
  // suffix-walk template literal can't stringify objects to "[object Object]".
  if (body.name !== undefined && body.name !== null) {
    if (typeof body.name !== "string") {
      return { ok: false, status: 400, error: "name must be a string" };
    }
    if (utf8Bytes(body.name) > MAX_NAME_BYTES) {
      return { ok: false, status: 413, error: `name exceeds ${MAX_NAME_BYTES} bytes` };
    }
  }

  const now = new Date().toISOString();
  const token = generateToken();

  // Collapse stale self-duplicates on this pane to at most one BEFORE rehydration.
  // A closed-and-reopened pane (new PID, same cwd + name, same pane) accumulates
  // dead predecessor rows (pr.1, pr.1#2..#6) that make send_to_peer ambiguous.
  // We KEEP the single newest dead row so the rehydration path below can inherit
  // it — that preserves its undelivered mail (mail sent while the session was
  // dead is exactly what rehydration recovers; purging it here would be silent
  // data loss). We purge only the OLDER dead extras; their undelivered mail is
  // cleared (mirrors the reaper) because only the newest predecessor is the
  // recoverable inbox — older ones are superseded duplicates. Narrow on purpose:
  // a DIFFERENT session sharing the pane (different cwd) is never touched, so the
  // recovery path still owns it.
  if (body.tmux_session && body.tmux_pane_id && body.name) {
    const dups = selectSamePaneSelfDuplicates.all(body.tmux_session, body.tmux_pane_id, body.cwd, body.name, body.pid) as { id: string; pid: number }[];
    // Seat-supersede: any LIVE older duplicate on this exact seat is a leftover
    // server (its session was resumed/replaced but its MCP process kept running).
    // body.pid is the newest registrant → authoritative. Mark the live leftovers
    // to be told to step down on their next heartbeat (they exit cleanly), so the
    // seat collapses to one live registration and 1:1 delivery stops ping-ponging.
    const toSupersede = liveDuplicatesToSupersede(dups, isPidAlive);
    for (const id of toSupersede) supersededPeerIds.add(id);
    if (toSupersede.length > 0) {
      console.error(`[broker] seat-supersede: pid=${body.pid} (newest) flagged ${toSupersede.length} LIVE older self-dup(s) to step down on ${body.tmux_session}:${body.tmux_pane_id} (name=${body.name})`);
    }
    let purged = 0;
    let keptNewestDead = false; // the first (newest) dead row is left for rehydration
    for (const d of dups) {
      if (isPidAlive(d.pid)) continue; // a live row is not stale — never touch it
      if (!keptNewestDead) {
        keptNewestDead = true; // preserve the newest dead row + its mail for rehydration
        continue;
      }
      deletePeer.run(d.id);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [d.id]);
      buckets.delete(d.id);
      purged++;
    }
    if (purged > 0) {
      console.error(`[broker] seat-dedup: pid=${body.pid} purged ${purged} older stale self-dup row(s) on ${body.tmux_session}:${body.tmux_pane_id} (name=${body.name}, cwd=${body.cwd}); newest dead row kept for rehydration`);
    }
  }

  // Rehydration: if a recently-dead peer occupied the same tmux seat, inherit
  // its ID so mail addressed to it surfaces to this new session. Pane id is the
  // strongest seat key; window metadata is a compatibility guard when present.
  let inheritedId: string | null = null;
  if (body.tmux_session && (body.tmux_pane_id || (body.tmux_window_index !== null && body.tmux_window_index !== undefined && body.tmux_window_name))) {
    const candidates = (body.tmux_pane_id
      ? selectRehydrateCandidatesByPane.all(
        body.tmux_session,
        body.tmux_pane_id,
        body.cwd,
        body.git_root,
        body.tmux_window_index ?? null,
        body.tmux_window_name ?? null,
        body.tmux_window_index ?? null,
        body.tmux_window_name ?? null,
        body.pid,
        body.git_root,
        body.git_root
      )
      : selectRehydrateCandidatesByWindow.all(
        body.tmux_session,
        body.tmux_window_index,
        body.tmux_window_name,
        body.cwd,
        body.git_root,
        body.pid,
        body.git_root,
        body.git_root
      )) as { id: string; pid: number; last_seen: string; git_root: string | null }[];
    for (const c of candidates) {
      const lastSeenMs = new Date(c.last_seen).getTime();
      if (!Number.isFinite(lastSeenMs)) continue;
      const ageMs = Date.now() - lastSeenMs; // for the inherit log only; NOT gated
      // Liveness gate (NO age gate). Skip if the candidate's PID is still alive
      // OR owned by a different UID (EPERM — PID recycled to a non-us process).
      // Only ESRCH ("No such process") / undefined means the slot is genuinely
      // dead. A CONFIRMED-DEAD seat occupying this pane is inheritable regardless
      // of age: a live proc (e.g. a --resume'd session with a new pid) re-claiming
      // a pane whose only occupant is a dead tombstone MUST inherit it to recover
      // its stranded undelivered mail (which liveAndFreshPeers now preserves past
      // the 1h reap when pending). Gating inheritance on the 1h window left such
      // seats permanently deaf+mute (the dead-PID-reclaim bug). Control flow makes
      // the dead-only path explicit: both live branches `continue` before inherit.
      try {
        process.kill(c.pid, 0);
        continue; // alive — never inherit (would hijack a live peer's id)
      } catch (e) {
        const code = (e as { code?: string } | undefined)?.code;
        if (code === "EPERM") continue; // alive-under-different-uid — don't inherit
        // ESRCH / undefined → dead → inherit at any age (fall through)
      }
      inheritedId = c.id;
      deletePeer.run(c.id);
      buckets.delete(c.id);
      if (c.git_root !== body.git_root) {
        console.error(`[broker] rehydrate: degraded git_root match old=${c.git_root ?? "(null)"} new=${body.git_root ?? "(null)"} id=${c.id}`);
      }
      console.error(`[broker] rehydrate: new pid=${body.pid} inherits id=${c.id} from dead pid=${c.pid} (age_ms=${ageMs})`);
      break;
    }
  }

  const requestedClientType = validClientType(body.client_type);
  const existing = db.query(`
    SELECT id, token, cwd, git_root, absolute_git_dir, tty, tmux_session,
           tmux_window_index, tmux_window_name, tmux_pane_id, client_type,
           receiver_mode
    FROM peers WHERE pid = ?
  `).get(body.pid) as {
    id: string;
    token: string;
    cwd: string;
    git_root: string | null;
    absolute_git_dir: string | null;
    tty: string | null;
    tmux_session: string | null;
    tmux_window_index: string | null;
    tmux_window_name: string | null;
    tmux_pane_id: string | null;
    client_type: ClientType | null;
    receiver_mode: ReceiverMode | null;
  } | null;
  const existingClientType = validClientType(existing?.client_type);
  const clientType = requestedClientType === "unknown" && existingClientType !== "unknown" ? existingClientType : requestedClientType;
  // Same-pid refresh: a live peer re-registering (e.g. 401 recovery after a
  // broker restart) must KEEP its broker id so mail addressed to that id still
  // resolves. The gate is the STABLE identity of the process: pid (already
  // matched by the `existing`-by-pid lookup), cwd, compatible git metadata, and
  // compatible tty metadata. Older rows may lack absolute_git_dir and different
  // clients report the same tty as either /dev/pts/N or pts/N; those enrichment
  // differences must not mint a fresh id for the same live process. The tmux
  // LOCATION fields (session/window/pane_id) are deliberately NOT in the gate —
  // a pid is one process is one peer regardless of which pane it is currently
  // displayed in, and a bg lane's pane_id is unstable (null until resolved, then
  // a real %id; can shift on re-attach). Gating on pane_id made a bg lane get a
  // fresh generateId() on re-register, whose dedup-delete then wiped the old id's
  // undelivered mail (the "re-registration race" that forced a manual nudge).
  // The location fields still UPDATE on the refresh (the UPDATE path binds the
  // new tmux_* values) — they just no longer break id stability.
  const samePidRefresh = Boolean(existing && inheritedId === null &&
    existing.cwd === body.cwd &&
    nullableStableValueCompatible(existing.git_root, body.git_root) &&
    nullableStableValueCompatible(existing.absolute_git_dir, body.absolute_git_dir ?? null) &&
    ttyCompatibleForSamePid(existing.tty, body.tty) &&
    (requestedClientType === "unknown" || existingClientType === "unknown" || existingClientType === clientType));
  const id = inheritedId ?? (samePidRefresh ? existing!.id : null) ?? generateId();

  // Runtime-name de-dupe: keep the operator-facing name unchanged, but assign
  // a broker-unique resolved_name for diagnostics and exact process identity.
  const requestedName = body.name ?? null;
  const finalName = disambiguateName(requestedName, id, body.tmux_window_name);
  let receiverMode = initialReceiverModeFromRegistration(body.receiver_mode, clientType);
  if (existing?.id === id && receiverMode === "manual-drain") {
    const currentMode = validReceiverMode(existing.receiver_mode, clientType);
    if ((clientType === "codex" && currentMode === "codex-hook") || (clientType === "gemini" && currentMode === "gemini-hook")) {
      receiverMode = currentMode;
    }
  }
  if (requestedName && finalName !== requestedName) {
    console.error(`[broker] name dedup: pid=${body.pid} requested="${requestedName}" resolved="${finalName}" (collision)`);
  }
  const issuedToken = existing?.id === id && body.preserve_token ? existing.token : token;
  // tty is a nullable column; summary is NOT NULL DEFAULT ''. bun:sqlite throws
  // a NOT NULL constraint error when `undefined`/`null` is BOUND to summary —
  // the column DEFAULT only applies when the column is omitted, not when a
  // nullish value is bound. A bg/daemon-hosted lane registers lazily (first
  // tool call) BEFORE its async auto-summary lands, so body.summary is
  // undefined and the insert threw → /register 500 → the lane never registered
  // and was invisible to the broker (the "lane needs a manual nudge" bug).
  // Coalesce both to their column-valid empty forms so registration can't crash
  // on a not-yet-summarized session.
  const ttyValue = body.tty ?? null;
  const summaryValue = body.summary ?? "";
  const preserveKnownSamePidMetadata = samePidRefresh && existing?.id === id;
  const gitRootValue = preserveKnownSamePidMetadata ? (body.git_root ?? existing.git_root) : body.git_root;
  const absoluteGitDirValue = preserveKnownSamePidMetadata ? (body.absolute_git_dir ?? existing.absolute_git_dir) : (body.absolute_git_dir ?? null);
  const ttyWriteValue = preserveKnownSamePidMetadata ? (ttyValue ?? existing.tty) : ttyValue;
  // ENC-08 (no silent failure): a DB write that throws here would otherwise
  // fall through to the route-level generic 500 ("internal error") with no
  // signal to the registering peer about WHY it failed — which is exactly how
  // the summary-NOT-NULL crash stayed invisible (lanes silently un-registered).
  // Catch the binding/constraint error, log the real cause server-side, and
  // return a structured failure so the caller gets a real status, not a bare 500.
  try {
    // Atomic delete-then-write: the existing-PID-dedup delete must roll back if
    // the subsequent insert/update fails, otherwise a failed write leaves the
    // PID with its old row deleted and no new row — a ghost (broker-invisible
    // peer). db.transaction() makes the delete + write all-or-nothing; the
    // buckets.delete (in-memory) runs only after the transaction commits.
    db.transaction(() => {
      // Existing PID-dedup: a live peer re-registering must replace its own row.
      // Guarded against clobbering the inherited row we re-created above.
      if (existing && existing.id !== id) {
        deletePeer.run(existing.id);
        // Clean the abandoned id's undelivered mail too. Unlike the rehydrate
        // path (which INHERITS the old id so mail still resolves), this dedup
        // path assigns a NEW id — so any mail addressed to the old id is now
        // unreachable. Mirrors the reap-path cleanup (liveAndFreshPeers) so a
        // re-register with a new id does not strand orphaned messages that no
        // peer row will ever drain (unbounded messages-table growth otherwise).
        db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [existing.id]);
      }
      if (existing?.id === id) {
        updatePeerRegistration.run(body.pid, body.cwd, gitRootValue, absoluteGitDirValue, ttyWriteValue, requestedName, finalName, body.tmux_session ?? null, body.tmux_window_index ?? null, body.tmux_window_name ?? null, body.tmux_pane_id ?? null, clientType, receiverMode, summaryValue, now, issuedToken, id);
      } else {
        insertPeer.run(id, body.pid, body.cwd, gitRootValue, absoluteGitDirValue, ttyWriteValue, requestedName, finalName, body.tmux_session ?? null, body.tmux_window_index ?? null, body.tmux_window_name ?? null, body.tmux_pane_id ?? null, clientType, receiverMode, summaryValue, now, now, issuedToken);
      }
    })();
    if (existing && existing.id !== id) {
      buckets.delete(existing.id);
    }
  } catch (e) {
    // SEC-04 / H4: log the full cause server-side, but return a GENERIC message
    // to the caller. /register is the only unauthenticated route — surfacing the
    // raw SQLite error (e.g. "UNIQUE constraint failed: peers.id") would leak
    // table/column names to an unauthenticated client, the exact disclosure the
    // route-level H4 catch exists to prevent. ENC-08 is still satisfied: a real
    // 500 + a stable error string + the logged cause.
    console.error(`[broker] /register DB write failed for pid=${body.pid} name="${requestedName ?? ""}":`, e);
    return { ok: false, status: 500, error: "registration persistence failed" };
  }
  return { ok: true, value: { id, token: issuedToken, name: requestedName, resolved_name: finalName, client_type: clientType, receiver_mode: receiverMode } };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  const now = new Date().toISOString();
  if (body.client_type || body.receiver_mode) {
    const current = db.query("SELECT client_type, receiver_mode FROM peers WHERE id = ?").get(body.id) as {
      client_type: ClientType | null;
      receiver_mode: ReceiverMode | null;
    } | null;
    const clientType = body.client_type
      ? validClientType(body.client_type)
      : validClientType(current?.client_type);
    const receiverMode = body.receiver_mode
      ? initialReceiverModeFromRegistration(body.receiver_mode, clientType)
      : validReceiverMode(current?.receiver_mode, clientType);
    updateHeartbeatSeen.run(now, clientType, clientType, receiverMode, receiverMode, receiverMode, receiverMode, body.id);
    return;
  }
  updateLastSeen.run(now, body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

// Returns the actual stored name so the caller (server.ts /set-name dispatch)
// can report it back to the peer — otherwise a peer that asked for "obs" but
// got "obs#2" never learns its real handle.
function handleSetName(body: SetNameRequest): { name: string | null; resolved_name: string | null } {
  // Empty string clears the name (stored as NULL for join-friendliness
  // with list_peers output which treats null as "unnamed").
  const desired = body.name.length > 0 ? body.name : null;
  // set-name has no tmux context in its payload → window-suffix unavailable here;
  // disambiguateName falls back to "#N" (an explicit rename rarely collides anyway).
  const final = disambiguateName(desired, body.id, null);
  updateName.run(desired, final, body.id);
  return { name: desired, resolved_name: final };
}

// Auto-suffix on name collision. If another LIVE peer already holds `rawName`
// (or `rawName#2`, `#3`, …), append the lowest free `#N` (≥ 2) so every peer
// has a unique display name. Dead peers (reaper hasn't fired yet) do not
// block — we check PID liveness inline (same shape as cleanStalePeers
// 155-169 and the rehydrate path 482-489). Excludes selfId so a peer
// re-registering its own row keeps its name. SQLite TEXT and JS Set are both
// case-sensitive — comparison is consistent.
//
// Concurrency: handleRegister is synchronous and bun:sqlite operations are
// synchronous, so within one broker process the SELECT here and the INSERT
// in handleRegister run in one JS turn with no await boundary — atomic by
// virtue of the event loop, no transaction needed. If the broker ever moves
// to multi-process / async sqlite, wrap this in db.transaction(...).
function disambiguateName(rawName: string | null, selfId: string, windowName?: string | null): string | null {
  if (!rawName) return null;
  const rows = db.query(
    "SELECT pid, COALESCE(resolved_name, name) AS name, tmux_window_name AS win FROM peers WHERE COALESCE(resolved_name, name) IS NOT NULL AND id != ?"
  ).all(selfId) as { pid: number; name: string; win: string | null }[];
  const live = rows.filter(r => isPidAlive(r.pid));
  const liveNames = new Set(live.map(r => r.name));
  if (!liveNames.has(rawName)) return rawName;
  // Self-documenting disambiguator: when two LIVE seats share an operator name,
  // suffix with the registrant's tmux WINDOW name (e.g. "coding.1#orchA") rather
  // than a meaningless "#2", so the operator can tell which seat is which at a
  // glance. The bare operator `name` is untouched — only resolved_name carries
  // the suffix. Sanitize the window token (strip whitespace/`#`) so it can't
  // break suffix parsing.
  //
  // BUT only when the window actually DISAMBIGUATES: if a same-base seat is
  // already live in this same window (e.g. two co-tenants of one window, or an
  // orphaned-resume squatter), "#window" gives both the same suffix and tells
  // them apart no better than "#N" — so fall straight to the numeric "#N" walk.
  const win = windowName?.trim().replace(/[#\s]+/g, "-");
  // `startsWith(rawName + "#")` identifies same-base suffixed siblings — but only
  // soundly when rawName itself has no "#" (else "obs#5" would over-match the
  // unrelated "obs#50"). Operator-supplied names can contain "#", so guard it.
  const sameBaseInSameWindow = win
    ? live.some(r => (r.name === rawName || (!rawName.includes("#") && r.name.startsWith(`${rawName}#`))) && (r.win?.trim().replace(/[#\s]+/g, "-")) === win)
    : false;
  if (win && !sameBaseInSameWindow) {
    const byWindow = `${rawName}#${win}`;
    if (!liveNames.has(byWindow)) return byWindow;
  }
  // Numeric fallback when the window can't disambiguate. Prefer allocating the
  // next FREE LANE ORDINAL (infra.1 collides -> infra.3) over an opaque "#N"
  // suffix (infra.1#2): a real lane name is a routable seat the operator and
  // send_to_peer understand, whereas "infra.1#2" is ambiguous and re-collides
  // with find_peer(name='infra.1'). Only when rawName is a "<lane>.<ordinal>"
  // shape do we walk ordinals; otherwise keep the legacy "#N" walk.
  const laneMatch = rawName.match(/^(.*)\.(\d+)$/);
  if (laneMatch) {
    const base = laneMatch[1]; // e.g. "infra"
    let ord = Number(laneMatch[2]) + 1; // start at the next ordinal after the collision
    while (liveNames.has(`${base}.${ord}`)) ord++;
    return `${base}.${ord}`;
  }
  let n = 2;
  while (liveNames.has(`${rawName}#${n}`)) n++;
  return `${rawName}#${n}`;
}

// Distinguishes ESRCH ("dead") from EPERM ("alive, owned by different UID")
// — without this, EPERM collapses to "dead" and a foreign live process's
// name would be reusable. Used by disambiguateName, the rehydrate path
// (482-489), and cleanStalePeers (was bare-catch, hardened to use this
// helper for symmetric EPERM handling across all liveness checks).
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as { code?: string } | undefined)?.code;
    // EPERM → process exists, owned by another UID — treat as alive
    // (don't reuse its name). ESRCH or undefined → genuinely dead.
    return code === "EPERM";
  }
}

function activePeerKey(peer: Peer): string {
  if (peer.tmux_session && peer.tmux_pane_id) return `pane:${peer.tmux_session}:${peer.tmux_pane_id}`;
  if (peer.tty) return `tty:${peer.tty}`;
  return `id:${peer.id}`;
}

function isHookBackedClientPeer(peer: Pick<Peer, "client_type" | "receiver_mode" | "tty" | "tmux_session" | "tmux_pane_id">): boolean {
  const hasVisibleSeat = !!peer.tty || !!(peer.tmux_session && peer.tmux_pane_id);
  if (!hasVisibleSeat) return false;
  return (
    (peer.client_type === "codex" && peer.receiver_mode === "codex-hook") ||
    (peer.client_type === "gemini" && peer.receiver_mode === "gemini-hook")
  );
}

function peerIsReapable(peer: Peer, now: number): boolean {
  // For hook-backed Codex/Gemini rows, `pid` is the visible client process,
  // not a long-running MCP server. An idle lane may not heartbeat until its next
  // prompt hook, but if the client PID is still alive it can receive queued mail
  // on the next hook/autodrain nudge. Keep visible rows routable by PID
  // liveness, but still reap headless/app-server-shaped rows on stale last_seen.
  if (isHookBackedClientPeer(peer) && isPidAlive(peer.pid)) return false;
  return isReapable(peer, isPidAlive, now, PEER_GHOST_AFTER_MS);
}

// Single source of truth for "is this peer reapable, and if so, what cleanup
// fires?" Called by handleListPeers and handleBroadcast (per-request hot
// path) and by cleanStalePeers (periodic sweep). Two reap conditions, either
// sufficient: PID dead (ESRCH) OR last_seen older than PEER_GHOST_AFTER_MS.
//
// D2 (2026-05-14): undelivered-messages cleanup moved here from the old
// cleanStalePeers as part of the Code Simplifier Option B collapse. The
// semantic invariant — "if a peer is being reaped, its undelivered mail is
// unreachable" — holds on every reap path, so it's correct to clean up
// undelivered mail at the same moment as the peer row, regardless of which
// call site triggered the reap. Trade-off: list_peers / broadcast HTTP
// handlers now do one extra DELETE per reaped peer they encounter. Reaps
// are rare; cost is microseconds.
function shouldPermanentlyReapPeer(peer: Peer, now: number): boolean {
  if (!peerIsReapable(peer, now)) return false;
  const dead = !isPidAlive(peer.pid);
  const lastSeenMs = new Date(peer.last_seen).getTime();
  const ageMs = Number.isNaN(lastSeenMs) ? Infinity : now - lastSeenMs;
  return !dead || ageMs > REHYDRATE_WINDOW_MS;
}

// Count undelivered mail for a peer id (cheap, indexed on to_id).
const countUndelivered = db.prepare(
  "SELECT COUNT(*) AS n FROM messages WHERE to_id = ? AND delivered = 0",
);

function liveAndFreshPeers(peers: Peer[]): Peer[] {
  const now = Date.now();
  return peers.filter((p) => {
    if (peerIsReapable(p, now)) {
      if (!shouldPermanentlyReapPeer(p, now)) return false;
      // Decouple mail-reap from row-reap: a DEAD seat that still holds
      // undelivered mail is a RECOVERABLE INBOX, not garbage. The rehydrate
      // path inherits a confirmed-dead seat at ANY age (the deaf-seat fix) and
      // surfaces that mail to the re-registering session — but only if the mail
      // still exists. Deleting it here at the 1h mark defeats that recovery
      // (the bug adversarial review caught). So preserve the row+mail when there
      // IS pending mail; reap normally (row + buckets) when the inbox is empty,
      // which still bounds tombstone growth — only seats with unrecovered mail
      // persist, and they are exactly what we must not silently drop (6154e28).
      //
      // BUT only preserve a seat with a VALID last_seen. A malformed/corrupt
      // timestamp (NaN → reapable-by-age) signals untrustworthy state; preserving
      // it on pending-mail would leak corrupt tombstones forever. Those reap
      // normally even with mail (a deliberately narrow exception).
      const lastSeenValid = Number.isFinite(new Date(p.last_seen).getTime());
      const pending = lastSeenValid ? (countUndelivered.get(p.id) as { n: number }).n : 0;
      // Preserve a dead-with-mail seat as a recoverable inbox — but only WITHIN the
      // TTL. Past DEAD_MAIL_TTL_MS the session has not returned to inherit (24h+);
      // reap the row + its stranded mail instead of keeping it forever (the leak).
      const ageMs = now - new Date(p.last_seen).getTime();
      if (pending > 0 && !deadSeatMailExpired(ageMs, DEAD_MAIL_TTL_MS, REHYDRATE_WINDOW_MS)) {
        buckets.delete(p.id);   // drop the live SSE bucket; keep row + mail on disk
        return false;            // still not an active peer — just a retained inbox
      }
      deletePeer.run(p.id);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [p.id]);
      buckets.delete(p.id);
      return false;
    }
    return true;
  });
}

function livePeersForResolution(peers: Peer[]): Peer[] {
  const now = Date.now();
  return peers.filter((p) => !peerIsReapable(p, now));
}

function activeOnly(peers: Peer[]): Peer[] {
  const byKey = new Map<string, Peer>();
  for (const peer of peers) {
    const key = activePeerKey(peer);
    const prior = byKey.get(key);
    if (!prior || new Date(peer.last_seen).getTime() >= new Date(prior.last_seen).getTime()) {
      byKey.set(key, peer);
    }
  }
  return [...byKey.values()];
}

function describePeerTarget(peer: Peer): PeerTarget {
  const clientType = validClientType(peer.client_type);
  return {
    id: peer.id,
    name: peer.name,
    resolved_name: peer.resolved_name,
    seat_key: activePeerKey(peer),
    cwd: peer.cwd,
    git_root: peer.git_root,
    tmux_session: peer.tmux_session,
    tmux_window_index: peer.tmux_window_index,
    tmux_window_name: peer.tmux_window_name,
    tmux_pane_id: peer.tmux_pane_id,
    client_type: clientType,
    receiver_mode: validReceiverMode(peer.receiver_mode, clientType),
    last_hook_seen_at: peer.last_hook_seen_at,
    last_drain_at: peer.last_drain_at,
    last_drain_error: peer.last_drain_error,
    last_seen: peer.last_seen,
  };
}

type ResolvePeerResult =
  | { ok: true; peer: Peer }
  | { ok: false; code: PeerResolveErrorCode; error: string; candidates?: PeerTarget[] };

function selectorFields(selector: PeerSelector | undefined): string[] {
  if (!selector || typeof selector !== "object") return [];
  return [
    typeof selector.id === "string" && selector.id.length > 0 ? "id" : "",
    typeof selector.name === "string" && selector.name.length > 0 ? "name" : "",
    typeof selector.resolved_name === "string" && selector.resolved_name.length > 0 ? "resolved_name" : "",
    typeof selector.seat_key === "string" && selector.seat_key.length > 0 ? "seat_key" : "",
    typeof selector.tmux_session === "string" && selector.tmux_session.length > 0 ? "tmux_session" : "",
    typeof selector.tmux_pane_id === "string" && selector.tmux_pane_id.length > 0 ? "tmux_pane_id" : "",
  ].filter(Boolean);
}

function sameSeatOrName(stale: Peer, live: Peer): boolean {
  if (stale.name && live.name === stale.name) return true;
  if (stale.resolved_name && live.resolved_name === stale.resolved_name) return true;
  if (stale.tmux_session && stale.tmux_pane_id && live.tmux_session === stale.tmux_session && live.tmux_pane_id === stale.tmux_pane_id) return true;
  return activePeerKey(stale) === activePeerKey(live);
}

function peerMatchesSelector(peer: Peer, selector: PeerSelector): boolean {
  if (selector.id && peer.id !== selector.id) return false;
  if (selector.name && peer.name !== selector.name) return false;
  if (selector.resolved_name && peer.resolved_name !== selector.resolved_name) return false;
  if (selector.seat_key && activePeerKey(peer) !== selector.seat_key) return false;
  if (selector.tmux_session && peer.tmux_session !== selector.tmux_session) return false;
  if (selector.tmux_pane_id && peer.tmux_pane_id !== selector.tmux_pane_id) return false;
  return true;
}

function selectorWithoutId(selector: PeerSelector): PeerSelector {
  const { id: _id, ...rest } = selector;
  return rest;
}

function resolveFreshPeer(selector: PeerSelector | undefined): ResolvePeerResult {
  const fields = selectorFields(selector);
  if (fields.length === 0) {
    return { ok: false, code: "INVALID_SELECTOR", error: "target selector must include id, name, resolved_name, seat_key, or tmux pane fields" };
  }
  const targetSelector = selector!;
  if (fields.length === 1 && fields[0] === "tmux_session") {
    return { ok: false, code: "INVALID_SELECTOR", error: "tmux_session alone is not a unique peer selector; include tmux_pane_id or another identity field" };
  }
  if (fields.length === 1 && fields[0] === "tmux_pane_id") {
    return { ok: false, code: "INVALID_SELECTOR", error: "tmux_pane_id alone is not a unique peer selector; include tmux_session or another identity field" };
  }

  const allPeers = selectAllPeers.all() as Peer[];
  const staleById = targetSelector.id ? allPeers.find((p) => p.id === targetSelector.id) ?? null : null;
  const activePeers = activeOnly(livePeersForResolution(allPeers));

  if (targetSelector.id) {
    const liveIdMatch = activePeers.find((p) => p.id === targetSelector.id) ?? null;
    if (liveIdMatch) {
      if (peerMatchesSelector(liveIdMatch, targetSelector)) return { ok: true, peer: liveIdMatch };
      return {
        ok: false,
        code: "PEER_NOT_FOUND",
        error: `Peer ${targetSelector.id} is live but does not match the full target selector`,
        candidates: [describePeerTarget(liveIdMatch)],
      };
    }
    const supplementalSelector = selectorWithoutId(targetSelector);
    const hasSupplementalFields = selectorFields(supplementalSelector).length > 0;
    const candidates = staleById
      ? activePeers
        .filter((p) => sameSeatOrName(staleById, p))
        .filter((p) => !hasSupplementalFields || peerMatchesSelector(p, supplementalSelector))
        .map(describePeerTarget)
      : [];
    if (staleById) {
      return {
        ok: false,
        code: "STALE_PEER_ID",
        error: `Peer ${targetSelector.id} is stale or no longer the active peer for its seat`,
        candidates,
      };
    }
    return { ok: false, code: "PEER_NOT_FOUND", error: `Peer ${targetSelector.id} not found` };
  }

  const matches = activePeers.filter((p) => peerMatchesSelector(p, targetSelector));
  if (matches.length === 0) {
    return { ok: false, code: "PEER_NOT_FOUND", error: "No live peer matched target selector" };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      code: "AMBIGUOUS_TARGET",
      error: `Target selector matched ${matches.length} live peers; use resolved_name, seat_key, or tmux_pane_id`,
      candidates: matches.map(describePeerTarget),
    };
  }
  return { ok: true, peer: matches[0]! };
}

// R1: derive the shared repo root from absolute_git_dir.
//   /repo/.git              -> /repo
//   /repo/.git/worktrees/X  -> /repo
function deriveRepoCommonRoot(absoluteGitDir: string | null): string | null {
  if (!absoluteGitDir) return null;
  const stripped = absoluteGitDir.replace(/\/worktrees\/[^/]+\/?$/, "");
  if (!stripped.endsWith("/.git") && stripped !== ".git") return null;
  const repoRoot = stripped.replace(/\/?\.git$/, "");
  return repoRoot || null;
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo": {
      const callerRepoRoot = deriveRepoCommonRoot(body.absolute_git_dir ?? null);
      if (callerRepoRoot) {
        const all = selectAllPeers.all() as Peer[];
        peers = all.filter((p) => {
          const peerRoot = deriveRepoCommonRoot(p.absolute_git_dir);
          if (peerRoot) return peerRoot === callerRepoRoot;
          // Back-compat: peer pre-A.1 has NULL absolute_git_dir — fall back
          // to git_root equality with caller's stored git_root.
          return body.git_root !== null && p.git_root === body.git_root;
        });
      } else if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    }
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // R6.2
  if (body.has_tmux === true) {
    peers = peers.filter((p) => p.tmux_session !== null && p.tmux_session !== "");
  }

  // R3 — JS substring post-SELECT filter. Mirrors handleBroadcast at
  // broker.ts:739-749 (min 2 chars).
  if (body.name_like && body.name_like.length >= 2) {
    const lower = body.name_like.toLowerCase();
    peers = peers.filter((p) => p.name !== null && p.name.toLowerCase().includes(lower));
  }

  const live = liveAndFreshPeers(peers);
  return body.include_inactive ? live : activeOnly(live);
}

function handleSendMessage(authedFromId: string, body: SendMessageRequest): SendMessageResponse {
  // S6: from_id is ALWAYS the authenticated peer — body.from_id is ignored.
  // S5: payload size cap.
  if (typeof body.text !== "string") return { ok: false, error: "text must be string" };
  if (utf8Bytes(body.text) > MAX_MSG_BYTES) return { ok: false, error: `text exceeds ${MAX_MSG_BYTES} bytes` };
  const resolved = resolveFreshPeer({ id: body.to_id });
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, error: resolved.error, candidates: resolved.candidates };
  }
  const target = resolved.peer;
  const result = insertMessage.run(authedFromId, target.id, body.text, new Date().toISOString());
  return {
    ok: true,
    id: Number(result.lastInsertRowid),
    target: describePeerTarget(target),
  };
}

function handleSendToPeer(authedFromId: string, body: SendToPeerRequest): SendMessageResponse {
  if (typeof body.text !== "string") return { ok: false, error: "text must be string" };
  if (utf8Bytes(body.text) > MAX_MSG_BYTES) return { ok: false, error: `text exceeds ${MAX_MSG_BYTES} bytes` };
  const resolved = resolveFreshPeer(body.selector);
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, error: resolved.error, candidates: resolved.candidates };
  }
  const result = insertMessage.run(authedFromId, resolved.peer.id, body.text, new Date().toISOString());
  return { ok: true, id: Number(result.lastInsertRowid), target: describePeerTarget(resolved.peer) };
}

// /message-status: sender-scoped lookup of delivered/delivered_at for a
// message the sender previously inserted. Returns one entry per requested
// id, or { delivered: false, delivered_at: null } for ids that don't
// match an owned row (never leaks across senders).
function handleMessageStatus(authedFromId: string, body: { ids: number[] }):
  { ok: boolean; statuses: { id: number; delivered: boolean; delivered_at: string | null }[] } {
  if (!Array.isArray(body.ids)) return { ok: true, statuses: [] };
  const statuses = body.ids.map((id) => {
    const row = selectMessageStatus.get(id, authedFromId) as
      { id: number; delivered: number; delivered_at: string | null } | null;
    return row
      ? { id: row.id, delivered: row.delivered === 1, delivered_at: row.delivered_at }
      : { id, delivered: false, delivered_at: null };
  });
  return { ok: true, statuses };
}

// /broadcast-message: fanout send by scope. Requires at least one scope
// filter (tmux_session | git_root | name_like) so a compromised peer can't
// use it for unbounded global blast. Inserts one row per target inside a
// transaction; no at-broker ack behavior differs from single /send-message.
function handleBroadcast(authedFromId: string, body: BroadcastRequest): { ok: boolean; sent: number; error?: string } {
  if (typeof body.text !== "string") return { ok: false, sent: 0, error: "text must be string" };
  if (utf8Bytes(body.text) > MAX_MSG_BYTES) return { ok: false, sent: 0, error: `text exceeds ${MAX_MSG_BYTES} bytes` };

  const tmuxFilter = typeof body.tmux_session === "string" && body.tmux_session.length > 0 ? body.tmux_session : null;
  const gitFilter = typeof body.git_root === "string" && body.git_root.length > 0 ? body.git_root : null;
  const nameFilterRaw = typeof body.name_like === "string" && body.name_like.length > 0 ? body.name_like : null;
  if (!tmuxFilter && !gitFilter && !nameFilterRaw) {
    return { ok: false, sent: 0, error: "at least one scope filter required (tmux_session, git_root, or name_like)" };
  }

  // SEC: name_like must be a real substring, not a SQL wildcard. Reject bare
  // wildcards and require length >= 2 so `name_like='%'` can't sneak past the
  // "scope filter required" guard to match every named peer.
  let nameFilter: string | null = nameFilterRaw;
  if (nameFilter !== null) {
    if (nameFilter.length < 2) {
      return { ok: false, sent: 0, error: "name_like must be at least 2 characters" };
    }
    // Escape SQL LIKE metacharacters (% _ \) so they're treated as literals
    // inside the bind parameter. Prepared statement uses ESCAPE '\'.
    nameFilter = nameFilter.replace(/[\\%_]/g, "\\$&");
    // After escaping, reject if the remaining non-metachar content is empty.
    if (nameFilter.replace(/\\./g, "").length === 0) {
      return { ok: false, sent: 0, error: "name_like must contain non-wildcard characters" };
    }
  }

  const targets = selectBroadcastTargets.all(
    authedFromId,
    tmuxFilter, tmuxFilter,
    gitFilter, gitFilter,
    nameFilter, nameFilter
  ) as { id: string }[];

  const activeIds = new Set(activeOnly(liveAndFreshPeers(selectAllPeers.all() as Peer[])).map((p) => p.id));
  const activeTargets = targets.filter((t) => activeIds.has(t.id));

  // Enforce fanout cap — prevents /broadcast-message from inserting more
  // rows than the per-minute message quota would allow in single-sends.
  if (activeTargets.length > MAX_BROADCAST_TARGETS) {
    return { ok: false, sent: 0, error: `broadcast scope matched ${activeTargets.length} peers — exceeds cap of ${MAX_BROADCAST_TARGETS}. Narrow your filters.` };
  }

  const limited = reserveMessageSlots(authedFromId, activeTargets.length);
  if (limited) {
    return { ok: false, sent: 0, error: `broadcast would exceed per-minute message quota (${limited})` };
  }

  const now = new Date().toISOString();
  let sent = 0;
  db.transaction(() => {
    for (const t of activeTargets) {
      insertMessage.run(authedFromId, t.id, body.text, now);
      sent++;
    }
  })();
  return { ok: true, sent };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectAvailableMessages(body.id);
  // Read-only: caller must explicitly ack via /ack-messages
  return { messages };
}

function handleAckMessages(body: AckMessagesRequest): { ok: boolean; acked: number } {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const via = typeof body.via === "string" && body.via.length > 0 ? body.via : "unknown";
  const acked = db.transaction(() => {
    let count = 0;
    for (const id of body.ids) {
      // Read sent_at BEFORE the UPDATE so we can log the queue→ack latency.
      // Row is null if id doesn't belong to this peer — scoped UPDATE below
      // will also return changes=0 in that case, so we skip the log line.
      const row = selectMsgForLatency.get(id, body.id) as { from_id: string; sent_at: string } | null;
      const result = markDeliveredScoped.run(nowIso, id, body.id);
      if (result.changes > 0 && row) {
        const latencyMs = nowMs - new Date(row.sent_at).getTime();
        console.error(`[broker] deliver id=${id} from=${row.from_id} to=${body.id} via=${via} latency_ms=${latencyMs}`);
      }
      count += result.changes;
    }
    return count;
  })();
  return { ok: true, acked };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

function resolvePidPeer(pid: number): { ok: true; id: string } | { ok: false; peer_id?: string; status?: number; error?: string } {
  if (!Number.isInteger(pid) || pid <= 1) {
    return { ok: false, status: 400, error: "invalid pid" };
  }
  const peerRow = selectPeerIdByPid.get(pid) as { id: string } | null;
  if (!peerRow) return { ok: false, peer_id: "" };
  return { ok: true, id: peerRow.id };
}

function authPidDrain(pid: number, callerPid: number): { ok: true; id: string } | { ok: false; status: number; error: string; peer_id?: string } {
  if (!Number.isInteger(callerPid) || callerPid <= 1) {
    return { ok: false, status: 400, error: "invalid caller_pid" };
  }
  const callerErr = verifyPidUid(callerPid);
  if (callerErr) return { ok: false, status: 403, error: `caller rejected: ${callerErr}` };
  const resolved = resolvePidPeer(pid);
  if (!resolved.ok) {
    return { ok: false, status: resolved.status ?? 404, error: resolved.error ?? "peer not found", peer_id: resolved.peer_id };
  }
  const targetErr = verifyPidUid(pid);
  if (targetErr) return { ok: false, status: 403, error: `target rejected: ${targetErr}` };
  return { ok: true, id: resolved.id };
}

function handleHookHeartbeatByPid(body: HookHeartbeatByPidRequest): { ok: boolean; peer_id?: string; error?: string; status?: number } {
  const auth = authPidDrain(Number(body.pid), Number(body.caller_pid));
  if (!auth.ok) {
    return { ok: false, status: auth.status, error: auth.error };
  }
  const now = new Date().toISOString();
  const status = body.status === "error" ? "error" : "ok";
  const { clientType, receiverMode } = hookMetadata(auth.id, body);
  updateReceiverHealth.run(
    now,
    clientType,
    receiverMode,
    now,
    typeof body.drained === "number" && body.drained > 0 ? now : null,
    status === "error" ? String(body.error ?? "unknown hook error").slice(0, 512) : null,
    auth.id
  );
  return { ok: true, peer_id: auth.id };
}

function handleClaimByPid(body: ClaimByPidRequest): ClaimByPidResponse {
  const auth = authPidDrain(Number(body.pid), Number(body.caller_pid));
  if (!auth.ok) {
    return { ok: false, status: auth.status, error: auth.error };
  }
  const { clientType, receiverMode } = hookMetadata(auth.id, body);

  const limitRaw = Number(body.limit ?? CLAIM_MAX_MESSAGES);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(Math.floor(limitRaw), CLAIM_MAX_MESSAGES)
    : CLAIM_MAX_MESSAGES;
  const maxBytesRaw = Number(body.max_bytes ?? CLAIM_MAX_BYTES);
  const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0
    ? Math.min(Math.floor(maxBytesRaw), CLAIM_MAX_BYTES)
    : CLAIM_MAX_BYTES;
  const drainId = typeof body.drain_id === "string" && body.drain_id.length > 0
    ? body.drain_id.slice(0, 160)
    : generateDrainId(auth.id);
  const now = new Date().toISOString();
  const cutoff = claimCutoffIso();

  const claimedMessages: Message[] = [];
  db.transaction(() => {
    const candidates = selectUndelivered.all(auth.id, cutoff) as Message[];
    let bytes = 0;
    for (const m of candidates) {
      if (claimedMessages.length >= limit) break;
      const nextBytes = utf8Bytes(m.text);
      if (bytes + nextBytes > maxBytes) break;
      const result = claimMessage.run(drainId, now, m.id, auth.id, cutoff);
      if (result.changes > 0) {
        claimedMessages.push(m);
        bytes += nextBytes;
      }
    }
  })();

  updateReceiverHealth.run(now, clientType, receiverMode, now, null, null, auth.id);
  return { ok: true, peer_id: auth.id, drain_id: drainId, messages: claimedMessages };
}

function handleAckByPid(body: AckByPidRequest): { ok: boolean; peer_id?: string; acked?: number; error?: string; status?: number } {
  const auth = authPidDrain(Number(body.pid), Number(body.caller_pid));
  if (!auth.ok) {
    return { ok: false, status: auth.status, error: auth.error };
  }
  const { clientType, receiverMode } = hookMetadata(auth.id, body);
  const drainId = typeof body.drain_id === "string" ? body.drain_id : "";
  if (!drainId) return { ok: false, status: 400, error: "missing drain_id" };
  const ids = Array.isArray(body.ids) ? body.ids.filter((id) => Number.isInteger(id)) : [];
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const via = typeof body.via === "string" && body.via.length > 0 ? body.via : "hook";
  const acked = db.transaction(() => {
    let count = 0;
    for (const id of ids) {
      const row = selectMsgForLatency.get(id, auth.id) as { from_id: string; sent_at: string } | null;
      const result = markDeliveredClaimedScoped.run(nowIso, id, auth.id, drainId);
      if (result.changes > 0 && row) {
        const latencyMs = nowMs - new Date(row.sent_at).getTime();
        console.error(`[broker] deliver id=${id} from=${row.from_id} to=${auth.id} via=${via} latency_ms=${latencyMs}`);
      }
      count += result.changes;
    }
    return count;
  })();
  const drainError = ids.length > 0 && acked !== ids.length
    ? `ack mismatch: requested ${ids.length}, acked ${acked}`
    : null;
  updateReceiverHealth.run(nowIso, clientType, receiverMode, nowIso, acked > 0 ? nowIso : null, drainError, auth.id);
  return { ok: true, peer_id: auth.id, acked };
}

// /poll-by-pid: unauthenticated-by-token, PID-authenticated drain path used
// by the UserPromptSubmit hook to surface pending peer mail without having
// the MCP server's in-memory auth token. Atomically fetches undelivered
// messages for the peer whose row has pid=<target_pid>, marks them
// delivered, and returns them. Caller proves same-UID via verifyPidUid.
function handlePollByPid(body: { pid: number; caller_pid: number }): {
  ok: boolean;
  error?: string;
  status?: number;
  peer_id?: string;
  messages?: Message[];
  acked?: number;
} {
  const auth = authPidDrain(body.pid, body.caller_pid);
  if (!auth.ok) {
    if (auth.peer_id === "") return { ok: true, peer_id: "", messages: [], acked: 0 };
    return { ok: false, status: auth.status, error: auth.error };
  }

  // Atomically fetch + mark delivered + log latency (matches handleAckMessages).
  // Concurrent-drain safety: the SELECT happens before the transaction begins,
  // so two concurrent /poll-by-pid calls for the same peer can each fetch the
  // same undelivered rows. Only one's UPDATE will change delivered (0→1); the
  // other's UPDATE returns changes=0. Return ONLY the rows THIS call actually
  // acked so the wire response matches broker state (no duplicate delivery).
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const fetched = selectAvailableMessages(auth.id);
  const ackedMessages: Message[] = [];
  const acked = db.transaction(() => {
    let count = 0;
    for (const m of fetched) {
      const result = markDeliveredScoped.run(nowIso, m.id, auth.id);
      if (result.changes > 0) {
        ackedMessages.push(m);
        const latencyMs = nowMs - new Date(m.sent_at).getTime();
        console.error(`[broker] deliver id=${m.id} from=${m.from_id} to=${auth.id} via=poll-by-pid latency_ms=${latencyMs}`);
        count++;
      }
    }
    return count;
  })();

  // Record drain health for Claude peers — the codex updateReceiverHealth path
  // never runs for them, so without this their last_hook_seen_at/last_drain_at
  // stay NULL and the fleet's drain state is unobservable. nowIso always (the
  // hook polled); last_drain_at only when mail was acked (mirrors codex ack).
  updateClaudeDrainHealth.run(nowIso, acked > 0 ? nowIso : null, auth.id);

  return { ok: true, peer_id: auth.id, messages: ackedMessages, acked };
}

// --- HTTP Server ---

const server = Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({
          status: "ok",
          peers: (selectAllPeers.all() as Peer[]).length,
          version: BROKER_VERSION,
          capabilities: BROKER_CAPABILITIES,
        });
      }
      // AP-063: bridge cursor read. Bridge daemon polls this every 2s.
      if (path === "/messages-since-id") {
        const auth = authBridge(req, path);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        const limited = rateCheck(BRIDGE_RATE_KEY, false);
        if (limited) {
          return new Response(JSON.stringify({ error: limited }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": String(Math.ceil(RATE_WINDOW_MS / 1000)) },
          });
        }
        const sinceRaw = url.searchParams.get("since");
        const limitRaw = url.searchParams.get("limit");
        const sinceParsed = parseInt(sinceRaw ?? "0", 10);
        const since = Number.isFinite(sinceParsed) && sinceParsed >= 0 ? sinceParsed : 0;
        const limitParsed = parseInt(limitRaw ?? "100", 10);
        const limit = Number.isFinite(limitParsed) && limitParsed >= 1 && limitParsed <= 1000 ? limitParsed : 100;
        const rows = selectMessagesSinceId.all(since, limit) as Array<{ id: number; from_id: string; to_id: string; text: string; sent_at: string; delivered: number }>;
        const cursor = rows.length > 0 ? Math.max(...rows.map((r) => r.id)) : since;
        return Response.json({ messages: rows, cursor, limit, count: rows.length });
      }
      return new Response("claude-peers broker", { status: 200 });
    }

    // S5: bound the request body before parsing JSON. Bun's req.json()
    // would otherwise happily allocate hundreds of MB if a peer goes rogue.
    const lenHdr = req.headers.get("content-length");
    if (lenHdr && parseInt(lenHdr, 10) > MAX_REQ_BYTES) {
      return Response.json({ error: `request exceeds ${MAX_REQ_BYTES} bytes` }, { status: 413 });
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch (e) {
      return Response.json({ error: `invalid json: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
    }

    try {
      // /register is the only unauthenticated route — it issues the token.
      if (path === "/register") {
        const result = handleRegister(body as unknown as RegisterRequest);
        if (!result.ok) {
          return Response.json({ error: result.error }, { status: result.status });
        }
        // S5: count the registration request against the new peer's bucket.
        rateCheck(result.value.id, false);
        return Response.json(result.value);
      }

      // /poll-by-pid: PID-authenticated alternate drain path for the hook
      // (no X-Peer-Token header — caller_pid + same-UID check is the auth).
      // Rate-limit bucket keyed by caller_pid string.
      if (path === "/poll-by-pid") {
        const rawPid = Number(body.pid);
        const rawCallerPid = Number(body.caller_pid);
        const rlKey = `pid:${Number.isFinite(rawCallerPid) ? rawCallerPid : "invalid"}`;
        const limited = rateCheck(rlKey, false);
        if (limited) {
          return new Response(JSON.stringify({ error: limited }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": String(Math.ceil(RATE_WINDOW_MS / 1000)) },
          });
        }
        const res = handlePollByPid({ pid: rawPid, caller_pid: rawCallerPid });
        if (!res.ok) {
          return Response.json({ error: res.error }, { status: res.status ?? 400 });
        }
        return Response.json({ peer_id: res.peer_id, messages: res.messages, acked: res.acked });
      }

      if (path === "/claim-by-pid" || path === "/ack-by-pid" || path === "/hook-heartbeat-by-pid") {
        const rawCallerPid = Number(body.caller_pid);
        const rlKey = `pid:${Number.isFinite(rawCallerPid) ? rawCallerPid : "invalid"}`;
        const limited = rateCheck(rlKey, false);
        if (limited) {
          return new Response(JSON.stringify({ error: limited }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": String(Math.ceil(RATE_WINDOW_MS / 1000)) },
          });
        }
        if (path === "/claim-by-pid") {
          const res = handleClaimByPid(body as unknown as ClaimByPidRequest);
          if (!res.ok) return Response.json({ error: res.error }, { status: res.status ?? 400 });
          return Response.json({ peer_id: res.peer_id, drain_id: res.drain_id, messages: res.messages });
        }
        if (path === "/ack-by-pid") {
          const res = handleAckByPid(body as unknown as AckByPidRequest);
          if (!res.ok) return Response.json({ error: res.error }, { status: res.status ?? 400 });
          return Response.json({ peer_id: res.peer_id, acked: res.acked });
        }
        const res = handleHookHeartbeatByPid(body as unknown as HookHeartbeatByPidRequest);
        if (!res.ok) return Response.json({ error: res.error }, { status: res.status ?? 400 });
        return Response.json({ ok: true, peer_id: res.peer_id });
      }

      // S2/S6: authenticate every other route. The peer ID comes from the
      // token lookup; the body's `id`/`from_id` is overwritten.
      // H2: do NOT include `exclude_id` in the chain — it is "id to exclude
      // from results", not an identity claim. Conflating them weakens the
      // model (a leaked token + the target's id in exclude_id would auth
      // as the target).
      const claimedId = reqStrict(body.id) || reqStrict(body.from_id);
      const auth = authPeer(req, claimedId, path);
      if (!auth.ok) return Response.json({ error: auth.error, reregister: true }, { status: auth.status });

      // S5 + M5: rate limit. /heartbeat is exempt — already bounded by the
      // client-side HEARTBEAT_INTERVAL_MS, and 429-ing it would cascade into
      // ghost-reaping a perfectly healthy peer.
      if (path !== "/heartbeat") {
        const limited = rateCheck(auth.id, path === "/send-message" || path === "/send-to-peer");
        if (limited) {
          return new Response(JSON.stringify({ error: limited }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": String(Math.ceil(RATE_WINDOW_MS / 1000)) },
          });
        }
      }

      switch (path) {
        case "/heartbeat":
          {
            const heartbeat: HeartbeatRequest = { id: auth.id };
            if (body.client_type === "claude" || body.client_type === "codex" || body.client_type === "gemini" || body.client_type === "unknown") {
              heartbeat.client_type = body.client_type;
            }
            if (
              body.receiver_mode === "claude-channel" ||
              body.receiver_mode === "codex-hook" ||
              body.receiver_mode === "gemini-hook" ||
              body.receiver_mode === "manual-drain" ||
              body.receiver_mode === "unknown"
            ) {
              heartbeat.receiver_mode = body.receiver_mode;
            }
            handleHeartbeat(heartbeat);
            const target = selectPeerById.get(auth.id) as Peer | null;
            const clientType = validClientType(target?.client_type);
            const response: HeartbeatResponse = {
              ok: true,
              client_type: clientType,
              receiver_mode: validReceiverMode(target?.receiver_mode, clientType),
            };
            // Seat-supersede (one-shot): a newer process took this peer's exact
            // tmux seat → tell this old server to step down. Cleared on send so the
            // signal fires exactly once; if the old server ignores it (already
            // exiting / hung) it simply won't heartbeat again.
            if (supersededPeerIds.delete(auth.id)) {
              response.superseded = true;
              console.error(`[broker] seat-supersede: told ${auth.id} to step down (superseded by a newer same-seat registrant)`);
            }
            return Response.json(response);
          }
        case "/set-summary": {
          const summary = String(body.summary ?? "");
          if (utf8Bytes(summary) > MAX_SUMMARY_BYTES) {
            return Response.json({ error: `summary exceeds ${MAX_SUMMARY_BYTES} bytes` }, { status: 413 });
          }
          handleSetSummary({ id: auth.id, summary });
          return Response.json({ ok: true });
        }
        case "/set-name": {
          const name = String(body.name ?? "");
          if (utf8Bytes(name) > MAX_NAME_BYTES) {
            return Response.json({ error: `name exceeds ${MAX_NAME_BYTES} bytes` }, { status: 413 });
          }
          // Return the operator-facing stored name. Runtime dedup is exposed
          // separately as resolved_name via /register and /list-peers.
          const stored = handleSetName({ id: auth.id, name });
          return Response.json({ ok: true, name: stored.name, resolved_name: stored.resolved_name });
        }
        case "/list-peers":
          // Pass body through as-is; server.ts sets exclude_id explicitly when
          // it wants self-exclusion, but tests and ad-hoc callers may want to
          // see themselves in the listing.
          return Response.json(handleListPeers(body as unknown as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(auth.id, body as unknown as SendMessageRequest));
        case "/send-to-peer":
          return Response.json(handleSendToPeer(auth.id, body as unknown as SendToPeerRequest));
        case "/broadcast-message":
          return Response.json(handleBroadcast(auth.id, body as unknown as BroadcastRequest));
        case "/message-status":
          return Response.json(handleMessageStatus(auth.id, { ids: (body.ids as number[]) ?? [] }));
        case "/poll-messages":
          return Response.json(handlePollMessages({ id: auth.id }));
        case "/ack-messages":
          return Response.json(handleAckMessages({
            id: auth.id,
            ids: (body.ids as number[]) ?? [],
            via: typeof body.via === "string" ? body.via : undefined,
          }));
        case "/unregister":
          handleUnregister({ id: auth.id });
          buckets.delete(auth.id);
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      // H4: log full error + stack server-side, return a generic message
      // to the client. The previous behavior surfaced raw e.message which
      // could leak filesystem paths (e.g. /proc errors), DB schema details,
      // or prepared-statement diagnostics.
      console.error(`[broker] unhandled error on ${path}:`, e);
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  },
});

// S1: final post-bind assertion. If anything (Bun version drift, future
// refactor) ever made the listener bind off-loopback, exit immediately.
if (server.hostname !== "127.0.0.1") {
  console.error(`[claude-peers broker] FATAL: post-bind hostname is ${server.hostname}, expected 127.0.0.1`);
  process.exit(2);
}

publishBridgeTokenFile();
console.error(`[claude-peers broker] listening on ${server.hostname}:${PORT} (db: ${DB_PATH}, uid: ${MY_UID})`);
