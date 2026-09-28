#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * HTTP server backed by SQLite, listening on a Unix domain socket.
 * Tracks all registered AI coding agent peers and routes messages between them.
 * Unix sockets bypass macOS seatbelt sandbox restrictions that block TCP localhost.
 *
 * Managed by launchd (com.minoan.claude-peers-broker.plist).
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import { existsSync, unlinkSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_SOCKET_PATH } from "./shared/types.ts";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  SendMessageResponse,
  PollMessagesRequest,
  PollMessagesResponse,
  AckMessagesRequest,
  AckMessagesResponse,
  SetWakeRequest,
  SetWakeResponse,
  UnreadSummaryRequest,
  UnreadSummaryResponse,
  Peer,
  Message,
  WakeTransport,
} from "./shared/types.ts";
import { deliverWake, validateWake, wakeText } from "./wake.ts";

const SOCKET_PATH = DEFAULT_SOCKET_PATH;
const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const MAX_MESSAGE_SIZE = 10_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// --- Database setup ---

// The database holds Claude inbox tokens; keep it and its WAL/SHM files owner-only.
process.umask(0o077);
for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  if (existsSync(file)) chmodSync(file, 0o600);
}

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");
db.run("PRAGMA foreign_keys = ON");

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

// Idempotent column migrations.
function addColumn(table: string, definition: string) {
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("duplicate column name")) {
      throw e;
    }
  }
}

addColumn("peers", "client_type TEXT NOT NULL DEFAULT 'claude-code'");
addColumn("peers", "agent_pid INTEGER");
addColumn("peers", "wake_transport TEXT");
addColumn("peers", "wake_address TEXT");
addColumn("peers", "wake_secret TEXT");
addColumn("peers", "wake_batch_open INTEGER NOT NULL DEFAULT 0");
addColumn("peers", "last_wake_status TEXT");
addColumn("peers", "last_wake_at TEXT");
addColumn("peers", "wake_reserved_at INTEGER");

// Wake address and secret stay inside the broker.
const PUBLIC_PEER_COLUMNS =
  "id, pid, agent_pid, cwd, git_root, tty, client_type, summary, registered_at, last_seen, wake_transport, " +
  "last_wake_status, last_wake_at";

// A queued nudge is never acknowledged, so an unanswered reservation re-arms after this long.
// It matches Claude Code's default dialogExpiry for held cross-session messages.
const WAKE_REARM_MS = Number(process.env.CLAUDE_PEERS_WAKE_REARM_MS ?? 5 * 60 * 1000);

// from_id FK removed — validated in application code (allows "cli" sender).
// to_id FK with CASCADE ensures messages are cleaned up when a peer is deleted.
db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (to_id) REFERENCES peers(id) ON DELETE CASCADE
  )
