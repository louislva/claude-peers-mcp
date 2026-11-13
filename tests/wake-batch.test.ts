import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tick, __resetNudgeBudgetStateForTest, type TickSnapshot } from "../bin/codex-autodrain-poller.ts";
import { DEFAULT_WAKE_BATCH_MS, isUrgentText, wakeBatchMs, wakeHeld } from "../shared/wake-batch.ts";
import { wakeBatchDecision } from "../hooks/claude-wake-batch.ts";
import { recipientDeliveryHealth, undrainedWarnMs, UNDRAINED_WARN_MS } from "../shared/delivery-state.ts";

const WINDOW = 600_000;
const T0 = Date.parse("2026-11-13T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function fixture(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE peers (
    id TEXT PRIMARY KEY, name TEXT, pid INTEGER NOT NULL, client_type TEXT NOT NULL,
    tmux_pane_id TEXT, thread_id TEXT, seat_key TEXT, receiver_mode TEXT,
    last_hook_seen_at TEXT, last_drain_at TEXT, unread_episode INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE messages (id INTEGER PRIMARY KEY, to_id TEXT NOT NULL, text TEXT NOT NULL,
    sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, delivered_at TEXT)`);
  db.run("INSERT INTO peers VALUES ('seat-1', 'infra.9', ?, 'codex', '%42', 'thread-1', 'pane:infra:%42', 'codex-hook', NULL, NULL, 1)", [process.pid]);
  return db;
}

const snap: TickSnapshot = {
  procs: [{ pid: process.pid, ppid: 1, args: "codex resume" }],
  paneByPid: new Map([["%42", process.pid]]),
  paneMap: new Map([[process.pid, { session: "infra", window_index: "1", window_name: "peers", pane_index: "9", pane_id: "%42" }]]),
};

function runTick(db: Database, nowMs: number, windowMs = WINDOW): Array<{ id: string; unread: number }> {
  const wakes: Array<{ id: string; unread: number }> = [];
  tick(db, snap, {
    nudgeableClients: ["codex"],
    isPidAlive: () => true,
    paneIsIdle: () => true,
    paneIsInCopyMode: () => false,
    now: () => nowMs,
    wakeBatchMs: windowMs,
    nudgeLane: (lane) => { wakes.push({ id: lane.id, unread: lane.unread }); return "submitted"; },
  });
  return wakes;
}

const queue = (db: Database) =>
  db.query("SELECT id, text, delivered FROM messages WHERE delivered = 0 ORDER BY id").all();

describe("urgent text and window config", () => {
  test("URGENT: prefix, any case, after optional whitespace", () => {
    for (const text of ["URGENT: deploy is down", "urgent:x", "  \n\tUrgent: x"]) expect(isUrgentText(text)).toBe(true);
    for (const text of ["not URGENT: x", "URGENT x", "urgently: x", "", null]) expect(isUrgentText(text)).toBe(false);
  });

  test("window defaults to 10 minutes, 0 disables, garbage falls back", () => {
    expect(DEFAULT_WAKE_BATCH_MS).toBe(600_000);
    expect(wakeBatchMs(undefined)).toBe(600_000);
    expect(wakeBatchMs("0")).toBe(0);
    expect(wakeBatchMs("2500")).toBe(2500);
    expect(wakeBatchMs("-5")).toBe(600_000);
    expect(wakeBatchMs("ten")).toBe(600_000);
  });
});

describe("poller batches idle wakes", () => {
  test("non-urgent mail inside the window does not wake; after the window one wake carries all queued", () => {
    __resetNudgeBudgetStateForTest();
    const db = fixture();
    try {
      db.run("INSERT INTO messages VALUES (1, 'seat-1', 'earlier', ?, 1, ?)", [iso(T0 - 2_000), iso(T0)]);
      db.run("INSERT INTO messages VALUES (2, 'seat-1', 'first', ?, 0, NULL)", [iso(T0 + 60_000)]);
      expect(runTick(db, T0 + 60_000)).toEqual([]);
      db.run("INSERT INTO messages VALUES (3, 'seat-1', 'second', ?, 0, NULL)", [iso(T0 + 300_000)]);
      expect(runTick(db, T0 + 300_000)).toEqual([]);
      expect(runTick(db, T0 + WINDOW - 1)).toEqual([]);
      // Held mail is untouched: still queued, in order, nothing claimed or acked.
      expect(queue(db)).toEqual([
        { id: 2, text: "first", delivered: 0 },
        { id: 3, text: "second", delivered: 0 },
      ]);
      expect(runTick(db, T0 + WINDOW)).toEqual([{ id: "seat-1", unread: 2 }]);
      expect(queue(db)).toEqual([
        { id: 2, text: "first", delivered: 0 },
        { id: 3, text: "second", delivered: 0 },
      ]);
    } finally { __resetNudgeBudgetStateForTest(); db.close(); }
  });

  test("URGENT: wakes at once inside the window", () => {
    __resetNudgeBudgetStateForTest();
    const db = fixture();
    try {
      db.run("INSERT INTO messages VALUES (1, 'seat-1', 'earlier', ?, 1, ?)", [iso(T0 - 2_000), iso(T0)]);
      db.run("INSERT INTO messages VALUES (2, 'seat-1', 'routine', ?, 0, NULL)", [iso(T0 + 10_000)]);
      expect(runTick(db, T0 + 10_000)).toEqual([]);
      db.run("INSERT INTO messages VALUES (3, 'seat-1', ' urgent: broker down', ?, 0, NULL)", [iso(T0 + 20_000)]);
      expect(runTick(db, T0 + 20_000)).toEqual([{ id: "seat-1", unread: 2 }]);
    } finally { __resetNudgeBudgetStateForTest(); db.close(); }
  });

  test("a seat with no recent delivery, or with batching off, wakes at once", () => {
    __resetNudgeBudgetStateForTest();
    const db = fixture();
    try {
      db.run("INSERT INTO messages VALUES (1, 'seat-1', 'hello', ?, 0, NULL)", [iso(T0)]);
      expect(runTick(db, T0)).toEqual([{ id: "seat-1", unread: 1 }]);
      __resetNudgeBudgetStateForTest();
      db.run("INSERT INTO messages VALUES (2, 'seat-1', 'old', ?, 1, ?)", [iso(T0 - 2_000), iso(T0 - 1_000)]);
      expect(runTick(db, T0, 0)).toEqual([{ id: "seat-1", unread: 1 }]);
    } finally { __resetNudgeBudgetStateForTest(); db.close(); }
  });

  test("an unjudgeable mailbox fails open: old schema or a future delivery stamp never holds", () => {
    const db = fixture();
    try {
      db.run("INSERT INTO messages VALUES (1, 'seat-1', 'done', ?, 1, ?)", [iso(T0), iso(T0 + 60_000)]);
      db.run("INSERT INTO messages VALUES (2, 'seat-1', 'new', ?, 0, NULL)", [iso(T0)]);
      expect(wakeHeld(db, ["seat-1"], T0, WINDOW)).toBe(false);
      expect(wakeHeld(db, ["seat-1"], T0 + 120_000, WINDOW)).toBe(true);
      const old = new Database(":memory:");
      old.run("CREATE TABLE peers (id TEXT PRIMARY KEY, seat_key TEXT)");
      old.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, to_id TEXT, delivered INTEGER)");
      old.run("INSERT INTO peers VALUES ('seat-1', NULL)");
      old.run("INSERT INTO messages VALUES (1, 'seat-1', 0)");
      expect(wakeHeld(old, ["seat-1"], T0, WINDOW)).toBe(false);
      old.close();
    } finally { db.close(); }
  });
});

describe("standby watcher helper", () => {
  test("resolves the session by thread or pid and fails open on a missing DB", () => {
    const dir = mkdtempSync(join(tmpdir(), "wake-batch-"));
    const path = `${dir}/peers.db`;
    const db = fixture();
    db.run("INSERT INTO messages VALUES (1, 'seat-1', 'done', ?, 1, ?)", [iso(T0), iso(T0)]);
    db.run("INSERT INTO messages VALUES (2, 'seat-1', 'new', ?, 0, NULL)", [iso(T0)]);
    db.run(`VACUUM INTO '${path}'`);
    db.close();
    try {
      expect(wakeBatchDecision(path, "THREAD-1", undefined, T0 + 1_000)).toBe("hold");
      expect(wakeBatchDecision(path, undefined, process.pid, T0 + 1_000)).toBe("hold");
      expect(wakeBatchDecision(path, "other-thread", undefined, T0 + 1_000)).toBe("wake");
      expect(wakeBatchDecision(path, "thread-1", undefined, T0 + WINDOW)).toBe("wake");
      expect(wakeBatchDecision(`${dir}/missing.db`, "thread-1", undefined, T0 + 1_000)).toBe("wake");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("undrained warning follows the batch window", () => {
  test("held mail at the end of a full window plus one poll is still healthy", () => {
    expect(undrainedWarnMs(600_000)).toBe(720_000);
    expect(UNDRAINED_WARN_MS).toBe(undrainedWarnMs(wakeBatchMs()));
    // Never below the pre-batching 10 minutes, even with batching off.
    expect(undrainedWarnMs(0)).toBe(600_000);
    const facts = { pending: 2, lastDrainAt: "2026-11-13T10:00:00.000Z", hasPane: true, hookDriven: true };
    const windowMs = 600_000;
    const held = recipientDeliveryHealth({ ...facts, oldestPendingMs: windowMs + 30_000, undrainedWarnMs: undrainedWarnMs(windowMs) });
    expect(held.state).toBe("healthy");
    expect(held.warning).toBeNull();
    const stuck = recipientDeliveryHealth({ ...facts, oldestPendingMs: undrainedWarnMs(windowMs) + 1, undrainedWarnMs: undrainedWarnMs(windowMs) });
    expect(stuck.state).toBe("undrained");
  });
});
