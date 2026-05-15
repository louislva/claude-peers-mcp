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
import { readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
// L6: top-level node:fs import (was inline require() in verifyPidUid hot path).
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  SetNameRequest,
  BroadcastRequest,
  ListPeersRequest,
  SendMessageRequest,
  SendMessageResponse,
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
  Message,
} from "./shared/types.ts";
// #7 narrow (2026-05-14): predicate + TTL constant extracted to shared/
// so tests can import the real symbol without spawning broker.ts (which
// has top-level Bun.serve at line ~930 — module import would conflict
// on port 7899). Full broker.ts module-extraction is a separate larger
// follow-up; this narrow extraction unlocks load-bearing test mirrors
// for the reap predicate without touching the broker's startup shape.
import { isReapable, PEER_GHOST_AFTER_MS } from "./shared/reaper.ts";

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
  liveAndFreshPeers(selectAllPeers.all() as Peer[]);
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

const selectPeerByToken = db.prepare(`
  SELECT id, pid, token FROM peers WHERE id = ? AND token = ?
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateHeartbeatSeen = db.prepare(`
  UPDATE peers
  SET last_seen = ?,
      client_type = ?,
      receiver_mode = CASE
        WHEN receiver_mode = 'codex-hook' AND ? = 'manual-drain' THEN receiver_mode
        ELSE ?
      END
  WHERE id = ?
`);

const updateReceiverHealth = db.prepare(`
  UPDATE peers
  SET client_type = 'codex',
      receiver_mode = ?,
      last_hook_seen_at = ?,
      last_drain_at = COALESCE(?, last_drain_at),
      last_drain_error = ?
  WHERE id = ?
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

// Rehydration candidate lookup. Matches the tmux location tuple + cwd of the
// incoming register, limited to the most recent 3 candidates so the liveness
// check loop terminates quickly. Excludes the caller's own PID — a live peer
// re-registering its own session is a legitimate case handled by the existing
// PID-dedup path, not rehydration.
const selectRehydrateCandidates = db.prepare(`
  SELECT id, pid, last_seen FROM peers
  WHERE tmux_session = ?
    AND (
      (? IS NOT NULL AND tmux_pane_id = ?)
      OR (? IS NULL AND tmux_window_index = ? AND tmux_window_name = ?)
    )
    AND cwd = ? AND pid != ?
  ORDER BY last_seen DESC LIMIT 3
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
const selectBroadcastTargets = db.prepare(`
  SELECT id FROM peers
  WHERE id != ?
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
try {
  // Atomic write: tmp + chmod + rename. Avoids partial-token race during read.
  const tmp = `${BRIDGE_TOKEN_FILE}.tmp`;
  writeFileSync(tmp, BRIDGE_TOKEN, { mode: 0o600 });
  chmodSync(tmp, 0o600);  // belt-and-braces: writeFileSync mode is umask-affected
  renameSync(tmp, BRIDGE_TOKEN_FILE);
  console.error(`[broker] bridge token written to ${BRIDGE_TOKEN_FILE}`);
} catch (e) {
  console.error(`[broker] FATAL: cannot write bridge token to ${BRIDGE_TOKEN_FILE}:`, e);
  process.exit(2);
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
  return value === "claude" || value === "codex" || value === "unknown" ? value : "unknown";
}

function validReceiverMode(value: unknown, clientType: ClientType): ReceiverMode {
  if (clientType === "claude") return "claude-channel";
  if (clientType === "codex") {
    return value === "codex-hook" || value === "manual-drain" ? value : "manual-drain";
  }
  return "unknown";
}

function initialReceiverModeFromRegistration(value: unknown, clientType: ClientType): ReceiverMode {
  const mode = validReceiverMode(value, clientType);
  return clientType === "codex" && mode === "codex-hook" ? "manual-drain" : mode;
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

  // Rehydration: if a recently-dead peer occupied the same tmux location
  // (session + window + pane + cwd), inherit its ID so mail addressed to it
  // surfaces to this new session. Matched on the full location tuple to
  // prevent cross-pane identity leakage.
  let inheritedId: string | null = null;
  if (body.tmux_session && body.tmux_window_index !== null && body.tmux_window_index !== undefined && body.tmux_window_name) {
    const candidates = selectRehydrateCandidates.all(
      body.tmux_session,
      body.tmux_pane_id ?? null,
      body.tmux_pane_id ?? null,
      body.tmux_pane_id ?? null,
      body.tmux_window_index,
      body.tmux_window_name,
      body.cwd,
      body.pid
    ) as { id: string; pid: number; last_seen: string }[];
    for (const c of candidates) {
      const ageMs = Date.now() - new Date(c.last_seen).getTime();
      if (ageMs > REHYDRATE_WINDOW_MS) continue;
      // Skip if the candidate's PID is still alive OR owned by a different UID
      // (EPERM path — PID got recycled to a non-us process). Only ESRCH ("No
      // such process") means the slot is genuinely dead and inheritable.
      try {
        process.kill(c.pid, 0);
        continue; // alive — skip
      } catch (e) {
        const code = (e as { code?: string } | undefined)?.code;
        if (code === "EPERM") continue; // alive-under-different-uid — don't inherit
        // ESRCH or undefined → dead → inherit (fall through)
      }
      inheritedId = c.id;
      deletePeer.run(c.id);
      buckets.delete(c.id);
      console.error(`[broker] rehydrate: new pid=${body.pid} inherits id=${c.id} from dead pid=${c.pid} (age_ms=${ageMs})`);
      break;
    }
  }

  const id = inheritedId ?? generateId();

  // Existing PID-dedup: a live peer re-registering must replace its own row.
  // Guarded against clobbering the inherited row we just re-created above.
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing && existing.id !== id) {
    deletePeer.run(existing.id);
    buckets.delete(existing.id);
  }

  // Runtime-name de-dupe: keep the operator-facing name unchanged, but assign
  // a broker-unique resolved_name for diagnostics and exact process identity.
  const requestedName = body.name ?? null;
  const finalName = disambiguateName(requestedName, id);
  const clientType = validClientType(body.client_type);
  const receiverMode = initialReceiverModeFromRegistration(body.receiver_mode, clientType);
  if (requestedName && finalName !== requestedName) {
    console.error(`[broker] name dedup: pid=${body.pid} requested="${requestedName}" resolved="${finalName}" (collision)`);
  }
  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.absolute_git_dir ?? null, body.tty, requestedName, finalName, body.tmux_session ?? null, body.tmux_window_index ?? null, body.tmux_window_name ?? null, body.tmux_pane_id ?? null, clientType, receiverMode, body.summary, now, now, token);
  return { ok: true, value: { id, token, name: requestedName, resolved_name: finalName, client_type: clientType, receiver_mode: receiverMode } };
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
    updateHeartbeatSeen.run(now, clientType, receiverMode, receiverMode, body.id);
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
  const final = disambiguateName(desired, body.id);
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
function disambiguateName(rawName: string | null, selfId: string): string | null {
  if (!rawName) return null;
  const rows = db.query(
    "SELECT pid, COALESCE(resolved_name, name) AS name FROM peers WHERE COALESCE(resolved_name, name) IS NOT NULL AND id != ?"
  ).all(selfId) as { pid: number; name: string }[];
  const liveNames = new Set(
    rows.filter(r => isPidAlive(r.pid)).map(r => r.name)
  );
  if (!liveNames.has(rawName)) return rawName;
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
function liveAndFreshPeers(peers: Peer[]): Peer[] {
  const now = Date.now();
  return peers.filter((p) => {
    if (isReapable(p, isPidAlive, now, PEER_GHOST_AFTER_MS)) {
      deletePeer.run(p.id);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [p.id]);
      buckets.delete(p.id);
      return false;
    }
    return true;
  });
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
  const target = db.query("SELECT id, client_type, receiver_mode, last_hook_seen_at, last_drain_error, last_seen FROM peers WHERE id = ?").get(body.to_id) as {
    id: string;
    client_type: ClientType | null;
    receiver_mode: ReceiverMode | null;
    last_hook_seen_at: string | null;
    last_drain_error: string | null;
    last_seen: string | null;
  } | null;
  if (!target) return { ok: false, error: `Peer ${body.to_id} not found` };
  const result = insertMessage.run(authedFromId, body.to_id, body.text, new Date().toISOString());
  return {
    ok: true,
    id: Number(result.lastInsertRowid),
    target: {
      id: target.id,
      client_type: validClientType(target.client_type),
      receiver_mode: validReceiverMode(target.receiver_mode, validClientType(target.client_type)),
      last_hook_seen_at: target.last_hook_seen_at,
      last_drain_error: target.last_drain_error,
      last_seen: target.last_seen,
    },
  };
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

  // Charge N-1 additional message-bucket slots (the route handler already
  // ticked 1 at entry). If this would exceed the quota, reject WITHOUT
  // inserting so the sender can't burst past their rate limit via fanout.
  // Note: first tick has already been consumed upstream; we simulate the
  // remaining N-1 by calling rateCheck in isMessage=true mode.
  for (let i = 0; i < activeTargets.length - 1; i++) {
    const limited = rateCheck(authedFromId, true);
    if (limited) {
      return { ok: false, sent: 0, error: `broadcast would exceed per-minute message quota (${limited})` };
    }
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
  updateReceiverHealth.run(
    "codex-hook",
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

  updateReceiverHealth.run("codex-hook", now, null, null, auth.id);
  return { ok: true, peer_id: auth.id, drain_id: drainId, messages: claimedMessages };
}

function handleAckByPid(body: AckByPidRequest): { ok: boolean; peer_id?: string; acked?: number; error?: string; status?: number } {
  const auth = authPidDrain(Number(body.pid), Number(body.caller_pid));
  if (!auth.ok) {
    return { ok: false, status: auth.status, error: auth.error };
  }
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
  updateReceiverHealth.run("codex-hook", nowIso, acked > 0 ? nowIso : null, drainError, auth.id);
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
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
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
        const limited = rateCheck(auth.id, path === "/send-message" || path === "/broadcast-message");
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
            if (body.client_type === "claude" || body.client_type === "codex" || body.client_type === "unknown") {
              heartbeat.client_type = body.client_type;
            }
            if (
              body.receiver_mode === "claude-channel" ||
              body.receiver_mode === "codex-hook" ||
              body.receiver_mode === "manual-drain" ||
              body.receiver_mode === "unknown"
            ) {
              heartbeat.receiver_mode = body.receiver_mode;
            }
            handleHeartbeat(heartbeat);
          }
          return Response.json({ ok: true });
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

console.error(`[claude-peers broker] listening on ${server.hostname}:${PORT} (db: ${DB_PATH}, uid: ${MY_UID})`);
