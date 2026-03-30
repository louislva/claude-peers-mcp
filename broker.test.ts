import { test, expect, beforeAll, afterAll } from "bun:test";
import { Subprocess } from "bun";

const TEST_PORT = 17899;
const TEST_DB = `/tmp/claude-peers-test-${Date.now()}.db`;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

let brokerProc: Subprocess;

// Helper to find alive PIDs other than our own
function findAlivePids(count: number): number[] {
  // PID 1 (launchd/init) is always alive, plus we use our own PID and parent PID
  const candidates = [process.pid, process.ppid, 1];
  const result: number[] = [];
  for (const pid of candidates) {
    if (result.length >= count) break;
    try {
      process.kill(pid, 0);
      result.push(pid);
    } catch {
      // skip dead process
    }
  }
  // If we still need more, search for other alive processes
  if (result.length < count) {
    for (let pid = 2; pid < 99999 && result.length < count; pid++) {
      if (result.includes(pid)) continue;
      try {
        process.kill(pid, 0);
        result.push(pid);
      } catch {
        // skip
      }
    }
  }
  return result;
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

beforeAll(async () => {
  brokerProc = Bun.spawn(["bun", "broker.ts"], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(TEST_PORT),
      CLAUDE_PEERS_DB: TEST_DB,
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  // Wait for broker to be ready
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) break;
    } catch {
      // not ready yet
    }
    await Bun.sleep(100);
  }
});

afterAll(async () => {
  brokerProc.kill();
  await brokerProc.exited;
  // Clean up test DB
  try {
    const { unlinkSync } = require("fs");
    unlinkSync(TEST_DB);
    unlinkSync(TEST_DB + "-wal");
    unlinkSync(TEST_DB + "-shm");
  } catch {
    // ignore
  }
});

test("register peer without workspace", async () => {
  const result = await post("/register", {
    pid: process.pid,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "test peer no workspace",
    workspace: null,
  });
  expect(result.id).toBeDefined();
  expect(typeof result.id).toBe("string");
  expect(result.id.length).toBe(8);
});

test("register peer with workspace", async () => {
  const result = await post("/register", {
    pid: process.pid,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "test peer with workspace",
    workspace: "test-ws",
  });
  expect(result.id).toBeDefined();
  expect(typeof result.id).toBe("string");
  expect(result.id.length).toBe(8);
});

test("list-peers with workspace scope", async () => {
  const pids = findAlivePids(3);

  // Register peer A in workspace "ws-alpha"
  const peerA = await post("/register", {
    pid: pids[0],
    cwd: "/tmp/a",
    git_root: null,
    tty: null,
    summary: "peer A",
    workspace: "ws-alpha",
  });

  // Register peer B in workspace "ws-alpha"
  const peerB = await post("/register", {
    pid: pids[1],
    cwd: "/tmp/b",
    git_root: null,
    tty: null,
    summary: "peer B",
    workspace: "ws-alpha",
  });

  // Register peer C in workspace "ws-beta"
  const peerC = await post("/register", {
    pid: pids[2],
    cwd: "/tmp/c",
    git_root: null,
    tty: null,
    summary: "peer C",
    workspace: "ws-beta",
  });

  // List peers with workspace scope "ws-alpha"
  const peers = await post("/list-peers", {
    scope: "workspace",
    cwd: "/tmp",
    git_root: null,
    workspace: "ws-alpha",
  });

  expect(Array.isArray(peers)).toBe(true);
  const ids = peers.map((p: any) => p.id);
  expect(ids).toContain(peerA.id);
  expect(ids).toContain(peerB.id);
  expect(ids).not.toContain(peerC.id);
});

test("broadcast sends to all workspace members", async () => {
  const pids = findAlivePids(3);

  // Register sender in workspace "ws-broadcast"
  const sender = await post("/register", {
    pid: pids[0],
    cwd: "/tmp/sender",
    git_root: null,
    tty: null,
    summary: "sender",
    workspace: "ws-broadcast",
  });

  // Register receiver1 in same workspace
  const receiver1 = await post("/register", {
    pid: pids[1],
    cwd: "/tmp/receiver1",
    git_root: null,
    tty: null,
    summary: "receiver1",
    workspace: "ws-broadcast",
  });

  // Register receiver2 in same workspace
  const receiver2 = await post("/register", {
    pid: pids[2],
    cwd: "/tmp/receiver2",
    git_root: null,
    tty: null,
    summary: "receiver2",
    workspace: "ws-broadcast",
  });

  // Broadcast from sender
  const broadcastResult = await post("/broadcast", {
    from_id: sender.id,
    workspace: "ws-broadcast",
    text: "hello everyone",
  });

  expect(broadcastResult.ok).toBe(true);
  expect(broadcastResult.sent_to).toBe(2);

  // Check receiver1 got the message
  const msgs1 = await post("/poll-messages", { id: receiver1.id });
  expect(msgs1.messages.length).toBe(1);
  expect(msgs1.messages[0].text).toBe("hello everyone");
  expect(msgs1.messages[0].from_id).toBe(sender.id);

  // Check receiver2 got the message
  const msgs2 = await post("/poll-messages", { id: receiver2.id });
  expect(msgs2.messages.length).toBe(1);
  expect(msgs2.messages[0].text).toBe("hello everyone");
  expect(msgs2.messages[0].from_id).toBe(sender.id);
});

test("broadcast to empty workspace returns error", async () => {
  const pids = findAlivePids(1);

  // Register one peer alone in a workspace
  const loner = await post("/register", {
    pid: pids[0],
    cwd: "/tmp/loner",
    git_root: null,
    tty: null,
    summary: "loner",
    workspace: "ws-lonely",
  });

  // Broadcast - should fail since no OTHER peers in workspace
  const result = await post("/broadcast", {
    from_id: loner.id,
    workspace: "ws-lonely",
    text: "is anyone there?",
  });

  expect(result.ok).toBe(false);
  expect(result.sent_to).toBe(0);
  expect(result.error).toBeDefined();
});
