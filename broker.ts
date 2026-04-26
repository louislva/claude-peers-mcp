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
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  AckMessagesRequest,
  Peer,
  Message,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;

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
    peer_type TEXT NOT NULL DEFAULT 'cli',
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

// Cache summaries by workspace so they survive across sessions
db.run(`
  CREATE TABLE IF NOT EXISTS summary_cache (
    key TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

// Clean up stale peers (PIDs that no longer exist) on startup
function cleanStalePeers() {
  const peers = db.query("SELECT id, pid, peer_type FROM peers").all() as { id: string; pid: number; peer_type: string }[];
  for (const peer of peers) {
    try {
      // Check if process is still alive (signal 0 doesn't kill, just checks)
      process.kill(peer.pid, 0);
    } catch {
      // Process doesn't exist, remove it
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }

  // Clean stale desktop peers by heartbeat timeout (PID check doesn't work — shared VM)
  const staleTimeout = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  db.run("DELETE FROM messages WHERE delivered = 0 AND to_id IN (SELECT id FROM peers WHERE peer_type = 'desktop' AND last_seen < ?)", [staleTimeout]);
  db.run("DELETE FROM peers WHERE peer_type = 'desktop' AND last_seen < ?", [staleTimeout]);

  // TTL: delivered messages > 24h, summary cache > 7d
  db.run("DELETE FROM messages WHERE delivered = 1 AND sent_at < ?", [new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()]);
  db.run("DELETE FROM summary_cache WHERE updated_at < ?", [new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()]);
}

cleanStalePeers();

// Reclaim disk space after initial cleanup
db.run("VACUUM");

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, peer_type, registered_at, last_seen)
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

const selectUndeliveredSince = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 AND id > ? ORDER BY sent_at ASC
`);

const upsertSummaryCache = db.prepare(`
  INSERT INTO summary_cache (key, summary, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at
`);

const selectSummaryCache = db.prepare(`
  SELECT summary FROM summary_cache WHERE key = ?
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

// --- Summary cache helpers ---

function summaryCacheKey(cwd: string, git_root: string | null): string {
  return git_root ?? cwd;
}

function cacheSummary(cwd: string, git_root: string | null, summary: string): void {
  if (!summary) return;
  const key = summaryCacheKey(cwd, git_root);
  upsertSummaryCache.run(key, summary, new Date().toISOString());
}

function getCachedSummary(cwd: string, git_root: string | null): string | null {
  const key = summaryCacheKey(cwd, git_root);
  const row = selectSummaryCache.get(key) as { summary: string } | null;
  return row?.summary ?? null;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();

  const peerType = body.peer_type ?? "cli";
  const isCli = peerType !== "desktop";

  // Remove any existing registration for this PID (re-registration).
  // Desktop sessions share one VM PID, so PID-based dedup would delete other active sessions.
  if (isCli) {
    const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
    if (existing) {
      deletePeer.run(existing.id);
    }
  }

  // Carry forward cached summary for CLI sessions in the same workspace.
  // Desktop sessions always set fresh summaries and would collide on one cache slot.
  let summary = body.summary;
  if (!summary && isCli) {
    summary = getCachedSummary(body.cwd, body.git_root) ?? "";
  }

  if (summary && isCli) {
    cacheSummary(body.cwd, body.git_root, summary);
  }

  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, summary, peerType, now, now);
  return { id, restored_summary: summary !== body.summary ? summary : undefined };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): { ok: boolean; error?: string } {
  const peer = db.query("SELECT id, cwd, git_root, peer_type FROM peers WHERE id = ?").get(body.id) as { id: string; cwd: string; git_root: string | null; peer_type: string } | null;
  if (!peer) {
    return { ok: false, error: `Peer ${body.id} not found — re-register via /register` };
  }
  updateSummary.run(body.summary, body.id);
  // Persist to cache so future CLI sessions in this workspace inherit it.
  // Desktop sessions are excluded — they set fresh summaries and would collide in shared workspaces.
  if (peer.peer_type !== "desktop") {
    cacheSummary(peer.cwd, peer.git_root, body.summary);
  }
  return { ok: true };
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

  // Verify each peer's process is still alive.
  // Desktop peers share one VM PID — skip the kill check; heartbeat timeout handles staleness.
  return peers.filter((p) => {
    if (p.peer_type === "desktop") return true;
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
  // Don't mark as delivered here — let the caller ack explicitly
  // so messages aren't lost when channel push silently fails.
  return { messages };
}

function handleAckMessages(body: AckMessagesRequest): void {
  db.transaction(() => {
    for (const id of body.message_ids) {
      markDelivered.run(id);
    }
  })();
}

function handlePeekMessages(body: { id: string; since_id?: number }): PollMessagesResponse {
  const sinceId = body.since_id ?? 0;
  const messages = selectUndeliveredSince.all(body.id, sinceId) as Message[];
  // Don't mark as delivered — just peek
  return { messages };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

// --- HTTP Server ---

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
        case "/set-summary": {
          const summaryResult = handleSetSummary(body as SetSummaryRequest);
          if (!summaryResult.ok) {
            return Response.json(summaryResult, { status: 404 });
          }
          return Response.json(summaryResult);
        }
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/ack-messages":
          handleAckMessages(body as AckMessagesRequest);
          return Response.json({ ok: true });
        case "/peek-messages":
          return Response.json(handlePeekMessages(body as { id: string; since_id?: number }));
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

console.error(`[claude-peers broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
