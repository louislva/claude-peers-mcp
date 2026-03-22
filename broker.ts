#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 *
 * Environment variables:
 *   CLAUDE_PEERS_PORT  — Listen port (default: 7899)
 *   CLAUDE_PEERS_HOST  — Bind address (default: 127.0.0.1, use 0.0.0.0 for network)
 *   CLAUDE_PEERS_DB    — SQLite database path (default: ~/.claude-peers.db)
 *   CLAUDE_PEERS_TOKEN — Optional bearer token for auth (required when host != 127.0.0.1)
 */

import { Database } from "bun:sqlite";
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
const HOST = process.env.CLAUDE_PEERS_HOST ?? "127.0.0.1";
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const AUTH_TOKEN = process.env.CLAUDE_PEERS_TOKEN ?? "";

// Require auth when binding to network
if (HOST !== "127.0.0.1" && HOST !== "localhost" && !AUTH_TOKEN) {
  console.error(
    "[claude-peers broker] FATAL: CLAUDE_PEERS_TOKEN is required when binding to " +
      `${HOST}. Set CLAUDE_PEERS_TOKEN to a shared secret.`
  );
  process.exit(1);
}

// Heartbeat timeout: peers not seen for this long are considered dead (45s = 3 missed heartbeats)
const HEARTBEAT_TIMEOUT_MS = 45_000;

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    hostname TEXT NOT NULL DEFAULT 'localhost',
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

// Migration: add hostname column if missing (upgrading from pre-cross-machine schema)
try {
  db.run("ALTER TABLE peers ADD COLUMN hostname TEXT NOT NULL DEFAULT 'localhost'");
} catch {
  // Column already exists — expected on subsequent runs
}

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

// Clean up stale peers based on heartbeat timeout (works cross-machine, unlike PID checks)
function cleanStalePeers() {
  const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString();
  const stale = db.query("SELECT id FROM peers WHERE last_seen < ?").all(cutoff) as { id: string }[];
  for (const peer of stale) {
    db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
    db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
  }
  if (stale.length > 0) {
    console.error(`[claude-peers broker] Cleaned ${stale.length} stale peer(s)`);
  }
}

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, hostname, cwd, git_root, tty, summary, registered_at, last_seen)
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

const selectPeersByHostname = db.prepare(`
  SELECT * FROM peers WHERE hostname = ?
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

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Auth middleware ---

function checkAuth(req: Request): Response | null {
  if (!AUTH_TOKEN) return null; // No auth configured
  const header = req.headers.get("Authorization");
  if (header !== `Bearer ${AUTH_TOKEN}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();
  const hostname = body.hostname || "localhost";

  // Remove any existing registration for this PID + hostname combo (re-registration)
  const existing = db
    .query("SELECT id FROM peers WHERE pid = ? AND hostname = ?")
    .get(body.pid, hostname) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  insertPeer.run(id, body.pid, hostname, body.cwd, body.git_root, body.tty, body.summary, now, now);
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): { found: boolean } {
  const peer = db.query("SELECT id FROM peers WHERE id = ?").get(body.id);
  if (!peer) {
    return { found: false };
  }
  updateLastSeen.run(new Date().toISOString(), body.id);
  return { found: true };
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "network":
      // All peers across all machines
      peers = selectAllPeers.all() as Peer[];
      break;
    case "machine":
      // Only peers on the same hostname
      peers = selectPeersByHostname.all(body.hostname || "localhost") as Peer[];
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

  // Filter out stale peers (heartbeat-based, works cross-machine)
  const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString();
  return peers.filter((p) => {
    if (p.last_seen < cutoff) {
      deletePeer.run(p.id);
      return false;
    }
    return true;
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

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
      }
      return new Response("claude-peers broker", { status: 200 });
    }

    // Auth check on all POST routes
    const authErr = checkAuth(req);
    if (authErr) return authErr;

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat": {
          const hb = handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true, ...hb });
        }
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
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(`[claude-peers broker] listening on ${HOST}:${PORT} (db: ${DB_PATH})`);
