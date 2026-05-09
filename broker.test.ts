import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Peer, RegisterResponse } from "./shared/types.ts";

// Spawn a fresh broker on an unused port + ephemeral DB so the suite is
// hermetic and doesn't collide with the user's real broker on :7899.
const BROKER_PORT = 7898;
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-test-"));
const dbPath = join(tmpDir, "broker.db");

let broker: ReturnType<typeof Bun.spawn> | null = null;

async function brokerPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function waitForBroker(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Test broker failed to start within 5s");
}

beforeAll(async () => {
  broker = Bun.spawn(["bun", new URL("./broker.ts", import.meta.url).pathname], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(BROKER_PORT),
      CLAUDE_PEERS_DB: dbPath,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitForBroker();
});

afterAll(() => {
  broker?.kill("SIGTERM");
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("/set-capability", () => {
  test("new peer defaults to channel_loaded = 0", async () => {
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
    expect(me!.channel_loaded).toBe(0);
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
    expect(me!.channel_loaded).toBe(1);
  });

  test("setting channel_loaded=false flips it back to 0", async () => {
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
    expect(me!.channel_loaded).toBe(0);
  });
});
