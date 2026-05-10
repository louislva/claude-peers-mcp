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
  ListMessagesRequest,
  ListWavesResponse,
  Peer,
  Message,
  Wave,
  PeerAvailabilityRequest,
  PeerAvailabilityResponse,
  AvailablePeer,
  BusyPeer,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");
db.run("PRAGMA foreign_keys = ON");

// --- Schema versioning ---

db.run(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
const currentVersion = (db.query("SELECT version FROM schema_version").get() as { version: number } | null)?.version ?? 0;

if (currentVersion < 1) {
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
      msg_type TEXT NOT NULL DEFAULT 'chat',
      payload TEXT NOT NULL DEFAULT '{}',
      sent_at TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      delivered_at TEXT,
      FOREIGN KEY (from_id) REFERENCES peers(id),
      FOREIGN KEY (to_id) REFERENCES peers(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      peer_id TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL,
      git_root TEXT,
      task_summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      registered_at TEXT NOT NULL,
      last_tool_use TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS waves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      phase INTEGER NOT NULL,
      wave_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(repo, phase, wave_number)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS task_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wave_id INTEGER NOT NULL,
      session_id TEXT,
      task_name TEXT NOT NULL,
      files TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      blocked_by INTEGER,
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      FOREIGN KEY (wave_id) REFERENCES waves(id)
    )
  `);

  db.run("INSERT INTO schema_version (version) VALUES (1)");
}

// --- Indexes (idempotent, safe to run on every startup) ---

// Covering index for the hot path: poll undelivered messages per peer
db.run("CREATE INDEX IF NOT EXISTS idx_messages_undelivered ON messages(to_id, delivered) WHERE delivered = 0");

// Index for message retention prune (delivered messages by delivered_at)
db.run("CREATE INDEX IF NOT EXISTS idx_messages_delivered_at ON messages(delivered_at) WHERE delivered = 1");

// Index for conflict check + wave status queries
db.run("CREATE INDEX IF NOT EXISTS idx_tasks_wave_status ON task_assignments(wave_id, status)");

// Index for session lookup by peer_id (used in cleanup)
db.run("CREATE INDEX IF NOT EXISTS idx_sessions_peer_id ON sessions(peer_id)");

// Index for peer lookup by PID (used in re-registration)
db.run("CREATE INDEX IF NOT EXISTS idx_peers_pid ON peers(pid)");

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
  INSERT INTO messages (from_id, to_id, text, msg_type, payload, sent_at, delivered)
  VALUES (?, ?, ?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1, delivered_at = ? WHERE id = ?
`);

const selectRecentMessages = db.prepare(
  `SELECT * FROM messages ORDER BY sent_at DESC LIMIT ?`
);

const selectAllWaves = db.prepare(
  `SELECT w.*,
    (SELECT COUNT(*) FROM task_assignments WHERE wave_id = w.id) as task_count,
    (SELECT COUNT(*) FROM task_assignments WHERE wave_id = w.id AND status = 'completed') as tasks_completed,
    (SELECT COUNT(*) FROM task_assignments WHERE wave_id = w.id AND status = 'running') as tasks_running
  FROM waves w ORDER BY w.created_at DESC`
);

// --- Session prepared statements ---

const upsertSession = db.prepare(`
  INSERT INTO sessions (session_id, peer_id, cwd, git_root, task_summary, status, registered_at, last_tool_use)
  VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    task_summary = excluded.task_summary,
    last_tool_use = excluded.last_tool_use,
    status = CASE WHEN sessions.status = 'completed' THEN sessions.status ELSE excluded.status END
`);

const getSession = db.prepare(`SELECT * FROM sessions WHERE session_id = ?`);
const endSession = db.prepare(`UPDATE sessions SET status = 'completed' WHERE session_id = ?`);

// --- Wave prepared statements ---

const insertWave = db.prepare(`
  INSERT INTO waves (repo, phase, wave_number, status, created_at) VALUES (?, ?, ?, 'pending', ?)
`);

const getWave = db.prepare(`SELECT * FROM waves WHERE id = ?`);

const getWaveByKey = db.prepare(`
  SELECT * FROM waves WHERE repo = ? AND phase = ? AND wave_number = ?
`);

const updateWaveStatus = db.prepare(`
  UPDATE waves SET status = ?, completed_at = ? WHERE id = ?
`);

// --- Task assignment prepared statements ---

const insertTaskAssignment = db.prepare(`
  INSERT INTO task_assignments (wave_id, task_name, files, status) VALUES (?, ?, ?, 'pending')
`);

const getTaskAssignment = db.prepare(`SELECT * FROM task_assignments WHERE id = ?`);

const getTasksByWave = db.prepare(`SELECT * FROM task_assignments WHERE wave_id = ?`);

const updateTaskStatus = db.prepare(`
  UPDATE task_assignments SET status = ?, started_at = COALESCE(started_at, ?), completed_at = ?, error = ? WHERE id = ?
`);

const assignTaskSession = db.prepare(`
  UPDATE task_assignments SET session_id = ? WHERE id = ?
`);

// Peer availability: LEFT JOIN to get running task info in one query
const selectPeersWithTaskState = db.prepare(`
  SELECT
    p.id, p.pid, p.cwd, p.git_root, p.summary, p.last_seen,
    ta.task_name AS current_task,
    ta.started_at AS task_started_at
  FROM peers p
  LEFT JOIN sessions s ON s.peer_id = p.id AND s.status = 'active'
  LEFT JOIN task_assignments ta ON ta.session_id = s.session_id AND ta.status = 'running'
`);

// --- Shared cleanup helper (used inside transactions) ---

// Fully clean a peer and all its FK references: messages, task_assignments, sessions, then peer
function cleanPeerRefs(peerId: string, reason?: string) {
  const msgCount = (db.query("SELECT COUNT(*) as cnt FROM messages WHERE from_id = ? OR to_id = ?").get(peerId, peerId) as { cnt: number }).cnt;
  if (msgCount > 0) {
    console.error(`[claude-peers broker] cleaning peer ${peerId}${reason ? ` (${reason})` : ""}: deleting ${msgCount} message(s)`);
  }
  db.run("DELETE FROM messages WHERE from_id = ? OR to_id = ?", [peerId, peerId]);
  const sessions = db.query("SELECT session_id FROM sessions WHERE peer_id = ?").all(peerId) as { session_id: string }[];
  for (const s of sessions) {
    db.run("UPDATE task_assignments SET session_id = NULL WHERE session_id = ?", [s.session_id]);
  }
  db.run("DELETE FROM sessions WHERE peer_id = ?", [peerId]);
  deletePeer.run(peerId);
}

// Wrap in transaction for use as standalone cleanup
const cleanStalePeerTxn = db.transaction((peerId: string, reason?: string) => {
  cleanPeerRefs(peerId, reason ?? "stale PID");
});

// Clean up stale peers (PIDs that no longer exist)
function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    try {
      process.kill(peer.pid, 0);
    } catch {
      console.error(`[claude-peers broker] stale peer ${peer.id} (PID ${peer.pid} dead) — removing`);
      cleanStalePeerTxn(peer.id);
    }
  }
}

