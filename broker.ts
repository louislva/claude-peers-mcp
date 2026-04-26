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
  Peer,
  Message,
  CreateGroupRequest,
  JoinGroupRequest,
  LeaveGroupRequest,
  ListGroupsRequest,
  SendGroupMessageRequest,
  Group,
  GroupMember,
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
    group_name TEXT,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// Migration: add group_name column to messages if upgrading from older schema
try { db.run("ALTER TABLE messages ADD COLUMN group_name TEXT"); } catch { /* already exists */ }

db.run(`
  CREATE TABLE IF NOT EXISTS groups (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS group_members (
    group_name TEXT NOT NULL,
    member_cwd TEXT NOT NULL,
    active_peer_id TEXT,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (group_name, member_cwd),
    FOREIGN KEY (group_name) REFERENCES groups(name)
  )
`);

// Clean up stale peers (PIDs that no longer exist) on startup
function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    try {
      // Check if process is still alive (signal 0 doesn't kill, just checks)
      process.kill(peer.pid, 0);
    } catch {
      // Process doesn't exist, remove it
      db.run("UPDATE group_members SET active_peer_id = NULL WHERE active_peer_id = ?", [peer.id]);
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

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered, group_name)
  VALUES (?, ?, ?, ?, 0, ?)
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

  // Auto-link this peer to any groups where its CWD is a member
  db.run("UPDATE group_members SET active_peer_id = ? WHERE member_cwd = ?", [id, body.cwd]);

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

  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString(), null);
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
  db.run("UPDATE group_members SET active_peer_id = NULL WHERE active_peer_id = ?", [body.id]);
  deletePeer.run(body.id);
}

// --- Group handlers ---

function handleCreateGroup(body: CreateGroupRequest): { ok: boolean; error?: string } {
  const existing = db.query("SELECT name FROM groups WHERE name = ?").get(body.name);
  if (existing) {
    return { ok: false, error: `Group '${body.name}' already exists` };
  }
  db.run(
    "INSERT INTO groups (name, description, created_at) VALUES (?, ?, ?)",
    [body.name, body.description ?? "", new Date().toISOString()]
  );
  return { ok: true };
}

function handleJoinGroup(body: JoinGroupRequest): { ok: boolean; error?: string } {
  const group = db.query("SELECT name FROM groups WHERE name = ?").get(body.group_name);
  if (!group) {
    return { ok: false, error: `Group '${body.group_name}' not found` };
  }

  // Upsert: if this CWD is already a member, just update the active peer ID
  const existing = db.query(
    "SELECT member_cwd FROM group_members WHERE group_name = ? AND member_cwd = ?"
  ).get(body.group_name, body.member_cwd);

  if (existing) {
    db.run(
      "UPDATE group_members SET active_peer_id = ? WHERE group_name = ? AND member_cwd = ?",
      [body.peer_id, body.group_name, body.member_cwd]
    );
  } else {
    db.run(
      "INSERT INTO group_members (group_name, member_cwd, active_peer_id, joined_at) VALUES (?, ?, ?, ?)",
      [body.group_name, body.member_cwd, body.peer_id, new Date().toISOString()]
    );
  }
  return { ok: true };
}

function handleLeaveGroup(body: LeaveGroupRequest): { ok: boolean; error?: string } {
  const result = db.run(
    "DELETE FROM group_members WHERE group_name = ? AND member_cwd = ?",
    [body.group_name, body.member_cwd]
  );
  if (result.changes === 0) {
    return { ok: false, error: `Not a member of group '${body.group_name}'` };
  }
  return { ok: true };
}

function handleListGroups(body: ListGroupsRequest): { groups: (Group & { members: GroupMember[] })[] } {
  let groups: Group[];
  if (body.member_cwd) {
    groups = db.query(
      `SELECT DISTINCT g.* FROM groups g
       JOIN group_members gm ON g.name = gm.group_name
       WHERE gm.member_cwd = ?`
    ).all(body.member_cwd) as Group[];
  } else {
    groups = db.query("SELECT * FROM groups").all() as Group[];
  }

  return {
    groups: groups.map((g) => ({
      ...g,
      members: db.query(
        "SELECT * FROM group_members WHERE group_name = ?"
      ).all(g.name) as GroupMember[],
    })),
  };
}

function handleSendGroupMessage(body: SendGroupMessageRequest): { ok: boolean; error?: string; sent_to: number } {
  const group = db.query("SELECT name FROM groups WHERE name = ?").get(body.group_name);
  if (!group) {
    return { ok: false, error: `Group '${body.group_name}' not found`, sent_to: 0 };
  }

  // Fan out: insert one message per active member, excluding sender
  const members = db.query(
    "SELECT active_peer_id FROM group_members WHERE group_name = ? AND active_peer_id IS NOT NULL AND active_peer_id != ?"
  ).all(body.group_name, body.from_id) as { active_peer_id: string }[];

  const now = new Date().toISOString();
  for (const member of members) {
    insertMessage.run(body.from_id, member.active_peer_id, body.text, now, body.group_name);
  }

  return { ok: true, sent_to: members.length };
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
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        case "/create-group":
          return Response.json(handleCreateGroup(body as CreateGroupRequest));
        case "/join-group":
          return Response.json(handleJoinGroup(body as JoinGroupRequest));
        case "/leave-group":
          return Response.json(handleLeaveGroup(body as LeaveGroupRequest));
        case "/list-groups":
          return Response.json(handleListGroups(body as ListGroupsRequest));
        case "/send-group-message":
          return Response.json(handleSendGroupMessage(body as SendGroupMessageRequest));
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