`);

// --- Rate limiting state ---

const rateLimitMap = new Map<string, number[]>();

function isRateLimited(fromId: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(fromId) ?? [];
  // Remove entries outside the window
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  rateLimitMap.set(fromId, recent);
  if (recent.length >= RATE_LIMIT_MAX) {
    return true;
  }
  recent.push(now);
  return false;
}

// --- Idle timeout state ---

let lastPeerActivity = Date.now();
let idleCheckTimer: ReturnType<typeof setInterval> | null = null;

function resetIdleTimer() {
  lastPeerActivity = Date.now();
}

function checkIdleShutdown() {
  const peerCount = (db.query("SELECT COUNT(*) as count FROM peers").get() as { count: number }).count;
  if (peerCount === 0 && Date.now() - lastPeerActivity > IDLE_TIMEOUT_MS) {
    console.error("[claude-peers broker] No peers for 5 minutes, shutting down");
    db.close();
    try { unlinkSync(SOCKET_PATH); } catch {}
    process.exit(0);
  }
}

function isAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Remove a peer without losing mail. Unread messages addressed to it move to `heir` or to the
// newest live sibling under the same agent process; unread messages it sent stay deliverable.
// With no heir while the agent itself lives, a restarted MCP server is probably about to
// register, so the peer is kept until a later sweep. Returns whether the peer was removed.
// Uses inline SQL because the sweep runs before prepared statements exist.
function retirePeer(peerId: string, heir?: string): boolean {
  let successor = heir ?? null;
  if (!successor) {
    const row = db.query("SELECT agent_pid FROM peers WHERE id = ?").get(peerId) as { agent_pid: number | null } | null;
    if (row?.agent_pid) {
      const siblings = db
        .query("SELECT id, pid FROM peers WHERE agent_pid = ? AND id != ? ORDER BY registered_at DESC")
        .all(row.agent_pid, peerId) as { id: string; pid: number }[];
      successor = siblings.find((s) => isAlive(s.pid))?.id ?? null;
      const unread = db.query("SELECT COUNT(*) AS n FROM messages WHERE to_id = ? AND delivered = 0").get(peerId) as {
        n: number;
      };
      if (!successor && unread.n > 0 && isAlive(row.agent_pid)) return false;
    }
  }
  if (successor) db.run("UPDATE messages SET to_id = ? WHERE to_id = ? AND delivered = 0", [successor, peerId]);
  db.run("DELETE FROM messages WHERE from_id = ? AND delivered = 1", [peerId]);
  db.run("DELETE FROM peers WHERE id = ?", [peerId]);
  return true;
}

// Clean up stale peers (PIDs that no longer exist or orphaned with PPID=1)
function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    let isStale = false;
    if (isAlive(peer.pid)) {
      // PID alive — check if orphaned (reparented to init/launchd)
      const proc = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(peer.pid)]);
      const ppid = parseInt(new TextDecoder().decode(proc.stdout).trim(), 10);
      if (ppid === 1) {
        isStale = true;
        try { process.kill(peer.pid, "SIGTERM"); } catch {}
        console.error(`[claude-peers broker] Killed orphaned peer ${peer.id} (PID ${peer.pid})`);
      }
    } else {
      isStale = true;
    }
    if (isStale) retirePeer(peer.id);
  }
  checkIdleShutdown();
}

cleanStalePeers();

setInterval(cleanStalePeers, Number(process.env.CLAUDE_PEERS_SWEEP_MS ?? 30_000));

// Check idle shutdown every 60s
idleCheckTimer = setInterval(checkIdleShutdown, 60_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, agent_pid, cwd, git_root, tty, client_type, summary, registered_at, last_seen,
                     wake_transport, wake_address, wake_secret)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT ${PUBLIC_PEER_COLUMNS} FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT ${PUBLIC_PEER_COLUMNS} FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT ${PUBLIC_PEER_COLUMNS} FROM peers WHERE git_root = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const selectHistory = db.prepare(`
  SELECT * FROM messages
  WHERE to_id = ? OR from_id = ?
  ORDER BY sent_at DESC
  LIMIT ?
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

const ackMessage = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ? AND to_id = ? AND delivered = 0
`);

const selectWakeTarget = db.prepare(`
  SELECT wake_transport, wake_address, wake_secret FROM peers WHERE id = ?
`);

const selectInheritableWake = db.prepare(`
  SELECT wake_transport, wake_address, wake_secret FROM peers
  WHERE agent_pid = ? AND wake_transport IS NOT NULL
  ORDER BY registered_at DESC LIMIT 1
`);

const selectSender = db.prepare(`
  SELECT client_type, cwd FROM peers WHERE id = ?
`);

// Reserve the single wake that covers a peer's current unread batch, or take over a stale one.
const reserveWake = db.prepare(`
  UPDATE peers SET wake_batch_open = 1, wake_reserved_at = ?1
  WHERE id = ?2 AND (wake_batch_open = 0 OR wake_reserved_at IS NULL OR wake_reserved_at < ?1 - ?3)
`);

const clearWakeBatch = db.prepare(`
  UPDATE peers SET wake_batch_open = 0 WHERE id = ?
`);

const recordWakeStatus = db.prepare(`
  UPDATE peers SET last_wake_status = ?, last_wake_at = ? WHERE id = ?
`);

// Only Codex peers take a thread ID this way; Claude peers register their own inbox socket.
const setWakeForAgent = db.prepare(`
  UPDATE peers SET wake_transport = ?, wake_address = ?, wake_secret = NULL, wake_batch_open = 0
  WHERE agent_pid = ? AND client_type = 'codex'
`);

const selectPeerIdsForAgent = db.prepare(`
  SELECT id FROM peers WHERE agent_pid = ?
`);

const selectUnreadForAgent = db.prepare(`
  SELECT m.from_id FROM messages m JOIN peers p ON p.id = m.to_id
  WHERE p.agent_pid = ? AND m.delivered = 0
  ORDER BY m.sent_at ASC
