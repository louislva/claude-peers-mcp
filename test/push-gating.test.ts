/**
 * Integration test for client-aware push gating in server.ts:
 *  - a client named "Claude Code" gets inbound messages pushed as
 *    notifications/claude/channel (and its queue is drained)
 *  - any other client (e.g. opencode) must NOT have its queue drained —
 *    messages stay in the broker for check_messages / the opencode plugin
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Peer } from "../shared/types.ts";

const PORT = 17899;
const DB = `/tmp/claude-peers-test-${process.pid}.db`;
const BROKER_URL = `http://127.0.0.1:${PORT}`;
const ENV = {
  ...process.env,
  CLAUDE_PEERS_PORT: String(PORT),
  CLAUDE_PEERS_DB: DB,
  OPENAI_API_KEY: "", // disable auto-summary so startup is fast and offline
};

let broker: ReturnType<typeof Bun.spawn>;
const clients: Client[] = [];

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

const listPeers = () =>
  brokerFetch<Peer[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null });

async function startClient(name: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [new URL("../server.ts", import.meta.url).pathname],
    env: ENV as Record<string, string>,
  });
  const client = new Client({ name, version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function toolText(result: unknown): string {
  return ((result as { content: { type: string; text: string }[] }).content ?? [])
    .map((c) => c.text)
    .join("\n");
}

beforeAll(async () => {
  broker = Bun.spawn(["bun", new URL("../broker.ts", import.meta.url).pathname], {
    env: ENV as Record<string, string>,
    stdio: ["ignore", "ignore", "ignore"],
  });
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(100);
    if (await fetch(`${BROKER_URL}/health`).then((r) => r.ok).catch(() => false)) return;
  }
  throw new Error("test broker failed to start");
});

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
  broker?.kill();
  await Bun.file(DB).delete().catch(() => {});
});

test(
  "opencode client keeps messages queued; claude client gets channel push",
  async () => {
    // Start the opencode-named client first so we can identify its peer id
    const opencodeClient = await startClient("opencode");
    let peers = await listPeers();
    expect(peers.length).toBe(1);
    const opencodePeerId = peers[0]!.id;

    const claudeClient = await startClient("Claude Code");
    peers = await listPeers();
    expect(peers.length).toBe(2);
    const claudePeerId = peers.find((p) => p.id !== opencodePeerId)!.id;

    const pushed: { method: string; params: unknown }[] = [];
    claudeClient.fallbackNotificationHandler = async (n) => {
      pushed.push({ method: n.method, params: n.params });
    };

    // --- claude -> opencode: must NOT be drained by the server's poll loop ---
    await claudeClient.callTool({
      name: "send_message",
      arguments: { to_id: opencodePeerId, message: "hello opencode" },
    });
    // Wait well past the 1s poll interval; a draining loop would eat it
    await Bun.sleep(3000);
    const checked = toolText(
      await opencodeClient.callTool({ name: "check_messages", arguments: {} })
    );
    expect(checked).toContain("hello opencode");

    // --- opencode -> claude: must arrive as a channel notification ---
    await opencodeClient.callTool({
      name: "send_message",
      arguments: { to_id: claudePeerId, message: "hello claude" },
    });
    for (let i = 0; i < 50 && pushed.length === 0; i++) await Bun.sleep(100);
    expect(pushed.length).toBe(1);
    expect(pushed[0]!.method).toBe("notifications/claude/channel");
    expect(JSON.stringify(pushed[0]!.params)).toContain("hello claude");

    // ...but the push does NOT ack: the message stays recoverable until an
    // acking consumer (check_messages / the delivery hook) takes it
    const claudeChecked = toolText(
      await claudeClient.callTool({ name: "check_messages", arguments: {} })
    );
    expect(claudeChecked).toContain("hello claude");
    expect(claudeChecked).toContain("also pushed");

    // ...and check_messages acked it, so a second call comes back empty
    const claudeChecked2 = toolText(
      await claudeClient.callTool({ name: "check_messages", arguments: {} })
    );
    expect(claudeChecked2).toContain("No new messages");

    // the push loop must not re-push unacked messages it already pushed
    expect(pushed.length).toBe(1);
  },
  30_000
);
