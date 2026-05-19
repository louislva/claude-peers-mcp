import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Peer, RegisterResponse } from "./shared/types.ts";

// Spawn a fresh broker on a fixed alternate port + ephemeral DB so the suite is
// hermetic and doesn't collide with the user's real broker on :7899.
const BROKER_PORT = 7898;
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-test-"));
const dbPath = join(tmpDir, "broker.db");
const brokerScript = new URL("./broker.ts", import.meta.url).pathname;

let broker: ReturnType<typeof Bun.spawn> | null = null;

async function brokerPostAt<T>(url: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

const brokerPost = <T>(path: string, body: unknown) => brokerPostAt<T>(BROKER_URL, path, body);

async function waitForBrokerAt(url: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Test broker failed to start within 5s");
}

async function shutdownBroker(proc: ReturnType<typeof Bun.spawn> | null): Promise<void> {
  if (!proc) return;
  proc.kill("SIGTERM");
  // Wait for actual exit so SQLite handles close before tmpdir cleanup.
  await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 2000))]);
}

beforeAll(async () => {
  broker = Bun.spawn(["bun", brokerScript], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(BROKER_PORT),
      CLAUDE_PEERS_DB: dbPath,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitForBrokerAt(BROKER_URL);
});

afterAll(async () => {
  await shutdownBroker(broker);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("/set-capability", () => {
  test("new peer defaults to channel_loaded = false", async () => {
    const reg = await brokerPost<RegisterResponse>("/register", {
      pid: process.pid,
      cwd: "/tmp/test-default",
      git_root: null,
      tty: null,
      summary: "default-channel-test",
    });
    const peers = await brokerPost<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    const me = peers.find((p) => p.id === reg.id);
    expect(me).toBeDefined();
    expect(me!.channel_loaded).toBe(false);
  });

  test("setting channel_loaded=true persists and is visible in list_peers", async () => {
    const reg = await brokerPost<RegisterResponse>("/register", {
      pid: process.pid,
      cwd: "/tmp/test-set-true",
      git_root: null,
      tty: null,
      summary: "set-true",
    });
    await brokerPost("/set-capability", { id: reg.id, channel_loaded: true });
    const peers = await brokerPost<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    const me = peers.find((p) => p.id === reg.id);
    expect(me).toBeDefined();
    expect(me!.channel_loaded).toBe(true);
  });

  test("setting channel_loaded=false flips it back", async () => {
    const reg = await brokerPost<RegisterResponse>("/register", {
      pid: process.pid,
      cwd: "/tmp/test-set-false",
      git_root: null,
      tty: null,
      summary: "set-false",
    });
    await brokerPost("/set-capability", { id: reg.id, channel_loaded: true });
    await brokerPost("/set-capability", { id: reg.id, channel_loaded: false });
    const peers = await brokerPost<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    const me = peers.find((p) => p.id === reg.id);
    expect(me).toBeDefined();
    expect(me!.channel_loaded).toBe(false);
  });
});

describe("message queuing for Channel:no peers", () => {
  // Regression test for the bug where pollAndPushMessages() consumed messages
  // via /poll-messages (marking delivered=1) then silently dropped the
  // mcp.notification() for peers whose channel_loaded=false. Messages were
  // permanently lost; check_messages found nothing.
  //
  // The fix: server.ts only starts the push loop when channelLoaded=true.
  // Channel:no peers rely solely on check_messages → /poll-messages.
  // This test verifies that messages sent to a Channel:no peer ARE returned
  // by /poll-messages when explicitly called (i.e. the broker queues correctly
  // and marks delivered only at poll time, not before).

  test("messages to Channel:no peer survive until explicitly polled via check_messages", async () => {
    const sender = await brokerPost<RegisterResponse>("/register", {
      pid: process.pid,
      cwd: "/tmp/test-sender",
      git_root: null,
      tty: null,
      summary: "channel-yes sender",
    });
    await brokerPost("/set-capability", { id: sender.id, channel_loaded: true });

    const receiver = await brokerPost<RegisterResponse>("/register", {
      pid: process.pid + 1,
      cwd: "/tmp/test-receiver",
      git_root: null,
      tty: null,
      summary: "channel-no receiver",
    });
    // receiver stays channel_loaded=false (the default — no set-capability call)

    // Send two messages from sender to receiver
    await brokerPost("/send-message", { from_id: sender.id, to_id: receiver.id, text: "hello from sender 1" });
    await brokerPost("/send-message", { from_id: sender.id, to_id: receiver.id, text: "hello from sender 2" });

    // Without the push loop running (Channel:no), messages must still be in the queue.
    // Polling via /poll-messages (what check_messages calls) should return them.
    const polled = await brokerPost<{ messages: Array<{ text: string }> }>("/poll-messages", { id: receiver.id });
    expect(polled.messages).toHaveLength(2);
    expect(polled.messages.map((m) => m.text)).toContain("hello from sender 1");
    expect(polled.messages.map((m) => m.text)).toContain("hello from sender 2");

    // A second poll returns nothing (marked delivered=1 on first poll).
    const polled2 = await brokerPost<{ messages: Array<{ text: string }> }>("/poll-messages", { id: receiver.id });
    expect(polled2.messages).toHaveLength(0);
  });
});

describe("schema migration", () => {
  // Pre-existing DBs (from versions before this PR) lack channel_loaded.
  // Verify the broker's PRAGMA-guarded ALTER TABLE adds it on startup
  // without dropping existing rows.
  test("adds channel_loaded column to a pre-existing peers table", async () => {
    const oldDbPath = join(tmpDir, "old-schema.db");
    const oldDb = new Database(oldDbPath);
    oldDb.run(`
      CREATE TABLE peers (
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
    const now = new Date().toISOString();
    oldDb.run(
      "INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["legacy-peer", process.pid, "/tmp/legacy", null, null, "pre-migration", now, now]
    );
    oldDb.close();

    const port = 7897;
    const url = `http://127.0.0.1:${port}`;
    const migratedBroker = Bun.spawn(["bun", brokerScript], {
      env: {
        ...process.env,
        CLAUDE_PEERS_PORT: String(port),
        CLAUDE_PEERS_DB: oldDbPath,
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    try {
      await waitForBrokerAt(url);
      const peers = await brokerPostAt<Peer[]>(url, "/list-peers", {
        scope: "machine",
        cwd: "/",
        git_root: null,
      });
      const legacy = peers.find((p) => p.id === "legacy-peer");
      expect(legacy).toBeDefined();
      expect(legacy!.summary).toBe("pre-migration");
      expect(legacy!.channel_loaded).toBe(false);

      // And a fresh /set-capability call should work post-migration.
      await brokerPostAt(url, "/set-capability", { id: "legacy-peer", channel_loaded: true });
      const after = await brokerPostAt<Peer[]>(url, "/list-peers", {
        scope: "machine",
        cwd: "/",
        git_root: null,
      });
      expect(after.find((p) => p.id === "legacy-peer")?.channel_loaded).toBe(true);
    } finally {
      await shutdownBroker(migratedBroker);
    }
  });
});
