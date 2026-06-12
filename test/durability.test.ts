/**
 * Durability tests:
 *  - fetch/ack semantics: /fetch-messages peeks, /ack-messages consumes
 *  - server exits (and unregisters) when its stdin closes — no zombies
 *  - broker prunes peers whose heartbeats go stale even if the PID is alive
 *  - the delivery hook injects unsurfaced messages and acks surfaced ones
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Message, Peer } from "../shared/types.ts";

const PORT = 17897;
const DB = `/tmp/claude-peers-durability-${process.pid}.db`;
const BROKER_URL = `http://127.0.0.1:${PORT}`;
const REPO = new URL("..", import.meta.url).pathname;
const ENV = {
  ...process.env,
  CLAUDE_PEERS_PORT: String(PORT),
  CLAUDE_PEERS_DB: DB,
  CLAUDE_PEERS_STALE_TTL_MS: "1000",
  CLAUDE_PEERS_CLEAN_INTERVAL_MS: "300",
  CLAUDE_PEERS_HEARTBEAT_MS: "200",
  OPENAI_API_KEY: "",
} as Record<string, string>;

let broker: ReturnType<typeof Bun.spawn>;

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

const register = (pid: number) =>
  brokerFetch<{ id: string }>("/register", {
    pid,
    cwd: "/tmp",
    git_root: null,
    tty: null,
    summary: "",
  });

beforeAll(async () => {
  broker = Bun.spawn(["bun", `${REPO}broker.ts`], { env: ENV, stdio: ["ignore", "ignore", "ignore"] });
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(100);
    if (await fetch(`${BROKER_URL}/health`).then((r) => r.ok).catch(() => false)) return;
  }
  throw new Error("test broker failed to start");
});

afterAll(async () => {
  broker?.kill();
  await Bun.file(DB).delete().catch(() => {});
});

test("fetch-messages peeks without consuming; ack-messages consumes", async () => {
  const a = await register(process.pid);
  const b = await register(process.pid);
  await brokerFetch("/send-message", { from_id: a.id, to_id: b.id, text: "durable hello" });

  const first = await brokerFetch<{ messages: Message[] }>("/fetch-messages", { id: b.id });
  const second = await brokerFetch<{ messages: Message[] }>("/fetch-messages", { id: b.id });
  expect(first.messages.length).toBe(1);
  expect(second.messages.length).toBe(1); // still there — peek, not drain

  // acking someone else's message must not work
  await brokerFetch("/ack-messages", { id: a.id, message_ids: [first.messages[0]!.id] });
  expect((await brokerFetch<{ messages: Message[] }>("/fetch-messages", { id: b.id })).messages.length).toBe(1);

  await brokerFetch("/ack-messages", { id: b.id, message_ids: [first.messages[0]!.id] });
  expect((await brokerFetch<{ messages: Message[] }>("/fetch-messages", { id: b.id })).messages.length).toBe(0);

  await brokerFetch("/unregister", { id: a.id });
  await brokerFetch("/unregister", { id: b.id });
});

test("server exits and unregisters when stdin closes", async () => {
  const proc = Bun.spawn(["bun", `${REPO}server.ts`], {
    env: ENV,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  // wait for it to register
  let registered: Peer[] = [];
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(100);
    registered = (
      await brokerFetch<Peer[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null })
    ).filter((p) => p.pid === proc.pid);
    if (registered.length > 0) break;
  }
  expect(registered.length).toBe(1);

  proc.stdin.end();
  const exited = await Promise.race([proc.exited, Bun.sleep(3000).then(() => "timeout")]);
  expect(exited).not.toBe("timeout");

  const after = (
    await brokerFetch<Peer[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null })
  ).filter((p) => p.pid === proc.pid);
  expect(after.length).toBe(0);
}, 15_000);

test("broker prunes live-PID peers whose heartbeats go stale", async () => {
  // Register with OUR pid (alive) but never heartbeat: TTL=1s, clean=300ms
  const peer = await register(process.pid);
  await Bun.sleep(2000);
  const peers = await brokerFetch<Peer[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
  expect(peers.find((p) => p.id === peer.id)).toBeUndefined();
}, 10_000);

test("delivery hook injects unsurfaced messages and acks; skips surfaced ones", async () => {
  const sender = await register(process.pid);
  const me = await register(process.pid);
  await brokerFetch("/send-message", { from_id: sender.id, to_id: me.id, text: "hook me" });
  const { messages } = await brokerFetch<{ messages: Message[] }>("/fetch-messages", { id: me.id });
  expect(messages.length).toBe(1);

  const transcriptPath = `/tmp/claude-peers-hook-test-${process.pid}.jsonl`;

  async function runHook(transcript: string, eventName: string): Promise<string> {
    await Bun.write(transcriptPath, transcript);
    const proc = Bun.spawn(["bun", `${REPO}hooks/claude-peers-hook.ts`], {
      env: { ...ENV, CLAUDE_PEERS_PEER_ID: me.id },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    proc.stdin.write(
      JSON.stringify({ hook_event_name: eventName, transcript_path: transcriptPath, cwd: "/tmp" })
    );
    proc.stdin.end();
    await proc.exited;
    return new Response(proc.stdout).text();
  }

  // Not in transcript → Stop hook blocks with the message, and acks it
  const out = await runHook("{}", "Stop");
  expect(out).toContain('"decision":"block"');
  expect(out).toContain("hook me");
  expect((await brokerFetch<{ messages: Message[] }>("/fetch-messages", { id: me.id })).messages.length).toBe(0);

  // Surfaced message (sent_at present in transcript) → acked silently
  await brokerFetch("/send-message", { from_id: sender.id, to_id: me.id, text: "already seen" });
  const fetched = await brokerFetch<{ messages: Message[] }>("/fetch-messages", { id: me.id });
  const surfaced = fetched.messages[0]!;
  const out2 = await runHook(`{"channel":"sent_at=\\"${surfaced.sent_at}\\""}`, "Stop");
  expect(out2.trim()).toBe("");
  expect((await brokerFetch<{ messages: Message[] }>("/fetch-messages", { id: me.id })).messages.length).toBe(0);

  await Bun.file(transcriptPath).delete().catch(() => {});
}, 20_000);
