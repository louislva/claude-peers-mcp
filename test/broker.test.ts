// Regression tests for message loss around peer restarts. Spawns a real
// broker on a scratch port and database; `sleep` children stand in for live
// peer processes.
//
// Run: bun test

import { afterAll, beforeAll, expect, test } from "bun:test";

const PORT = 17899 + Math.floor(Math.random() * 1000);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const DB = `/tmp/claude-peers-test-${PORT}.db`;

const spawned: { kill: () => void; pid: number }[] = [];

function spawnBroker(port = PORT, dbPath = DB) {
  const proc = Bun.spawn(["bun", new URL("../broker.ts", import.meta.url).pathname], {
    env: { ...process.env, CLAUDE_PEERS_PORT: String(port), CLAUDE_PEERS_DB: dbPath },
    stdio: ["ignore", "ignore", "inherit"],
  });
  spawned.push(proc);
  return proc;
}

async function waitForBroker(base: string) {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("broker did not start");
}

function livePid(): number {
  const p = Bun.spawn(["sleep", "300"]);
  spawned.push(p);
  return p.pid;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
}

function register(pid: number, cwd: string) {
  return post<{ id: string }>("/register", {
    pid,
    cwd,
    git_root: null,
    tty: null,
    summary: "",
  });
}

beforeAll(async () => {
  spawnBroker();
  await waitForBroker(URL_BASE);
});

afterAll(async () => {
  for (const p of spawned) p.kill();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await Bun.file(`${DB}${suffix}`).unlink();
    } catch {
      // fine
    }
  }
});

test("undelivered mail survives a peer whose process died", async () => {
  const sender = await register(livePid(), "/tmp/pt-sender");

  // A peer registered from a PID that no longer exists: the session crashed or
  // was killed before it could poll
  const dead = await register(4_000_000, "/tmp/pt-restart");
  const sent = await post<{ ok: boolean }>("/send-message", {
    from_id: sender.id,
    to_id: dead.id,
    text: "while you were away",
  });
  expect(sent.ok).toBe(true);

  // Listing notices the dead process and drops it from the results
  const peers = await post<{ id: string }[]>("/list-peers", {
    scope: "machine",
    cwd: "/",
    git_root: null,
  });
  expect(peers.find((p) => p.id === dead.id)).toBeUndefined();

  // Before this fix the message was deleted here and the restarted session
  // never saw it; now the successor in the same directory adopts the inbox
  const restarted = await register(livePid(), "/tmp/pt-restart");
  const poll = await post<{ messages: { text: string }[] }>("/poll-messages", {
    id: restarted.id,
  });
  expect(poll.messages.map((m) => m.text)).toContain("while you were away");
});

test("undelivered mail survives a clean unregister", async () => {
  const sender = await register(livePid(), "/tmp/pt-sender2");
  const leaving = await register(livePid(), "/tmp/pt-unreg");

  await post("/send-message", { from_id: sender.id, to_id: leaving.id, text: "last words" });
  await post("/unregister", { id: leaving.id });

  const restarted = await register(livePid(), "/tmp/pt-unreg");
  const poll = await post<{ messages: { text: string }[] }>("/poll-messages", {
    id: restarted.id,
  });
  expect(poll.messages.map((m) => m.text)).toContain("last words");
});

test("a dead peer is not a valid message target", async () => {
  const sender = await register(livePid(), "/tmp/pt-sender3");
  const dead = await register(4_000_001, "/tmp/pt-gone");

  // Force the liveness sweep
  await post("/list-peers", { scope: "machine", cwd: "/", git_root: null });

  const sent = await post<{ ok: boolean; error?: string }>("/send-message", {
    from_id: sender.id,
    to_id: dead.id,
    text: "should not be accepted",
  });
  expect(sent.ok).toBe(false);
});