`);

type WakeRow = { wake_transport: WakeTransport | null; wake_address: string | null; wake_secret: string | null };

const checkPeerExists = db.prepare(`
  SELECT id FROM peers WHERE id = ?
`);

// --- Generate peer ID ---

function generateId(): string {
  return crypto.randomUUID().slice(0, 8);
}

// --- Request handlers ---

function isSocket(path: string | undefined): boolean {
  try {
    return path != null && statSync(path).isSocket();
  } catch {
    return false;
  }
}

function resolveRegisterWake(body: RegisterRequest): WakeRow {
  if (body.wake_transport) {
    let error = validateWake(body.wake_transport, body.wake_address, body.wake_secret);
    if (!error && body.wake_transport === "claude_inbox" && !isSocket(body.wake_address)) {
      error = "inbox address is not a live socket";
    }
    if (!error) {
      return {
        wake_transport: body.wake_transport,
        wake_address: body.wake_address ?? null,
        wake_secret: body.wake_secret ?? null,
      };
    }
    console.error(`[claude-peers broker] Ignoring wake endpoint for PID ${body.pid}: ${error}`);
  }
  // A Codex thread ID arrives once per agent through /set-wake; peers spawned later inherit it.
  if (body.agent_pid) {
    const inherited = selectInheritableWake.get(body.agent_pid) as WakeRow | null;
    if (inherited) return inherited;
  }
  return { wake_transport: null, wake_address: null, wake_secret: null };
}

const registerTransaction = db.transaction((body: RegisterRequest) => {
  const id = generateId();
  const now = new Date().toISOString();
  const wake = resolveRegisterWake(body);

  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;

  const clientType = body.client_type ?? "claude-code";
  insertPeer.run(
    id,
    body.pid,
    body.agent_pid ?? null,
    body.cwd,
    body.git_root,
    body.tty,
    clientType,
    body.summary,
    now,
    now,
    wake.wake_transport,
    wake.wake_address,
    wake.wake_secret,
  );
  // Re-registration under the same PID: the new row inherits the old one's unread messages.
  if (existing) retirePeer(existing.id, id);
  // A restarted MCP server takes over mail its dead predecessors under the same agent still hold,
  // so check_messages sees it now rather than after the next sweep.
  if (body.agent_pid) {
    const predecessors = db
      .query("SELECT id, pid FROM peers WHERE agent_pid = ? AND id != ?")
      .all(body.agent_pid, id) as { id: string; pid: number }[];
    for (const peer of predecessors) {
      if (!isAlive(peer.pid)) retirePeer(peer.id, id);
    }
  }
  return { id };
});

function handleRegister(body: RegisterRequest): RegisterResponse {
  resetIdleTimer();
  return registerTransaction(body);
}

function handleHeartbeat(body: HeartbeatRequest): void {
  resetIdleTimer();
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
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
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Hide dead peers; retire them only in ways that keep their unread messages.
  return peers.filter((p) => {
    if (isAlive(p.pid)) return true;
    retirePeer(p.id);
    return false;
  });
}

// A nudge still in flight will reach the recipient after any message sent meanwhile, so it
// covers that message too, even if an ack cleared the batch in between.
const wakesInFlight = new Set<string>();

async function wakePeer(fromId: string, toId: string): Promise<NonNullable<SendMessageResponse["wake"]>> {
  const target = selectWakeTarget.get(toId) as WakeRow | null;
  if (!target?.wake_transport || !target.wake_address) return { transport: null, status: "none" };
  const transport = target.wake_transport;

  if (wakesInFlight.has(toId)) return { transport, status: "coalesced" };
  if (reserveWake.run(Date.now(), toId, WAKE_REARM_MS).changes !== 1) return { transport, status: "coalesced" };
  wakesInFlight.add(toId);

  const sender = (selectSender.get(fromId) as { client_type: string; cwd: string } | null) ?? {
    client_type: "cli",
    cwd: "",
  };
  const text = wakeText(fromId, sender.client_type, sender.cwd);
  let status: Awaited<ReturnType<typeof deliverWake>>;
  try {
    status = await deliverWake(transport, target.wake_address, target.wake_secret, text);
  } catch (e) {
    console.error(`[claude-peers broker] Wake to ${toId} threw: ${e instanceof Error ? e.message : String(e)}`);
    status = "ambiguous";
  } finally {
    wakesInFlight.delete(toId);
  }

  recordWakeStatus.run(status, new Date().toISOString(), toId);
  // Release the reservation only on definite non-delivery, so a slow success can't wake twice.
  if (status === "failed") clearWakeBatch.run(toId);
  return { transport, status };
}

async function handleSendMessage(body: SendMessageRequest): Promise<SendMessageResponse> {
  // Validate message size
  if (body.text.length > MAX_MESSAGE_SIZE) {
    return { ok: false, error: `Message too large (${body.text.length} chars, max ${MAX_MESSAGE_SIZE})` };
  }

  // Validate sender is a registered peer (allow "cli" as special case with warning)
  const isCli = body.from_id === "cli";
  if (!isCli) {
    const sender = checkPeerExists.get(body.from_id) as { id: string } | null;
    if (!sender) {
      return { ok: false, error: `Unknown sender: ${body.from_id}` };
    }
  }

  // Verify target exists
  const target = checkPeerExists.get(body.to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  // Rate limiting
  if (isRateLimited(body.from_id)) {
    return { ok: false, error: `Rate limited: max ${RATE_LIMIT_MAX} messages per minute` };
  }

  // Prefix CLI messages so recipients know the source is unverified
  const text = isCli ? `[via CLI, unverified sender] ${body.text}` : body.text;
  insertMessage.run(body.from_id, body.to_id, text, new Date().toISOString());
  // The message is stored; a wake error must not read as a failed send and prompt a resend.
  try {
    return { ok: true, wake: await wakePeer(body.from_id, body.to_id) };
  } catch (e) {
    console.error(`[claude-peers broker] Wake bookkeeping for ${body.to_id} failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: true, wake: { transport: null, status: "ambiguous" } };
  }
}

