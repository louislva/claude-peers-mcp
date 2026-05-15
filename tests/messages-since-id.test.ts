/**
 * AP-063 — tests for /messages-since-id endpoint and bridge-token-file.
 *
 * Endpoint: GET /messages-since-id?since=N&limit=M
 *   Auth: Authorization: Bearer <bridge token>
 *   Returns: { messages: [...], cursor: number, limit: number, count: number }
 *
 * Bridge-token model: 32 random bytes minted at broker startup, written to
 * CLAUDE_PEERS_BRIDGE_TOKEN_FILE with chmod 0600. Re-minted on every restart.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, statSync, existsSync, unlinkSync } from "node:fs";

const BROKER_PORT = 7905; // not 7899 — avoid colliding with running broker
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const TEST_DB = "/tmp/claude-peers-test-ap063.db";
const TEST_TOKEN_FILE = "/tmp/.claude-peers-bridge-test-ap063.token";

let brokerProc: ReturnType<typeof Bun.spawn>;
let bridgeToken: string;

async function waitForHealth(url: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`broker /health never responded within ${timeoutMs}ms`);
}

describe("AP-063 /messages-since-id + bridge-token-file", () => {
  beforeAll(async () => {
    // Clean prior run state
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    if (existsSync(TEST_TOKEN_FILE)) unlinkSync(TEST_TOKEN_FILE);

    brokerProc = Bun.spawn(["bun", "/home/manzo/claude-peers-mcp/broker.ts"], {
      env: {
        ...process.env,
        CLAUDE_PEERS_PORT: String(BROKER_PORT),
        CLAUDE_PEERS_DB: TEST_DB,
        CLAUDE_PEERS_BRIDGE_TOKEN_FILE: TEST_TOKEN_FILE,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitForHealth(BROKER_URL);
    bridgeToken = readFileSync(TEST_TOKEN_FILE, "utf8").trim();
  });

  afterAll(() => {
    try { brokerProc.kill(); } catch { /* ignore */ }
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    try { unlinkSync(TEST_TOKEN_FILE); } catch { /* ignore */ }
  });

  // --- Test 1: token file invariants ---
  test("bridge token file is created with chmod 0600 and 32-byte token", () => {
    expect(existsSync(TEST_TOKEN_FILE)).toBe(true);
    const stat = statSync(TEST_TOKEN_FILE);
    // chmod 0600 = owner read+write only, no group, no world
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
    // 32 random bytes encoded as base64url is 43 chars (no padding) — between 42 and 44
    expect(bridgeToken.length).toBeGreaterThanOrEqual(42);
    expect(bridgeToken.length).toBeLessThanOrEqual(44);
    // base64url charset: A-Z a-z 0-9 - _
    expect(bridgeToken).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  // --- Test 2: missing/bad auth returns 401 ---
  test("missing Authorization header returns 401", async () => {
    const res = await fetch(`${BROKER_URL}/messages-since-id?since=0&limit=10`);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("bridge token");
  });

  test("wrong Authorization scheme (not Bearer) returns 401", async () => {
    const res = await fetch(`${BROKER_URL}/messages-since-id?since=0&limit=10`, {
      headers: { "Authorization": `Basic ${bridgeToken}` },
    });
    expect(res.status).toBe(401);
  });

  test("invalid token returns 401", async () => {
    const res = await fetch(`${BROKER_URL}/messages-since-id?since=0&limit=10`, {
      headers: { "Authorization": "Bearer NOT-THE-REAL-TOKEN-just-junk" },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("invalid bridge token");
  });

  // --- Test 3: cursor pagination — happy path with seeded messages ---
  test("returns empty list when no messages exist; cursor stays at since", async () => {
    const res = await fetch(`${BROKER_URL}/messages-since-id?since=0&limit=10`, {
      headers: { "Authorization": `Bearer ${bridgeToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { messages: unknown[]; cursor: number; limit: number; count: number };
    expect(body.messages).toEqual([]);
    expect(body.cursor).toBe(0);
    expect(body.count).toBe(0);
    expect(body.limit).toBe(10);
  });

  test("returns messages with id > since, advances cursor to max id", async () => {
    // Inject messages directly via SQLite (test isolation; not via /send-message
    // because that requires a registered peer)
    const { Database } = await import("bun:sqlite");
    const testDb = new Database(TEST_DB);
    const now = new Date().toISOString();
    testDb.run("INSERT INTO peers (id, pid, cwd, registered_at, last_seen) VALUES (?, ?, ?, ?, ?)", ["alice-test", 999991, "/tmp", now, now]);
    testDb.run("INSERT INTO peers (id, pid, cwd, registered_at, last_seen) VALUES (?, ?, ?, ?, ?)", ["bob-test", 999992, "/tmp", now, now]);
    testDb.run("INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?)", ["alice-test", "bob-test", "msg-one", now]);
    testDb.run("INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?)", ["alice-test", "bob-test", "msg-two", now]);
    testDb.run("INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?)", ["alice-test", "bob-test", "msg-three", now]);
    testDb.close();

    const res = await fetch(`${BROKER_URL}/messages-since-id?since=0&limit=100`, {
      headers: { "Authorization": `Bearer ${bridgeToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { messages: Array<{ id: number; from_id: string; to_id: string; text: string }>; cursor: number; count: number };
    expect(body.count).toBe(3);
    expect(body.messages.map((m) => m.text)).toEqual(["msg-one", "msg-two", "msg-three"]);
    expect(body.cursor).toBe(body.messages[body.messages.length - 1]!.id);

    // Cursor pagination: subsequent call with cursor returns empty
    const res2 = await fetch(`${BROKER_URL}/messages-since-id?since=${body.cursor}&limit=100`, {
      headers: { "Authorization": `Bearer ${bridgeToken}` },
    });
    const body2 = await res2.json() as { messages: unknown[]; cursor: number; count: number };
    expect(body2.count).toBe(0);
    expect(body2.cursor).toBe(body.cursor);
  });

  // --- Test 4: limit clamping + malformed query params ---
  test("limit clamps to default 100 when malformed; since clamps to 0 when negative", async () => {
    const res1 = await fetch(`${BROKER_URL}/messages-since-id?since=-5&limit=banana`, {
      headers: { "Authorization": `Bearer ${bridgeToken}` },
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as { limit: number };
    expect(body1.limit).toBe(100); // default after malformed clamp

    const res2 = await fetch(`${BROKER_URL}/messages-since-id?since=0&limit=99999`, {
      headers: { "Authorization": `Bearer ${bridgeToken}` },
    });
    const body2 = await res2.json() as { limit: number };
    expect(body2.limit).toBe(100); // exceeds 1000 cap → falls to default
  });

  test("limit honored when in valid range", async () => {
    const res = await fetch(`${BROKER_URL}/messages-since-id?since=0&limit=2`, {
      headers: { "Authorization": `Bearer ${bridgeToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; limit: number };
    expect(body.limit).toBe(2);
    expect(body.count).toBeLessThanOrEqual(2);
  });
});

describe("AP-063 token regeneration on restart", () => {
  test("a fresh broker process mints a different token, file is overwritten", async () => {
    const TEST_DB_2 = "/tmp/claude-peers-test-ap063-restart.db";
    const TEST_TOKEN_FILE_2 = "/tmp/.claude-peers-bridge-test-ap063-restart.token";
    const PORT_2 = 7906;

    if (existsSync(TEST_DB_2)) unlinkSync(TEST_DB_2);
    if (existsSync(TEST_TOKEN_FILE_2)) unlinkSync(TEST_TOKEN_FILE_2);

    // First broker run
    const proc1 = Bun.spawn(["bun", "/home/manzo/claude-peers-mcp/broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_PORT: String(PORT_2), CLAUDE_PEERS_DB: TEST_DB_2, CLAUDE_PEERS_BRIDGE_TOKEN_FILE: TEST_TOKEN_FILE_2 },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitForHealth(`http://127.0.0.1:${PORT_2}`);
    const token1 = readFileSync(TEST_TOKEN_FILE_2, "utf8").trim();
    proc1.kill();
    await new Promise((r) => setTimeout(r, 300));

    // Second broker run
    const proc2 = Bun.spawn(["bun", "/home/manzo/claude-peers-mcp/broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_PORT: String(PORT_2), CLAUDE_PEERS_DB: TEST_DB_2, CLAUDE_PEERS_BRIDGE_TOKEN_FILE: TEST_TOKEN_FILE_2 },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitForHealth(`http://127.0.0.1:${PORT_2}`);
    const token2 = readFileSync(TEST_TOKEN_FILE_2, "utf8").trim();
    proc2.kill();

    expect(token1).not.toBe(token2); // different mint per process
    expect(token1.length).toBe(token2.length); // same encoding shape

    try { unlinkSync(TEST_DB_2); } catch { /* ignore */ }
    try { unlinkSync(TEST_TOKEN_FILE_2); } catch { /* ignore */ }
  });
});
