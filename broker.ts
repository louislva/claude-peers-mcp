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

// How long a polled-but-not-acked message stays "in flight" before being
// eligible for retry. Set conservatively — push notifications usually
// deliver within ms, so 60s leaves room for slow LLM consumption.
const POLL_LEASE_SECONDS = 60;

// How long after first poll a never-acked message is force-marked delivered.
// Bounds noise from MCP server clients that don't implement /ack-messages
// (e.g., older subprocess versions during a rollout). Without this, an old
// client's messages would re-poll every POLL_LEASE_SECONDS forever.
const FORCE_DELIVERED_SECONDS = 3600; // 1 hour

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

// Idempotent migration: add polled_at column if missing. Tracks when a
// message was last returned to a polling MCP server, so we can retry
// after POLL_LEASE_SECONDS if the LLM ack never arrived. Pre-migration
// behavior of marking delivered=1 on poll caused silent message loss
// when channel-notification pushes failed.
{
  const columns = (db.query("PRAGMA table_info(messages)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!columns.includes("polled_at")) {
    db.run("ALTER TABLE messages ADD COLUMN polled_at TEXT");
    console.error("[claude-peers broker] migration: added polled_at column to messages");
  }
}

// Clean up stale peers (PIDs that no longer exist) on startup
function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
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
}

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// Force-deliver messages that have been polled but never acked for too long.
// Protects against old MCP server clients that don't call /ack-messages —
// without this, their messages would loop in the polled-not-acked state
// forever. Runs every 5 minutes.
function forceDeliverStuck() {
  const cutoff = new Date(Date.now() - FORCE_DELIVERED_SECONDS * 1000).toISOString();
  const result = db.run(
    "UPDATE messages SET delivered = 1 WHERE delivered = 0 AND polled_at IS NOT NULL AND polled_at < ?",
    [cutoff],
  );
  if (result.changes > 0) {
    console.error(
      `[claude-peers broker] force-delivered ${result.changes} stuck message(s) (polled > ${FORCE_DELIVERED_SECONDS}s ago)`,
    );
  }
}

forceDeliverStuck();
setInterval(forceDeliverStuck, 300_000); // every 5 min

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

const selectPollable = db.prepare(`
  SELECT * FROM messages
  WHERE to_id = ?
    AND delivered = 0
    AND (polled_at IS NULL OR polled_at < ?)
  ORDER BY sent_at ASC
`);

const selectAllPollable = db.prepare(`
  SELECT * FROM messages
  WHERE delivered = 0
    AND (polled_at IS NULL OR polled_at < ?)
  ORDER BY sent_at ASC
`);

const selectRecentForObserver = db.prepare(`
  SELECT * FROM messages
  WHERE sent_at > ?
  ORDER BY sent_at ASC
`);

const markPolled = db.prepare(`
  UPDATE messages SET polled_at = ? WHERE id = ?
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ? AND to_id = ?
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

  // Verify each peer's process is still alive
  return peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      // Clean up dead peer
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
  // Passive observers (for example the AgentBridgeMirror sidecar) need to see
  // inter-peer traffic without changing the delivery state. They intentionally
  // do not claim polled_at; claiming the shared lease could hide the message
  // from the real recipient for POLL_LEASE_SECONDS.
  if (body.subscribe_all && body.read_only) {
    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
    const messages = selectRecentForObserver.all(cutoff) as Message[];
    return { messages };
  }

  // Backwards-compat path: legacy clients that don't implement /ack-messages
  // pass ack_supported=undefined. For them we retain the original
  // mark-delivered-on-poll behavior so a broker upgrade doesn't trigger a
  // duplicate-storm against old MCP server subprocesses that outlive it.
  // The silent-loss bug stays present for those clients until they're
  // restarted — but it's no worse than before the fix.
  if (!body.ack_supported) {
    const messages = selectUndelivered.all(body.id) as Message[];
    for (const msg of messages) {
      markDelivered.run(msg.id, body.id);
    }
    return { messages };
  }

  // New ack-aware path: messages stay delivered=0 until the client calls
  // /ack-messages. Within POLL_LEASE_SECONDS of being polled, a message is
  // considered "in flight" and not re-returned. After the lease expires
  // without an ack, the message is re-pollable (at-least-once retry).
  // markPolled + select happens in one transaction so concurrent pollers
  // don't double-deliver.
  const cutoff = new Date(Date.now() - POLL_LEASE_SECONDS * 1000).toISOString();
  const now = new Date().toISOString();

  const messages = db.transaction(() => {
    const msgs = body.subscribe_all
      ? (selectAllPollable.all(cutoff) as Message[])
      : (selectPollable.all(body.id, cutoff) as Message[]);
    for (const msg of msgs) {
      markPolled.run(now, msg.id);
    }
    return msgs;
  })();

  return { messages };
}

function handleAckMessages(body: AckMessagesRequest): { ok: boolean } {
  if (body.message_ids.length === 0) return { ok: true };

  // Scope the ack to messages addressed to this peer (defense in depth —
  // a buggy or malicious client can't ack-and-delete messages destined for
  // other peers).
  const ack = db.transaction(() => {
    for (const msgId of body.message_ids) {
      markDelivered.run(msgId, body.id);
    }
  });
  ack();

  return { ok: true };
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
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/ack-messages":
          return Response.json(handleAckMessages(body as AckMessagesRequest));
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