// Legacy drain for servers that predate acknowledged delivery.
const pollTransaction = db.transaction((peerId: string): PollMessagesResponse => {
  const messages = selectUndelivered.all(peerId) as Message[];
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }
  clearWakeBatch.run(peerId);
  return { messages };
});

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  return pollTransaction(body.id);
}

function handleFetchMessages(body: PollMessagesRequest): PollMessagesResponse {
  return { messages: selectUndelivered.all(body.id) as Message[] };
}

const ackTransaction = db.transaction((body: AckMessagesRequest): AckMessagesResponse => {
  let acked = 0;
  for (const messageId of body.message_ids) {
    acked += ackMessage.run(messageId, body.id).changes;
  }
  if (acked > 0) clearWakeBatch.run(body.id);
  return { acked };
});

function handleAckMessages(body: AckMessagesRequest): AckMessagesResponse {
  if (!Array.isArray(body.message_ids) || !body.message_ids.every(Number.isInteger)) {
    return { acked: 0 };
  }
  return ackTransaction(body);
}

function handleSetWake(body: SetWakeRequest): SetWakeResponse {
  if (!Number.isInteger(body.agent_pid) || body.agent_pid <= 1) {
    return { ok: false, error: "invalid agent_pid" };
  }
  if (body.transport !== "codex_queue") return { ok: false, error: "set-wake only accepts codex_queue" };
  const error = validateWake(body.transport, body.address);
  if (error) return { ok: false, error };
  const updated = setWakeForAgent.run(body.transport, body.address, body.agent_pid).changes;
  return { ok: true, updated };
}

function handleUnreadSummary(body: UnreadSummaryRequest): UnreadSummaryResponse {
  const unread = selectUnreadForAgent.all(body.agent_pid) as { from_id: string }[];
  const peerIds = (selectPeerIdsForAgent.all(body.agent_pid) as { id: string }[]).map((p) => p.id);
  return {
    count: unread.length,
    senders: [...new Set(unread.map((m) => m.from_id))],
    peer_ids: peerIds,
  };
}

function handleMessageHistory(body: { id: string; limit?: number }): { messages: Message[] } {
  const limit = Math.min(body.limit ?? 20, 100);
  return { messages: selectHistory.all(body.id, body.id, limit) as Message[] };
}

function handleUnregister(body: { id: string }): void {
  retirePeer(body.id);
  checkIdleShutdown();
}

