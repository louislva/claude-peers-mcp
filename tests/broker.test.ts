import { test, expect, beforeAll, afterAll } from "bun:test";

const TEST_PORT = 17899;
const TEST_DB = `/tmp/claude-peers-test-${Date.now()}.db`;
const BROKER_URL = `http://127.0.0.1:${TEST_PORT}`;

let brokerProc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  brokerProc = Bun.spawn(["bun", "broker.ts"], {
    cwd: import.meta.dir + "/..",
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(TEST_PORT),
      CLAUDE_PEERS_DB: TEST_DB,
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
});

afterAll(() => {
  brokerProc.kill();
  try { require("fs").unlinkSync(TEST_DB); } catch {}
});

test("register peer with role", async () => {
  const res = await fetch(`${BROKER_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pid: process.pid,
      cwd: "/tmp/test-project",
      git_root: "/tmp/test-project",
      tty: null,
      summary: "Test peer",
      role: "frontend-dev",
    }),
  });
  const data = await res.json() as { id: string };
  expect(data.id).toBeDefined();
  expect(typeof data.id).toBe("string");
  expect(data.id.length).toBe(8);
});

test("list peers returns role field", async () => {
  const res = await fetch(`${BROKER_URL}/list-peers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: "machine",
      cwd: "/",
      git_root: null,
    }),
  });
  const peers = await res.json() as Array<{ id: string; role: string }>;
  expect(peers.length).toBeGreaterThan(0);

  const peer = peers.find((p) => p.role === "frontend-dev");
  expect(peer).toBeDefined();
  expect(peer!.role).toBe("frontend-dev");
});

test("register peer without role defaults to empty string", async () => {
  const res = await fetch(`${BROKER_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pid: process.pid + 1,
      cwd: "/tmp/test-project-2",
      git_root: null,
      tty: null,
      summary: "",
      role: "",
    }),
  });
  const data = await res.json() as { id: string };

  const listRes = await fetch(`${BROKER_URL}/list-peers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "machine", cwd: "/", git_root: null }),
  });
  const peers = await listRes.json() as Array<{ id: string; role: string }>;
  const peer = peers.find((p) => p.id === data.id);
  expect(peer).toBeDefined();
  expect(peer!.role).toBe("");
});
