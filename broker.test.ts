import { test, expect, beforeAll, afterAll, describe } from "bun:test";

const PORT = 17899; // Use non-default port to avoid conflicts
const BROKER_URL = `http://127.0.0.1:${PORT}`;
const DB_PATH = `/tmp/test-broker-${Date.now()}.db`;
const TOKEN_PATH = `/tmp/test-broker-token-${Date.now()}`;

let brokerProc: ReturnType<typeof Bun.spawn>;
let token: string;

beforeAll(async () => {
  // Start broker on test port
  brokerProc = Bun.spawn(["bun", "broker.ts"], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(PORT),
      CLAUDE_PEERS_DB: DB_PATH,
      CLAUDE_PEERS_TOKEN_PATH: TOKEN_PATH,
    },
    stdout: "ignore",
    stderr: "pipe",
  });

  // Wait for broker to start
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch(`${BROKER_URL}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) break;
    } catch {}
  }

  // Read generated token
  token = (await Bun.file(TOKEN_PATH).text()).trim();
});

afterAll(async () => {
  brokerProc?.kill();
  await brokerProc?.exited;
  // Clean up
  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(DB_PATH);
    unlinkSync(TOKEN_PATH);
    unlinkSync(DB_PATH + "-wal");
    unlinkSync(DB_PATH + "-shm");
  } catch {}
});

/** Helper: POST with valid auth headers */
function authedPost(path: string, body: unknown) {
  return fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Peers-Token": token,
    },
    body: JSON.stringify(body),
  });
}

// --- Security tests ---

describe("Security: Content-Type validation", () => {
  test("rejects POST with text/plain Content-Type", async () => {
    const res = await fetch(`${BROKER_URL}/list-peers`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-Peers-Token": token,
      },
      body: JSON.stringify({ scope: "machine", cwd: "/", git_root: null }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Content-Type");
  });

  test("rejects POST without Content-Type", async () => {
    const res = await fetch(`${BROKER_URL}/list-peers`, {
      method: "POST",
      headers: { "X-Peers-Token": token },
      body: JSON.stringify({ scope: "machine", cwd: "/", git_root: null }),
    });
    expect(res.status).toBe(400);
  });
});

describe("Security: Token authentication", () => {
  test("rejects POST without token", async () => {
    const res = await fetch(`${BROKER_URL}/list-peers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "machine", cwd: "/", git_root: null }),
    });
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toContain("X-Peers-Token");
  });

  test("rejects POST with wrong token", async () => {
    const res = await fetch(`${BROKER_URL}/list-peers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Peers-Token": "wrong-token-value",
      },
      body: JSON.stringify({ scope: "machine", cwd: "/", git_root: null }),
    });
    expect(res.status).toBe(401);
  });

  test("GET /health does not require token", async () => {
    const res = await fetch(`${BROKER_URL}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
  });

  test("token file is generated with sufficient entropy", () => {
    expect(token.length).toBeGreaterThanOrEqual(32);
    // Should be hex characters only
    expect(token).toMatch(/^[0-9a-f]+$/);
  });
});

// --- Functional tests (with auth) ---

describe("Broker: peer registration", () => {
  test("register and list a peer", async () => {
    const regRes = await authedPost("/register", {
      pid: process.pid,
      cwd: "/tmp/test",
      git_root: null,
      tty: null,
      summary: "test peer",
    });
    expect(regRes.status).toBe(200);
    const { id } = (await regRes.json()) as { id: string };
    expect(id).toBeTruthy();
    expect(id.length).toBeGreaterThanOrEqual(8);

    const listRes = await authedPost("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    expect(listRes.status).toBe(200);
    const peers = (await listRes.json()) as Array<{ id: string; summary: string }>;
    const found = peers.find((p) => p.id === id);
    expect(found).toBeTruthy();
    expect(found!.summary).toBe("test peer");

    // Clean up
    await authedPost("/unregister", { id });
  });
});

describe("Broker: messaging", () => {
  let peerA: string;
  let peerB: string;

  beforeAll(async () => {
    // Register two peers (use current PID for both since we just need IDs)
    const resA = await authedPost("/register", {
      pid: process.pid,
      cwd: "/tmp/a",
      git_root: null,
      tty: null,
      summary: "peer A",
    });
    // process.pid is reused, so register B with a fake PID
    // Use a PID that doesn't exist but won't cause issues for registration
    peerA = ((await resA.json()) as { id: string }).id;

    const resB = await authedPost("/register", {
      pid: process.pid + 99999,
      cwd: "/tmp/b",
      git_root: null,
      tty: null,
      summary: "peer B",
    });
    peerB = ((await resB.json()) as { id: string }).id;
  });

  afterAll(async () => {
    await authedPost("/unregister", { id: peerA });
    await authedPost("/unregister", { id: peerB });
  });

  test("send and poll a message", async () => {
    const sendRes = await authedPost("/send-message", {
      from_id: peerA,
      to_id: peerB,
      text: "hello from A",
    });
    expect(sendRes.status).toBe(200);
    const sendData = (await sendRes.json()) as { ok: boolean };
    expect(sendData.ok).toBe(true);

    const pollRes = await authedPost("/poll-messages", { id: peerB });
    expect(pollRes.status).toBe(200);
    const pollData = (await pollRes.json()) as {
      messages: Array<{ from_id: string; text: string }>;
    };
    expect(pollData.messages.length).toBe(1);
    expect(pollData.messages[0].from_id).toBe(peerA);
    expect(pollData.messages[0].text).toBe("hello from A");
  });

  test("polling again returns empty (messages marked delivered)", async () => {
    const pollRes = await authedPost("/poll-messages", { id: peerB });
    const pollData = (await pollRes.json()) as {
      messages: Array<unknown>;
    };
    expect(pollData.messages.length).toBe(0);
  });

  test("send to nonexistent peer returns error", async () => {
    const res = await authedPost("/send-message", {
      from_id: peerA,
      to_id: "nonexistent",
      text: "hello",
    });
    const data = (await res.json()) as { ok: boolean; error: string };
    expect(data.ok).toBe(false);
    expect(data.error).toContain("not found");
  });
});

describe("Broker: set-summary and heartbeat", () => {
  let peerId: string;

  beforeAll(async () => {
    const res = await authedPost("/register", {
      pid: process.pid,
      cwd: "/tmp/summary-test",
      git_root: null,
      tty: null,
      summary: "initial",
    });
    peerId = ((await res.json()) as { id: string }).id;
  });

  afterAll(async () => {
    await authedPost("/unregister", { id: peerId });
  });

  test("update summary", async () => {
    const res = await authedPost("/set-summary", {
      id: peerId,
      summary: "updated summary",
    });
    expect(res.status).toBe(200);

    const listRes = await authedPost("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    const peers = (await listRes.json()) as Array<{ id: string; summary: string }>;
    const found = peers.find((p) => p.id === peerId);
    expect(found!.summary).toBe("updated summary");
  });

  test("heartbeat updates last_seen", async () => {
    const before = await authedPost("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    const peersBefore = (await before.json()) as Array<{
      id: string;
      last_seen: string;
    }>;
    const lastSeenBefore = peersBefore.find((p) => p.id === peerId)!.last_seen;

    await new Promise((r) => setTimeout(r, 50));

    await authedPost("/heartbeat", { id: peerId });

    const after = await authedPost("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    const peersAfter = (await after.json()) as Array<{
      id: string;
      last_seen: string;
    }>;
    const lastSeenAfter = peersAfter.find((p) => p.id === peerId)!.last_seen;

    expect(lastSeenAfter >= lastSeenBefore).toBe(true);
  });
});