function handleKillPeer(body: { id: string; from_id?: string }): { ok: boolean; error?: string; killed_pid?: number } {
  // Require a registered caller (prevent anonymous kills)
  if (body.from_id && body.from_id !== "cli") {
    const caller = db.query("SELECT pid FROM peers WHERE id = ?").get(body.from_id) as { pid: number } | null;
    if (!caller) {
      return { ok: false, error: "kill_peer requires a registered from_id" };
    }
  }

  const peer = db.query("SELECT pid FROM peers WHERE id = ?").get(body.id) as { pid: number } | null;
  if (!peer) {
    return { ok: false, error: `Peer ${body.id} not found` };
  }

  // Prevent self-kill
  if (body.from_id && body.from_id === body.id) {
    return { ok: false, error: "Cannot kill yourself" };
  }

  // Find the parent PID (the actual Codex/Claude CLI process)
  const ppidProc = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(peer.pid)]);
  const ppidStr = new TextDecoder().decode(ppidProc.stdout).trim();
  const ppid = parseInt(ppidStr, 10);

  // Kill the parent process (the agent CLI), which will also kill the MCP child
  const targetPid = ppid && ppid > 1 ? ppid : peer.pid;
  try {
    process.kill(targetPid, "SIGTERM");
  } catch (e) {
    return { ok: false, error: `Failed to kill PID ${targetPid}: ${e instanceof Error ? e.message : String(e)}` };
  }

  console.error(`[claude-peers broker] Peer ${body.from_id ?? "cli"} killed peer ${body.id} (PID ${targetPid})`);

  // Clean up the peer record (CASCADE handles messages, but explicit delete covers edge cases)
  deletePeer.run(body.id);

  return { ok: true, killed_pid: targetPid };
}

// --- Request handler (shared between Unix socket and optional TCP) ---

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method !== "POST") {
    if (path === "/health") {
      return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
    }
    return new Response("claude-peers broker", { status: 200 });
  }

  try {
    const body = await req.json();

    switch (path) {
      case "/register":
        return Response.json(handleRegister(body as RegisterRequest));
      case "/heartbeat":
        handleHeartbeat(body as HeartbeatRequest);
        return Response.json({ ok: true });
      case "/set-summary":
        handleSetSummary(body as SetSummaryRequest);
        return Response.json({ ok: true });
      case "/list-peers":
        return Response.json(handleListPeers(body as ListPeersRequest));
      case "/send-message":
        return Response.json(await handleSendMessage(body as SendMessageRequest));
      case "/poll-messages":
        return Response.json(handlePollMessages(body as PollMessagesRequest));
      case "/fetch-messages":
        return Response.json(handleFetchMessages(body as PollMessagesRequest));
      case "/ack-messages":
        return Response.json(handleAckMessages(body as AckMessagesRequest));
      case "/set-wake":
        return Response.json(handleSetWake(body as SetWakeRequest));
      case "/unread-summary":
        return Response.json(handleUnreadSummary(body as UnreadSummaryRequest));
      case "/message-history":
        return Response.json(handleMessageHistory(body as { id: string; limit?: number }));
      case "/unregister":
        handleUnregister(body as { id: string });
        return Response.json({ ok: true });
      case "/kill-peer":
        return Response.json(handleKillPeer(body as { id: string }));
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

// --- Socket cleanup and startup ---

// Ensure socket directory exists
mkdirSync(dirname(SOCKET_PATH), { recursive: true });

// Clean stale socket from previous crash
if (existsSync(SOCKET_PATH)) {
  let isAlive = false;
  try {
    const res = await fetch("http://localhost/health", {
      unix: SOCKET_PATH,
      signal: AbortSignal.timeout(1000),
    } as RequestInit);
    isAlive = res.ok;
  } catch {
    // Connection failed — socket is stale
  }

  if (isAlive) {
    console.error("[claude-peers broker] Another broker is already running");
    process.exit(1);
  } else {
    unlinkSync(SOCKET_PATH);
    console.error("[claude-peers broker] Removed stale socket file");
  }
}

// --- Unix socket server (primary) ---

Bun.serve({
  unix: SOCKET_PATH,
  async fetch(req, server) {
    // /send-message awaits the wake (codex queue can take 10s); Bun's default idle timeout is 10s.
    server.timeout(req, 30);
    return handleRequest(req);
  },
});

console.error(`[claude-peers broker] listening on ${SOCKET_PATH} (db: ${DB_PATH})`);

// --- Optional TCP fallback for debugging ---

if (process.env.CLAUDE_PEERS_TCP === "1") {
  Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(req, server) {
      server.timeout(req, 30);
      return handleRequest(req);
    },
  });
  console.error(`[claude-peers broker] TCP fallback on 127.0.0.1:${PORT}`);
}