// --- Data retention ---

// Configurable via env vars (defaults: 24h messages, 7d sessions, 30d waves)
function parseRetentionMs(envVar: string | undefined, defaultMs: number): number {
  if (!envVar) return defaultMs;
  const parsed = parseInt(envVar, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? defaultMs : parsed;
}
const RETAIN_MESSAGES_MS = parseRetentionMs(process.env.CLAUDE_PEERS_RETAIN_MESSAGES_MS, 24 * 60 * 60 * 1000);
const RETAIN_SESSIONS_MS = parseRetentionMs(process.env.CLAUDE_PEERS_RETAIN_SESSIONS_MS, 7 * 24 * 60 * 60 * 1000);
const RETAIN_WAVES_MS = parseRetentionMs(process.env.CLAUDE_PEERS_RETAIN_WAVES_MS, 30 * 24 * 60 * 60 * 1000);

const pruneOldData = db.transaction(() => {
  const now = Date.now();

  // Prune delivered messages older than retention period
  const msgCutoff = new Date(now - RETAIN_MESSAGES_MS).toISOString();
  const msgResult = db.run(
    "DELETE FROM messages WHERE delivered = 1 AND delivered_at IS NOT NULL AND delivered_at < ?",
    [msgCutoff]
  );

  // Prune completed sessions older than retention period
  const sessCutoff = new Date(now - RETAIN_SESSIONS_MS).toISOString();
  // First detach any task assignments referencing old sessions
  const oldSessions = db.query(
    "SELECT session_id FROM sessions WHERE status = 'completed' AND last_tool_use < ?"
  ).all(sessCutoff) as { session_id: string }[];
  for (const s of oldSessions) {
    db.run("UPDATE task_assignments SET session_id = NULL WHERE session_id = ?", [s.session_id]);
  }
  const sessResult = db.run(
    "DELETE FROM sessions WHERE status = 'completed' AND last_tool_use < ?",
    [sessCutoff]
  );

  // Prune completed waves (and their task_assignments) older than retention period
  const waveCutoff = new Date(now - RETAIN_WAVES_MS).toISOString();
  const oldWaves = db.query(
    "SELECT id FROM waves WHERE status IN ('completed', 'failed') AND completed_at IS NOT NULL AND completed_at < ?"
  ).all(waveCutoff) as { id: number }[];
  let tasksDeleted = 0;
  for (const w of oldWaves) {
    const r = db.run("DELETE FROM task_assignments WHERE wave_id = ?", [w.id]);
    tasksDeleted += r.changes;
  }
  const waveResult = db.run(
    "DELETE FROM waves WHERE status IN ('completed', 'failed') AND completed_at IS NOT NULL AND completed_at < ?",
    [waveCutoff]
  );

  return {
    messages_pruned: msgResult.changes,
    sessions_pruned: sessResult.changes,
    waves_pruned: waveResult.changes,
    tasks_pruned: tasksDeleted,
  };
});

// --- Stats ---

function safeFileSize(path: string): number {
  try { return Bun.file(path).size; } catch { return 0; }
}

// Snapshot-isolated: all counts taken in a single read transaction
const getStatsCounts = db.transaction(() => ({
  peers: (db.query("SELECT COUNT(*) as c FROM peers").get() as { c: number }).c,
  messages_total: (db.query("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c,
  messages_undelivered: (db.query("SELECT COUNT(*) as c FROM messages WHERE delivered = 0").get() as { c: number }).c,
  messages_delivered: (db.query("SELECT COUNT(*) as c FROM messages WHERE delivered = 1").get() as { c: number }).c,
  sessions_active: (db.query("SELECT COUNT(*) as c FROM sessions WHERE status = 'active'").get() as { c: number }).c,
  sessions_completed: (db.query("SELECT COUNT(*) as c FROM sessions WHERE status = 'completed'").get() as { c: number }).c,
  waves_total: (db.query("SELECT COUNT(*) as c FROM waves").get() as { c: number }).c,
  waves_running: (db.query("SELECT COUNT(*) as c FROM waves WHERE status = 'running'").get() as { c: number }).c,
  waves_completed: (db.query("SELECT COUNT(*) as c FROM waves WHERE status IN ('completed', 'failed')").get() as { c: number }).c,
  tasks_total: (db.query("SELECT COUNT(*) as c FROM task_assignments").get() as { c: number }).c,
  tasks_running: (db.query("SELECT COUNT(*) as c FROM task_assignments WHERE status = 'running'").get() as { c: number }).c,
  tasks_completed: (db.query("SELECT COUNT(*) as c FROM task_assignments WHERE status = 'completed'").get() as { c: number }).c,
}));

function getStats() {
  const counts = getStatsCounts();
  const db_size_bytes = safeFileSize(DB_PATH);
  const wal_size_bytes = safeFileSize(`${DB_PATH}-wal`);

  return {
    db_path: DB_PATH,
    db_size_bytes,
    db_size_human: formatBytes(db_size_bytes + wal_size_bytes),
    wal_size_bytes,
    schema_version: currentVersion < 1 ? 1 : currentVersion,
    retention: {
      messages_hours: Math.round(RETAIN_MESSAGES_MS / (60 * 60 * 1000)),
      sessions_days: Math.round(RETAIN_SESSIONS_MS / (24 * 60 * 60 * 1000)),
      waves_days: Math.round(RETAIN_WAVES_MS / (24 * 60 * 60 * 1000)),
    },
    counts,
  };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Run on startup and periodically
cleanStalePeers();
setInterval(cleanStalePeers, 30_000);

// Auto-prune every 5 minutes
setInterval(() => { pruneOldData(); }, 5 * 60 * 1000);
// Also prune on startup
pruneOldData();

// WAL checkpoint every 2 minutes to keep WAL file bounded
setInterval(() => {
  try {
    db.run("PRAGMA wal_checkpoint(PASSIVE)");
  } catch {
    // Non-critical
  }
}, 2 * 60 * 1000);

// VACUUM reclaims disk space (can't run inside transaction)
function handleVacuum(): { ok: boolean; size_before: string; size_after: string; error?: string } {
  const before = formatBytes(safeFileSize(DB_PATH) + safeFileSize(`${DB_PATH}-wal`));

  try {
    // Force WAL checkpoint first to merge WAL into main DB
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    db.run("VACUUM");
  } catch (e) {
    // SQLITE_BUSY if concurrent readers are active — non-fatal
    const after = formatBytes(safeFileSize(DB_PATH) + safeFileSize(`${DB_PATH}-wal`));
    return { ok: false, size_before: before, size_after: after, error: e instanceof Error ? e.message : String(e) };
  }

  const after = formatBytes(safeFileSize(DB_PATH) + safeFileSize(`${DB_PATH}-wal`));
  return { ok: true, size_before: before, size_after: after };
}

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

const registerTxn = db.transaction((id: string, pid: number, cwd: string, git_root: string | null, tty: string | null, summary: string, now: string) => {
  // Remove any existing registration for this PID (re-registration)
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(pid) as { id: string } | null;
  if (existing) {
    cleanPeerRefs(existing.id, "re-registration");
  }
  insertPeer.run(id, pid, cwd, git_root, tty, summary, now, now);
  return id;
});

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();
  registerTxn(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, now);
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

  // Verify each peer's process is still alive — reuse atomic cleanup
  return peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      cleanStalePeerTxn(p.id);
      return false;
    }
  });
}

