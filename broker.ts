#!/usr/bin/env bun
/**
 * claude-peers broker daemon (v0.3)
 *
 * Singleton HTTP server on 127.0.0.1:<port> backed by SQLite.
 * Tracks registered Claude Code peers, isolates them by group, persists session
 * identity across reconnects, and routes messages between them.
 *
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { loadConfig } from "./shared/config.ts";
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
  DisconnectRequest,
  UnregisterRequest,
  SetIdRequest,
  SetIdResponse,
  GroupStatsResponse,
  Peer,
  Message,
  GroupId,
  InstanceToken,
} from "./shared/types.ts";

const config = await loadConfig();
const PORT = config.port;
const DB_PATH = config.db;
const DORMANT_TTL_HOURS = parseInt(
  process.env.CLAUDE_PEERS_DORMANT_TTL_HOURS ?? "24",
  10
);
const PEER_ID_REGEX = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

try {
  mkdirSync(dirname(DB_PATH), { recursive: true });
} catch {
  // best-effort
}

// --- Database setup (v0.3 schema, no migration path) ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");
db.run("PRAGMA foreign_keys = ON");

db.run(`
  CREATE TABLE IF NOT EXISTS groups (
    group_id TEXT PRIMARY KEY,
    secret_hash TEXT,
    name TEXT,
    created_at TEXT NOT NULL
  )
`);

db.run(`
  INSERT OR IGNORE INTO groups (group_id, secret_hash, name, created_at)
  VALUES ('default', NULL, 'default', datetime('now'))
`);

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    instance_token TEXT PRIMARY KEY,
    peer_id TEXT NOT NULL,
    group_id TEXT NOT NULL DEFAULT 'default',
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    host TEXT NOT NULL DEFAULT '',
    client_pid INTEGER NOT NULL DEFAULT 0,
    project_key TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    UNIQUE (peer_id, group_id),
    FOREIGN KEY (group_id) REFERENCES groups(group_id)
  )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_peers_group ON peers(group_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_peers_status ON peers(status)`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_token TEXT NOT NULL,
    to_token TEXT NOT NULL,
    group_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_token) REFERENCES peers(instance_token),
    FOREIGN KEY (to_token) REFERENCES peers(instance_token)
  )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages(to_token, delivered)`);

db.run(`
  CREATE TABLE IF NOT EXISTS peer_sessions (
    session_key TEXT PRIMARY KEY,
    instance_token TEXT NOT NULL,
    group_id TEXT NOT NULL,
    host TEXT NOT NULL,
    cwd TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    FOREIGN KEY (instance_token) REFERENCES peers(instance_token)
  )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_lookup ON peer_sessions(group_id, host, cwd)`);

// --- Helpers ---

function sessionKey(host: string, cwd: string, groupId: GroupId): string {
  return createHash("sha256")
    .update(host)
    .update("\0")
    .update(cwd)
    .update("\0")
    .update(groupId)
    .digest("hex");
}

function deriveDefaultId(host: string, cwd: string, groupId: GroupId): string {
  const sanitize = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const hostPart = sanitize(host).slice(0, 20) || "peer";
  const cwdPart = sanitize(cwd.split(/[/\\]/).pop() ?? "").slice(0, 12);
  const base = cwdPart ? `${hostPart}-${cwdPart}` : hostPart;

  const exists = db.query("SELECT 1 FROM peers WHERE peer_id = ? AND group_id = ?");
  let candidate = base;
  let suffix = 1;
  const MAX_SUFFIX = 1000;
  while (exists.get(candidate, groupId)) {
    suffix += 1;
    if (suffix > MAX_SUFFIX) {
      candidate = `${base}-${Date.now().toString(36)}`;
      break;
    }
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

// --- Stale cleanup (dormant lifecycle) ---

function cleanStalePeers(): void {
  // Phase 1: bascule active -> dormant pour les pids morts.
  const actives = db.query(
    "SELECT instance_token, pid FROM peers WHERE status = 'active'"
  ).all() as { instance_token: string; pid: number }[];
  for (const peer of actives) {
    try {
      process.kill(peer.pid, 0);
    } catch {
      db.run(
        "UPDATE peers SET status = 'dormant' WHERE instance_token = ?",
        [peer.instance_token]
      );
    }
  }

  // Phase 2: purge dormants au-dela du TTL.
  const cutoff = `-${DORMANT_TTL_HOURS} hours`;
  const expired = db.query(
    `SELECT instance_token FROM peers
     WHERE status = 'dormant' AND last_seen < datetime('now', ?)`
  ).all(cutoff) as { instance_token: string }[];
  for (const { instance_token } of expired) {
    db.run("DELETE FROM messages WHERE to_token = ? AND delivered = 0", [instance_token]);
    db.run("DELETE FROM peer_sessions WHERE instance_token = ?", [instance_token]);
    db.run("DELETE FROM peers WHERE instance_token = ?", [instance_token]);
  }
}

cleanStalePeers();
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (
    instance_token, peer_id, group_id, pid, cwd, git_root, tty, summary,
    registered_at, last_seen, host, client_pid, project_key, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
`);

const updateLastSeen = db.prepare(
  `UPDATE peers SET last_seen = ? WHERE instance_token = ?`
);

const updateSummary = db.prepare(
  `UPDATE peers SET summary = ? WHERE instance_token = ?`
);

const updateActiveOnRegister = db.prepare(`
  UPDATE peers
  SET status = 'active',
      pid = ?,
      cwd = ?,
      git_root = ?,
      tty = ?,
      summary = ?,
      last_seen = ?,
      host = ?,
      client_pid = ?,
      project_key = ?
  WHERE instance_token = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_token, to_token, group_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(
  `SELECT * FROM messages WHERE to_token = ? AND delivered = 0 ORDER BY sent_at ASC`
);

const markDelivered = db.prepare(`UPDATE messages SET delivered = 1 WHERE id = ?`);

const upsertPeerSession = db.prepare(`
  INSERT INTO peer_sessions (session_key, instance_token, group_id, host, cwd, last_active_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (session_key) DO UPDATE SET
    instance_token = excluded.instance_token,
    last_active_at = excluded.last_active_at
`);

// --- /register: TOFU + resume ---

function handleRegister(body: RegisterRequest): RegisterResponse | { error: string; status: number } {
  const groupId = body.group_id;
  const secretHash = body.group_secret_hash;
  const now = new Date().toISOString();

  // 1) Group authentication / TOFU.
  if (groupId !== "default") {
    const existing = db.query(
      "SELECT secret_hash FROM groups WHERE group_id = ?"
    ).get(groupId) as { secret_hash: string | null } | null;

    if (existing) {
      if (existing.secret_hash !== secretHash) {
        return { error: "group_secret_hash mismatch (TOFU rejected)", status: 401 };
      }
    } else {
      db.run(
        "INSERT INTO groups (group_id, secret_hash, name, created_at) VALUES (?, ?, NULL, ?)",
        [groupId, secretHash, now]
      );
    }
  }
  // For 'default', secret_hash is ignored.

  // 2) Resume lookup keyed on (host, cwd, group_id).
  const sk = sessionKey(body.host, body.cwd, groupId);
  const session = db.query(
    "SELECT instance_token FROM peer_sessions WHERE session_key = ?"
  ).get(sk) as { instance_token: string } | null;

  if (session) {
    const existingPeer = db.query(
      "SELECT instance_token, peer_id, status, pid FROM peers WHERE instance_token = ?"
    ).get(session.instance_token) as
      | { instance_token: string; peer_id: string; status: "active" | "dormant"; pid: number }
      | null;

    // If marked active but the bun server.ts pid is dead, treat as dormant.
    // This shrinks the post-crash window where the user would otherwise
    // receive a fresh peer_id while waiting for cleanStalePeers (30s tick).
    if (existingPeer && existingPeer.status === "active") {
      try {
        process.kill(existingPeer.pid, 0);
      } catch {
        db.run(
          "UPDATE peers SET status = 'dormant' WHERE instance_token = ?",
          [existingPeer.instance_token]
        );
        existingPeer.status = "dormant";
      }
    }

    if (existingPeer && existingPeer.status === "dormant") {
      // Resurrect dormant.
      updateActiveOnRegister.run(
        body.pid,
        body.cwd,
        body.git_root,
        body.tty,
        body.summary,
        now,
        body.host,
        body.client_pid,
        body.project_key,
        existingPeer.instance_token
      );
      upsertPeerSession.run(sk, existingPeer.instance_token, groupId, body.host, body.cwd, now);
      return {
        peer_id: existingPeer.peer_id,
        instance_token: existingPeer.instance_token,
      };
    }

    if (existingPeer && existingPeer.status === "active") {
      // Active collision: another process is already holding this session_key.
      // Mint a fresh peer with a derived id; do NOT touch peer_sessions
      // (the existing active row keeps the canonical session).
      console.error(
        `[broker] session_key collision: existing active peer ${existingPeer.peer_id} keeps the session, minting new peer`
      );
      const freshToken = randomUUID();
      const freshId = deriveDefaultId(body.host, body.cwd, groupId);
      insertPeer.run(
        freshToken,
        freshId,
        groupId,
        body.pid,
        body.cwd,
        body.git_root,
        body.tty,
        body.summary,
        now,
        now,
        body.host,
        body.client_pid,
        body.project_key
      );
      return { peer_id: freshId, instance_token: freshToken };
    }

    // peer row purged but the session_key remembered the token: reinsert reusing it.
    const reusedId = deriveDefaultId(body.host, body.cwd, groupId);
    insertPeer.run(
      session.instance_token,
      reusedId,
      groupId,
      body.pid,
      body.cwd,
      body.git_root,
      body.tty,
      body.summary,
      now,
      now,
      body.host,
      body.client_pid,
      body.project_key
    );
    upsertPeerSession.run(sk, session.instance_token, groupId, body.host, body.cwd, now);
    return { peer_id: reusedId, instance_token: session.instance_token };
  }

  // 3) Fresh registration.
  const newToken = randomUUID();
  const newPeerId = deriveDefaultId(body.host, body.cwd, groupId);
  insertPeer.run(
    newToken,
    newPeerId,
    groupId,
    body.pid,
    body.cwd,
    body.git_root,
    body.tty,
    body.summary,
    now,
    now,
    body.host,
    body.client_pid,
    body.project_key
  );
  upsertPeerSession.run(sk, newToken, groupId, body.host, body.cwd, now);
  return { peer_id: newPeerId, instance_token: newToken };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.instance_token);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.instance_token);
}

function handleDisconnect(body: DisconnectRequest): void {
  db.run(
    "UPDATE peers SET status = 'dormant', last_seen = ? WHERE instance_token = ?",
    [new Date().toISOString(), body.instance_token]
  );
}

function handleUnregister(body: UnregisterRequest): void {
  db.run("DELETE FROM messages WHERE to_token = ? AND delivered = 0", [body.instance_token]);
  db.run("DELETE FROM peer_sessions WHERE instance_token = ?", [body.instance_token]);
  db.run("DELETE FROM peers WHERE instance_token = ?", [body.instance_token]);
}

function handleSetId(body: SetIdRequest): SetIdResponse | { error: string; status: number } {
  if (!PEER_ID_REGEX.test(body.new_peer_id)) {
    return {
      error: "invalid peer_id (must match ^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$)",
      status: 400,
    };
  }
  const me = db.query(
    "SELECT peer_id, group_id FROM peers WHERE instance_token = ?"
  ).get(body.instance_token) as { peer_id: string; group_id: string } | null;
  if (!me) return { error: "instance_token not found", status: 404 };

  if (me.peer_id === body.new_peer_id) {
    return { peer_id: me.peer_id, previous: me.peer_id };
  }

  // Conflict check covers BOTH active and dormant peers in the group.
  const conflict = db.query(
    "SELECT 1 FROM peers WHERE peer_id = ? AND group_id = ? AND instance_token <> ?"
  ).get(body.new_peer_id, me.group_id, body.instance_token);
  if (conflict) {
    return {
      error: `peer_id '${body.new_peer_id}' already taken in group '${me.group_id}'`,
      status: 409,
    };
  }

  db.run("UPDATE peers SET peer_id = ? WHERE instance_token = ?", [
    body.new_peer_id,
    body.instance_token,
  ]);
  return { peer_id: body.new_peer_id, previous: me.peer_id };
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  // Filter implicitly by the caller's group_id, derived from instance_token.
  const callerRow = db.query(
    "SELECT group_id FROM peers WHERE instance_token = ?"
  ).get(body.instance_token) as { group_id: string } | null;
  if (!callerRow) return [];
  const groupId = callerRow.group_id;

  let peers: Peer[];
  switch (body.scope) {
    case "machine":
      peers = db.query(
        "SELECT * FROM peers WHERE group_id = ? AND status = 'active'"
      ).all(groupId) as Peer[];
      break;
    case "directory":
      peers = db.query(
        "SELECT * FROM peers WHERE group_id = ? AND status = 'active' AND cwd = ?"
      ).all(groupId, body.cwd) as Peer[];
      break;
    case "repo":
      if (body.project_key) {
        peers = db.query(
          "SELECT * FROM peers WHERE group_id = ? AND status = 'active' AND project_key = ?"
        ).all(groupId, body.project_key) as Peer[];
      } else if (body.git_root) {
        peers = db.query(
          "SELECT * FROM peers WHERE group_id = ? AND status = 'active' AND git_root = ?"
        ).all(groupId, body.git_root) as Peer[];
      } else {
        peers = db.query(
          "SELECT * FROM peers WHERE group_id = ? AND status = 'active' AND cwd = ?"
        ).all(groupId, body.cwd) as Peer[];
      }
      break;
    default:
      peers = [];
  }

  return peers.filter((p) => p.instance_token !== body.instance_token);
}

function handleSendMessage(body: SendMessageRequest): SendMessageResponse {
  const sender = db.query(
    "SELECT instance_token, peer_id, group_id, summary, host, cwd FROM peers WHERE instance_token = ?"
  ).get(body.from_token) as
    | {
        instance_token: InstanceToken;
        peer_id: string;
        group_id: GroupId;
        summary: string;
        host: string;
        cwd: string;
      }
    | null;
  if (!sender) return { ok: false, error: "Sender not registered" };

  const target = db.query(
    "SELECT instance_token FROM peers WHERE peer_id = ? AND group_id = ? AND status = 'active'"
  ).get(body.to_peer_id, sender.group_id) as { instance_token: InstanceToken } | null;
  if (!target) {
    return { ok: false, error: `Peer '${body.to_peer_id}' not found in your group` };
  }

  const sentAt = new Date().toISOString();
  const result = insertMessage.run(
    sender.instance_token,
    target.instance_token,
    sender.group_id,
    body.text,
    sentAt
  );
  const messageId = Number(result.lastInsertRowid);

  // Try WebSocket push if the target is connected.
  const ws = wsPool.get(target.instance_token);
  if (ws && ws.readyState === 1) {
    try {
      ws.send(
        JSON.stringify({
          type: "message",
          id: messageId,
          from_peer_id: sender.peer_id,
          from_summary: sender.summary,
          from_host: sender.host,
          from_cwd: sender.cwd,
          text: body.text,
          sent_at: sentAt,
        })
      );
      // Do NOT markDelivered here: the WS notification is fire-and-forget.
      // delivered=0 stays until check_messages is explicitly called by the LLM.
    } catch {
      // ws.send can throw on a half-closed socket; let the polling fallback ship it.
    }
  }

  return { ok: true };
}

function flushPendingForToken(token: InstanceToken): void {
  const ws = wsPool.get(token);
  if (!ws || ws.readyState !== 1) return;
  type MessageRow = Omit<Message, "delivered"> & { delivered: number };
  const rows = selectUndelivered.all(token) as MessageRow[];
  for (const row of rows) {
    const sender = db.query(
      "SELECT peer_id, summary, host, cwd FROM peers WHERE instance_token = ?"
    ).get(row.from_token) as
      | { peer_id: string; summary: string; host: string; cwd: string }
      | null;
    if (!sender) continue;
    try {
      ws.send(
        JSON.stringify({
          type: "message",
          id: row.id,
          from_peer_id: sender.peer_id,
          from_summary: sender.summary,
          from_host: sender.host,
          from_cwd: sender.cwd,
          text: row.text,
          sent_at: row.sent_at,
        })
      );
      // Do NOT markDelivered: same rationale as handleSendMessage.
    } catch {
      break;
    }
  }
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  type MessageRow = Omit<Message, "delivered"> & { delivered: number };
  const rows = selectUndelivered.all(body.instance_token) as MessageRow[];
  for (const row of rows) {
    markDelivered.run(row.id);
  }
  const messages: Message[] = rows.map((r) => ({ ...r, delivered: Boolean(r.delivered) }));
  return { messages };
}

function handleGroupStats(): GroupStatsResponse {
  const rows = db.query(
    "SELECT group_id, COUNT(*) AS active_peers FROM peers WHERE status = 'active' GROUP BY group_id"
  ).all() as { group_id: GroupId; active_peers: number }[];
  return { groups: rows };
}

// --- WebSocket pool (instance_token -> live socket) ---

type WsData = { instance_token: InstanceToken | null };
const wsPool = new Map<InstanceToken, import("bun").ServerWebSocket<WsData>>();

// --- HTTP + WebSocket server ---

const server = Bun.serve<WsData>({
  port: PORT,
  hostname: "127.0.0.1",
  websocket: {
    idleTimeout: 600,
    open(ws) {
      // The auth handshake happens in the first message frame.
      // Until then, the socket is not in the pool.
    },
    message(ws, raw) {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      let frame: { type?: string; instance_token?: string };
      try { frame = JSON.parse(text); } catch { ws.close(1003, "invalid frame"); return; }
      if (frame.type !== "auth" || !frame.instance_token) {
        ws.close(1008, "expected auth frame");
        return;
      }
      const ok = db.query(
        "SELECT 1 FROM peers WHERE instance_token = ? AND status = 'active'"
      ).get(frame.instance_token);
      if (!ok) {
        ws.close(1008, "unknown or inactive instance_token");
        return;
      }
      ws.data.instance_token = frame.instance_token;
      wsPool.set(frame.instance_token, ws);
      flushPendingForToken(frame.instance_token);
    },
    close(ws) {
      const token = ws.data.instance_token;
      if (token && wsPool.get(token) === ws) wsPool.delete(token);
    },
  },
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/ws") {
      if (server.upgrade(req, { data: { instance_token: null } as WsData })) {
        return undefined;
      }
      return new Response("ws upgrade failed", { status: 400 });
    }

    if (req.method !== "POST") {
      if (path === "/health") {
        const total = (db.query("SELECT COUNT(*) AS n FROM peers WHERE status = 'active'")
          .get() as { n: number }).n;
        return Response.json({ status: "ok", peers: total, ws_clients: wsPool.size });
      }
      if (path === "/group-stats") {
        return Response.json(handleGroupStats());
      }
      if (path === "/admin/peers") {
        const includeDormant = url.searchParams.get("include_dormant") === "1";
        const sql = includeDormant
          ? "SELECT * FROM peers ORDER BY group_id, peer_id"
          : "SELECT * FROM peers WHERE status = 'active' ORDER BY group_id, peer_id";
        const rows = db.query(sql).all() as Peer[];
        return Response.json(rows);
      }
      return new Response("claude-peers broker", { status: 200 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register": {
          const result = handleRegister(body as RegisterRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/disconnect":
          handleDisconnect(body as DisconnectRequest);
          return Response.json({ ok: true });
        case "/unregister":
          handleUnregister(body as UnregisterRequest);
          return Response.json({ ok: true });
        case "/set-id": {
          const result = handleSetId(body as SetIdRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/group-stats":
          return Response.json(handleGroupStats());
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(
  `[claude-peers broker v0.3] listening on 127.0.0.1:${PORT} (db: ${DB_PATH}, dormant_ttl=${DORMANT_TTL_HOURS}h)`
);
