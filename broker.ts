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
import { homedir } from "node:os";
import { join } from "node:path";
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

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
// Use os.homedir() rather than process.env.HOME: HOME is undefined when the
// process is spawned natively on Windows (which uses USERPROFILE), and
// path.join produces the correct separator on every platform.
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? join(homedir(), ".claude-peers.db");

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

// Check whether a process is still alive. process.kill(pid, 0) sends no signal —
// it only probes existence. It throws ESRCH when the pid is truly gone, but EPERM
// when the process EXISTS and we merely lack permission to signal it (a peer owned
// by another user, or one running elevated while the broker is not). EPERM means
// alive, so treat ONLY ESRCH as dead — evicting a peer is destructive and should
// require positive proof of death. Same semantics on Windows, Linux, macOS, BSD.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code !== "ESRCH";
  }
}

// Clean up stale peers (PIDs that no longer exist) on startup
function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    if (!isProcessAlive(peer.pid)) {
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }
}

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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

// On case-insensitive filesystems (Windows), two sessions in the same directory
// can report differently-cased paths (e.g. C:\Dev\App vs C:\dev\app) and would
// otherwise fail to discover each other under "directory"/"repo" scope. Match
// case-insensitively there. Gated on the broker's own platform: a blanket
// COLLATE NOCASE would wrongly conflate genuinely distinct paths on
// case-sensitive Linux/BSD (macOS resolves cwd casing itself, so it's unaffected).
const PATH_COLLATE = process.platform === "win32" ? "COLLATE NOCASE" : "";

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ? ${PATH_COLLATE}
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ? ${PATH_COLLATE}
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

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();

  // Remove any existing registration for this PID (re-registration)
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, now, now);
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
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
        // No git root, fall back to directory
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

  // Verify each peer's process is still alive (only truly-gone pids are evicted)
  return peers.filter((p) => {
    if (isProcessAlive(p.pid)) return true;
    // Clean up dead peer
    deletePeer.run(p.id);
    return false;
  });
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  // Verify target exists
  const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];

  // Mark them as delivered
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }

  return { messages };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

function handleShutdown(): void {
  // Exit shortly after so the HTTP response flushes to the caller first.
  // This replaces the previous lsof/kill approach, which only worked on Unix.
  setTimeout(() => process.exit(0), 100);
}

// --- HTTP Server ---

try {
  Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
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
          case "/shutdown":
            handleShutdown();
            return Response.json({ ok: true });
          default:
            return Response.json({ error: "not found" }, { status: 404 });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json({ error: msg }, { status: 500 });
      }
    },
  });
} catch (e) {
  // Another broker won the port — a TOCTOU race when several sessions start at
  // once (each sees no broker and spawns one). That broker is the singleton, so
  // exit quietly with code 0 rather than crashing with a stack trace. Same
  // EADDRINUSE behavior on Windows, Linux, macOS, and BSD.
  if ((e as { code?: string }).code === "EADDRINUSE") {
    console.error(`[claude-peers broker] port ${PORT} already in use — another broker is running`);
    process.exit(0);
  }
  throw e;
}

console.error(`[claude-peers broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
