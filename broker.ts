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
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_SOCKET_PATH } from "./shared/types.ts";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  Message,
} from "./shared/types.ts";

const SOCKET_PATH = DEFAULT_SOCKET_PATH;
const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const MAX_MESSAGE_SIZE = 10_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// --- Database setup ---

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

// Migration: add client_type column if missing (idempotent)
try {
  db.run("ALTER TABLE peers ADD COLUMN client_type TEXT NOT NULL DEFAULT 'claude-code'");
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("duplicate column name")) {
    throw e;
  }
}

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

// Clean up stale peers (PIDs that no longer exist) on startup
// Uses inline SQL instead of prepared statements because this runs before they're initialized
function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    try {
      process.kill(peer.pid, 0);
    } catch {
      // Process doesn't exist, remove peer and its messages
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
      db.run("DELETE FROM messages WHERE from_id = ?", [peer.id]);
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
    }
  }
  checkIdleShutdown();
}

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// Check idle shutdown every 60s
idleCheckTimer = setInterval(checkIdleShutdown, 60_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, client_type, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

const checkPeerExists = db.prepare(`
  SELECT id FROM peers WHERE id = ?
`);

// --- Generate peer ID ---

function generateId(): string {
  return crypto.randomUUID().slice(0, 8);
}

// --- Request handlers ---

const registerTransaction = db.transaction((body: RegisterRequest) => {
  const id = generateId();
  const now = new Date().toISOString();

  // Remove any existing registration for this PID (re-registration)
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) {
    // Clean up orphaned messages for the old peer
    db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [existing.id]);
    db.run("DELETE FROM messages WHERE from_id = ?", [existing.id]);
    deletePeer.run(existing.id);
  }

  const clientType = body.client_type ?? "claude-code";
  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, clientType, body.summary, now, now);
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

  // Verify each peer's process is still alive
  return peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      deletePeer.run(p.id);
      return false;
    }
  });
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
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
  return { ok: true };
}

const pollTransaction = db.transaction((peerId: string): PollMessagesResponse => {
  const messages = selectUndelivered.all(peerId) as Message[];
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }
  return { messages };
});

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  return pollTransaction(body.id);
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
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
        return Response.json(handleSendMessage(body as SendMessageRequest));
      case "/poll-messages":
        return Response.json(handlePollMessages(body as PollMessagesRequest));
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
  async fetch(req) { return handleRequest(req); },
});

console.error(`[claude-peers broker] listening on ${SOCKET_PATH} (db: ${DB_PATH})`);

// --- Optional TCP fallback for debugging ---

if (process.env.CLAUDE_PEERS_TCP === "1") {
  Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(req) { return handleRequest(req); },
  });
  console.error(`[claude-peers broker] TCP fallback on 127.0.0.1:${PORT}`);
}