// Atomic send: verify target + insert in one transaction
const sendMessageTxn = db.transaction((from_id: string, to_id: string, text: string, msg_type: string, payload: string, now: string): { ok: boolean; error?: string } => {
  const target = db.query("SELECT id FROM peers WHERE id = ?").get(to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${to_id} not found` };
  }
  insertMessage.run(from_id, to_id, text, msg_type, payload, now);
  return { ok: true };
});

function handleSendMessage(body: SendMessageRequest & { msg_type?: string; payload?: Record<string, unknown> }): { ok: boolean; error?: string } {
  return sendMessageTxn(
    body.from_id,
    body.to_id,
    body.text,
    body.msg_type ?? "chat",
    JSON.stringify(body.payload ?? {}),
    new Date().toISOString()
  );
}

// Poll returns undelivered messages WITHOUT marking them delivered.
// Client must call /ack-message with the message IDs after processing.
function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];
  return { messages };
}

// Atomic unregister: clean messages + sessions + peer
function handleUnregister(body: { id: string }): void {
  cleanStalePeerTxn(body.id);
}

// --- Session handlers ---

interface SessionHeartbeatRequest {
  session_id: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty?: string | null;
  task_summary: string;
}

// Atomic: register peer if needed + upsert session in one transaction
const sessionHeartbeatTxn = db.transaction((body: SessionHeartbeatRequest): { peer_id: string; session_id: string } => {
  const now = new Date().toISOString();

  // Check if session already exists
  const existing = getSession.get(body.session_id) as { peer_id: string } | null;

  let peerId: string;
  if (existing) {
    peerId = existing.peer_id;
    // Heartbeat the peer
    updateLastSeen.run(now, peerId);
    // Update session
    upsertSession.run(body.session_id, peerId, body.cwd, body.git_root, body.task_summary, now, now);
    // Update peer summary to match
    updateSummary.run(body.task_summary, peerId);
  } else {
    // Register new peer + session atomically
    peerId = generateId();
    // Clean any existing peer for this PID (reuse shared cleanup)
    const oldPeer = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
    if (oldPeer) {
      cleanPeerRefs(oldPeer.id, "session re-registration");
    }
    insertPeer.run(peerId, body.pid, body.cwd, body.git_root, body.tty ?? null, body.task_summary, now, now);
    upsertSession.run(body.session_id, peerId, body.cwd, body.git_root, body.task_summary, now, now);
  }

  return { peer_id: peerId, session_id: body.session_id };
});

function handleSessionHeartbeat(body: SessionHeartbeatRequest): { peer_id: string; session_id: string } {
  return sessionHeartbeatTxn(body);
}

function handleSessionStatus(body: { session_id: string }): unknown {
  return getSession.get(body.session_id) ?? { error: "Session not found" };
}

// Atomic: end session + unregister peer (keeps session row for audit)
const sessionEndTxn = db.transaction((sessionId: string) => {
  const session = getSession.get(sessionId) as { peer_id: string } | null;
  if (session) {
    endSession.run(sessionId);
    // Detach task assignments from this session
    db.run("UPDATE task_assignments SET session_id = NULL WHERE session_id = ?", [sessionId]);
    // Clean peer + all message refs (session row stays with status=completed)
    if (session.peer_id) {
      db.run("DELETE FROM messages WHERE from_id = ? OR to_id = ?", [session.peer_id, session.peer_id]);
      db.run("DELETE FROM peers WHERE id = ?", [session.peer_id]);
    }
  }
});

function handleSessionEnd(body: { session_id: string }): void {
  sessionEndTxn(body.session_id);
}

// --- Wave / orchestration handlers ---

interface WaveCreateRequest {
  repo: string;
  phase: number;
  wave_number: number;
  tasks: { name: string; files: string[] }[];
}

// Atomic: create wave + all task assignments in one transaction
const waveCreateTxn = db.transaction((body: WaveCreateRequest): { wave_id: number; task_ids: number[] } => {
  const now = new Date().toISOString();

  // Check for existing wave
  const existing = getWaveByKey.get(body.repo, body.phase, body.wave_number) as { id: number } | null;
  if (existing) {
    // Return existing wave info
    const tasks = getTasksByWave.all(existing.id) as { id: number }[];
    return { wave_id: existing.id, task_ids: tasks.map(t => t.id) };
  }

  insertWave.run(body.repo, body.phase, body.wave_number, now);
  const wave = getWaveByKey.get(body.repo, body.phase, body.wave_number) as { id: number };

  const taskIds: number[] = [];
  for (const task of body.tasks) {
    insertTaskAssignment.run(wave.id, task.name, JSON.stringify(task.files));
    const inserted = db.query("SELECT last_insert_rowid() as id").get() as { id: bigint };
    taskIds.push(Number(inserted.id));
  }

  return { wave_id: wave.id, task_ids: taskIds };
});

function handleWaveCreate(body: WaveCreateRequest): { wave_id: number; task_ids: number[] } {
  return waveCreateTxn(body);
}

function handleWaveStatus(body: { wave_id: number }): unknown {
  const wave = getWave.get(body.wave_id);
  if (!wave) return { error: "Wave not found" };
  const tasks = getTasksByWave.all(body.wave_id);
  return { wave, tasks };
}

// Atomic: assign session to task + set status to running
const taskStartTxn = db.transaction((taskId: number, sessionId: string): { ok: boolean; error?: string } => {
  const task = getTaskAssignment.get(taskId) as { status: string; files: string; wave_id: number } | null;
  if (!task) return { ok: false, error: "Task not found" };
  if (task.status !== "pending" && task.status !== "blocked") return { ok: false, error: `Task already ${task.status}` };

  // Check for file conflicts with other running tasks in the same wave
  const taskFiles: string[] = JSON.parse(task.files);
  if (taskFiles.length > 0) {
    const runningTasks = db.query(
      "SELECT id, files, task_name FROM task_assignments WHERE wave_id = ? AND status = 'running' AND id != ?"
    ).all(task.wave_id, taskId) as { id: number; files: string; task_name: string }[];

    for (const running of runningTasks) {
      const runningFiles: string[] = JSON.parse(running.files);
      const conflicts = taskFiles.filter(f => runningFiles.includes(f));
      if (conflicts.length > 0) {
        return { ok: false, error: `File conflict with task "${running.task_name}": ${conflicts.join(", ")}` };
      }
    }
  }

  const now = new Date().toISOString();
  assignTaskSession.run(sessionId, taskId);
  updateTaskStatus.run("running", now, null, null, taskId);
  return { ok: true };
});

function handleTaskStart(body: { task_id: number; session_id: string }): { ok: boolean; error?: string } {
  return taskStartTxn(body.task_id, body.session_id);
}

// Atomic: complete task + check if wave is done
const taskCompleteTxn = db.transaction((taskId: number): { ok: boolean; wave_completed: boolean } => {
  const task = getTaskAssignment.get(taskId) as { status: string; wave_id: number } | null;
  if (!task) return { ok: false, wave_completed: false };

  const now = new Date().toISOString();
  updateTaskStatus.run("completed", now, now, null, taskId);

  // Check if all tasks in this wave are done
  const remaining = db.query(
    "SELECT COUNT(*) as count FROM task_assignments WHERE wave_id = ? AND status NOT IN ('completed', 'failed')"
  ).get(task.wave_id) as { count: number };

  const waveCompleted = remaining.count === 0;
  if (waveCompleted) {
    updateWaveStatus.run("completed", now, task.wave_id);
  }

  return { ok: true, wave_completed: waveCompleted };
});

function handleTaskComplete(body: { task_id: number }): { ok: boolean; wave_completed: boolean } {
  return taskCompleteTxn(body.task_id);
}

// Atomic: mark task blocked + send notification message
const taskBlockedTxn = db.transaction((taskId: number, reason: string): { ok: boolean } => {
  const task = getTaskAssignment.get(taskId) as { session_id: string | null; wave_id: number; task_name: string } | null;
  if (!task) return { ok: false };

  const now = new Date().toISOString();
  updateTaskStatus.run("blocked", now, null, reason, taskId);
  return { ok: true };
});

function handleTaskBlocked(body: { task_id: number; reason: string }): { ok: boolean } {
  return taskBlockedTxn(body.task_id, body.reason);
}

function handlePeerAvailability(body: PeerAvailabilityRequest): PeerAvailabilityResponse {
  const rows = selectPeersWithTaskState.all() as Array<{
    id: string;
    pid: number;
    cwd: string;
    git_root: string | null;
    summary: string;
    last_seen: string;
    current_task: string | null;
    task_started_at: string | null;
  }>;

  const repoAvailable: AvailablePeer[] = [];
  const repoBusy: BusyPeer[] = [];
  const machineAvailable: AvailablePeer[] = [];
  const machineBusy: BusyPeer[] = [];

  for (const row of rows) {
    // Skip the requesting peer
    if (body.exclude_id && row.id === body.exclude_id) continue;

    // Verify PID is still alive
    try { process.kill(row.pid, 0); } catch { continue; }

    const isRepoPeer = row.git_root === body.repo;

    if (row.current_task && row.task_started_at) {
      const busy: BusyPeer = {
        id: row.id,
        pid: row.pid,
        cwd: row.cwd,
        git_root: row.git_root,
        summary: row.summary,
        current_task: row.current_task,
        task_started_at: row.task_started_at,
      };
      if (isRepoPeer) repoBusy.push(busy);
      else machineBusy.push(busy);
    } else {
      const available: AvailablePeer = {
        id: row.id,
        pid: row.pid,
        cwd: row.cwd,
        git_root: row.git_root,
        summary: row.summary,
        idle_since: row.last_seen,
      };
      if (isRepoPeer) repoAvailable.push(available);
      else machineAvailable.push(available);
    }
  }

  return {
    repo_peers: { available: repoAvailable, busy: repoBusy },
    machine_peers: { available: machineAvailable, busy: machineBusy },
  };
}

// Files that are implicitly modified when any file in their directory changes
const LOCK_FILE_NAMES = ["package-lock.json", "bun.lockb", "yarn.lock", "pnpm-lock.yaml"];

// Auto-generated index/barrel files that aggregate exports from a directory
const AUTO_GENERATED_PATTERNS = ["index.ts", "index.js", "index.tsx", "index.jsx"];

/**
 * Expand a file list to include lock files and auto-generated indexes
 * that would be implicitly affected by modifications.
 *
 * For each declared file:
 * - If it's a package.json → add all lock file variants in same dir
 * - If it's a source file in a directory → add index.ts/index.js in same dir
 *
 * Returns deduplicated expanded list.
 */
function expandFilesForConflictCheck(files: string[]): string[] {
  const expanded = new Set(files);

  for (const file of files) {
    const lastSlash = file.lastIndexOf("/");
    // dir is "" for root-level files, "src/auth/" for nested files
    const dir = lastSlash >= 0 ? file.substring(0, lastSlash + 1) : "";
    const basename = lastSlash >= 0 ? file.substring(lastSlash + 1) : file;

    // If modifying package.json, also claim lock files
    if (basename === "package.json") {
      for (const lock of LOCK_FILE_NAMES) {
        expanded.add(dir + lock);
      }
    }

    // If modifying a source file, also claim index/barrel file in same directory
    if (/\.(ts|tsx|js|jsx)$/.test(basename) && !AUTO_GENERATED_PATTERNS.includes(basename)) {
      for (const idx of AUTO_GENERATED_PATTERNS) {
        expanded.add(dir + idx);
      }
    }
  }

  return Array.from(expanded);
}

function handleConflictCheck(body: { wave_id: number; files: string[] }): { conflicts: { task_id: number; task_name: string; conflicting_files: string[] }[] } {
  const expandedInput = expandFilesForConflictCheck(body.files);

  const runningTasks = db.query(
    "SELECT id, files, task_name FROM task_assignments WHERE wave_id = ? AND status = 'running'"
  ).all(body.wave_id) as { id: number; files: string; task_name: string }[];

  const conflicts: { task_id: number; task_name: string; conflicting_files: string[] }[] = [];
  for (const task of runningTasks) {
    const taskFiles: string[] = JSON.parse(task.files);
    const expandedTaskFiles = expandFilesForConflictCheck(taskFiles);
    const overlap = expandedInput.filter(f => expandedTaskFiles.includes(f));
    if (overlap.length > 0) {
      conflicts.push({ task_id: task.id, task_name: task.task_name, conflicting_files: overlap });
    }
  }
  return { conflicts };
}

// --- Message ACK handler ---

function handleAckMessage(body: { message_ids: number[] }): { ok: boolean } {
  const now = new Date().toISOString();
  const ackTxn = db.transaction(() => {
    for (const id of body.message_ids) {
      markDelivered.run(now, id);
    }
  });
  ackTxn();
  return { ok: true };
}

// --- List messages handler (read-only, all messages regardless of delivery status) ---

function handleListMessages(body: ListMessagesRequest): Message[] {
  const limit = Math.min(Math.max((body.limit ?? 50), 1), 200);
  return selectRecentMessages.all(limit) as Message[];
}

// --- List waves handler (all waves with task count aggregates) ---

function handleListWaves(): ListWavesResponse {
  const waves = selectAllWaves.all() as Array<Wave & { task_count: number; tasks_completed: number; tasks_running: number }>;
  return { waves };
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
      if (path === "/stats") {
        return Response.json(getStats());
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

        // --- Session endpoints ---
        case "/session-heartbeat":
          return Response.json(handleSessionHeartbeat(body as SessionHeartbeatRequest));
        case "/session-status":
          return Response.json(handleSessionStatus(body as { session_id: string }));
        case "/session-end":
          handleSessionEnd(body as { session_id: string });
          return Response.json({ ok: true });

        // --- Wave / orchestration endpoints ---
        case "/wave-create":
          return Response.json(handleWaveCreate(body as WaveCreateRequest));
        case "/wave-status":
          return Response.json(handleWaveStatus(body as { wave_id: number }));
        case "/task-start":
          return Response.json(handleTaskStart(body as { task_id: number; session_id: string }));
        case "/task-complete":
          return Response.json(handleTaskComplete(body as { task_id: number }));
        case "/task-blocked":
          return Response.json(handleTaskBlocked(body as { task_id: number; reason: string }));
        case "/conflict-check":
          return Response.json(handleConflictCheck(body as { wave_id: number; files: string[] }));
        case "/peer-availability":
          return Response.json(handlePeerAvailability(body as PeerAvailabilityRequest));

        // --- List messages (read-only, all regardless of delivery status) ---
        case "/list-messages":
          return Response.json(handleListMessages(body as ListMessagesRequest));

        // --- List waves (all waves with task count aggregates) ---
        case "/list-waves":
          return Response.json(handleListWaves());

        // --- Message ACK ---
        case "/ack-message":
          return Response.json(handleAckMessage(body as { message_ids: number[] }));

        // --- Maintenance ---
        case "/prune":
          return Response.json(pruneOldData());
        case "/vacuum":
          return Response.json(handleVacuum());

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
