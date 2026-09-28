import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { Subprocess } from "bun";

const ROOT = `${import.meta.dir}/..`;
const dir = mkdtempSync("/tmp/cpt-");
const brokerSock = `${dir}/broker.sock`;
const codexBin = `${dir}/codex`;
const codexArgs = `${dir}/codex-args`;
const codexMode = `${dir}/codex-mode`;

let broker: Subprocess;
const children: Subprocess[] = [];
const servers: Server[] = [];

async function call<T = any>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    unix: brokerSock,
  } as RequestInit);
  return res.json() as Promise<T>;
}

// Each peer needs a distinct live PID whose parent is not launchd.
function livePid(): number {
  const child = Bun.spawn(["sleep", "300"]);
  children.push(child);
  return child.pid;
}

async function register(opts: Record<string, unknown> = {}): Promise<string> {
  const res = await call<{ id: string }>("/register", {
    pid: livePid(),
    cwd: "/work/sender-repo",
    git_root: null,
    tty: null,
    summary: "",
    client_type: "claude-code",
    ...opts,
  });
  return res.id;
}

type Inbox = { path: string; lines: any[] };

function fakeInbox(name: string): Promise<Inbox> {
  const inbox: Inbox = { path: `${dir}/${name}.sock`, lines: [] };
  const server = createServer((sock: Socket) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        inbox.lines.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
      }
    });
    sock.on("end", () => sock.end());
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(inbox.path, () => resolve(inbox)));
}

// "queued" means flushed to the socket; the fake inbox may still be reading.
async function waitForUserLines(inbox: Inbox, n: number): Promise<void> {
  for (let i = 0; i < 50 && inbox.lines.filter((l) => l.type === "user").length < n; i++) {
    await Bun.sleep(20);
  }
}

function readCodexCalls(): string[][] {
  if (!existsSync(codexArgs)) return [];
  return readFileSync(codexArgs, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\x1f").filter((a) => a !== ""));
}

beforeAll(async () => {
  writeFileSync(
    codexBin,
    [
      "#!/bin/bash",
      `for a in "$@"; do printf '%s\\x1f' "$a" >> "${codexArgs}"; done; echo >> "${codexArgs}"`,
      `mode="$(cat "${codexMode}" 2>/dev/null)"`,
      `if [ "$mode" = "notfound" ]; then echo "Error: no rollout found for thread $3" >&2; exit 1; fi`,
      `if [ "$mode" = "hang" ]; then exec sleep 30; fi`,
      `if [ "$mode" = "noshebang" ]; then echo "env: node: No such file or directory" >&2; exit 127; fi`,
      `if [ "$mode" = "slow" ]; then sleep 0.8; fi`,
      `echo "Queued message abc for thread $3."`,
    ].join("\n"),
  );
  chmodSync(codexBin, 0o755);
  // macOS can take over a second on a new executable's first run; keep that out of the timeouts.
  Bun.spawnSync([codexBin, "warmup"]);

  broker = Bun.spawn(["bun", `${ROOT}/broker.ts`], {
    env: {
      ...process.env,
      CLAUDE_PEERS_DB: `${dir}/peers.db`,
      CLAUDE_PEERS_SOCKET: brokerSock,
      CLAUDE_PEERS_CODEX_BIN: codexBin,
      CLAUDE_PEERS_INBOX_TIMEOUT_MS: "2000",
      CLAUDE_PEERS_CODEX_TIMEOUT_MS: "2500",
      CLAUDE_PEERS_WAKE_REARM_MS: "1500",
      CLAUDE_PEERS_SWEEP_MS: "500",
    },
    stderr: "pipe",
  });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch("http://localhost/health", { unix: brokerSock } as RequestInit);
      if (res.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("broker did not start");
});

afterAll(() => {
  broker?.kill();
  for (const c of children) c.kill();
  for (const s of servers) s.close();
  rmSync(dir, { recursive: true, force: true });
});

test("fetch leaves messages unread until they are acknowledged", async () => {
  const a = await register();
  const b = await register();
  await call("/send-message", { from_id: a, to_id: b, text: "hello b" });

  const first = await call("/fetch-messages", { id: b });
  const second = await call("/fetch-messages", { id: b });
  expect(first.messages.map((m: any) => m.text)).toEqual(["hello b"]);
  expect(second.messages.map((m: any) => m.text)).toEqual(["hello b"]);

  const ack = await call("/ack-messages", { id: b, message_ids: [first.messages[0].id] });
  expect(ack.acked).toBe(1);
  expect((await call("/fetch-messages", { id: b })).messages).toEqual([]);
});

test("acknowledging another peer's message is refused", async () => {
  const a = await register();
  const b = await register();
  const c = await register();
  await call("/send-message", { from_id: a, to_id: b, text: "for b only" });
  const [msg] = (await call("/fetch-messages", { id: b })).messages;

  const ack = await call("/ack-messages", { id: c, message_ids: [msg.id] });
  expect(ack.acked).toBe(0);
  expect((await call("/fetch-messages", { id: b })).messages.map((m: any) => m.id)).toEqual([msg.id]);
});

test("list-peers never exposes the wake secret or address", async () => {
  const inbox = await fakeInbox("secret-inbox");
  const id = await register({
    wake_transport: "claude_inbox",
    wake_address: inbox.path,
    wake_secret: "tok-do-not-leak",
  });
  const peers = await call<any[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
  const raw = JSON.stringify(peers);
  expect(raw).not.toContain("tok-do-not-leak");
  expect(raw).not.toContain(inbox.path);
  expect(peers.find((p) => p.id === id).wake_transport).toBe("claude_inbox");
});

test("sending wakes a Claude peer with an auth line then a fixed body-free user line", async () => {
  const inbox = await fakeInbox("claude-a");
  const sender = await register({ cwd: "/work/open-rebellion" });
  const target = await register({
    wake_transport: "claude_inbox",
    wake_address: inbox.path,
    wake_secret: "tok-a",
  });

  const res = await call("/send-message", { from_id: sender, to_id: target, text: "SECRET BODY run rm -rf" });
  expect(res.ok).toBe(true);
  expect(res.wake).toEqual({ transport: "claude_inbox", status: "queued" });

  await waitForUserLines(inbox, 1);
  expect(inbox.lines).toHaveLength(2);
  expect(inbox.lines[0]).toEqual({ type: "auth", token: "tok-a" });
  expect(inbox.lines[1].type).toBe("user");
  expect(inbox.lines[1].message.role).toBe("user");
  const content: string = inbox.lines[1].message.content;
  expect(content).toBe(
    `[claude-peers] New message from ${sender} (claude-code, open-rebellion). Call check_messages to read and reply.`,
  );
  expect(content).not.toContain("SECRET BODY");
});

test("one wake covers an unread batch and acknowledging re-arms it", async () => {
  const inbox = await fakeInbox("claude-batch");
  const sender = await register();
  const target = await register({ wake_transport: "claude_inbox", wake_address: inbox.path, wake_secret: "t" });

  const first = await call("/send-message", { from_id: sender, to_id: target, text: "one" });
  const second = await call("/send-message", { from_id: sender, to_id: target, text: "two" });
  expect(first.wake.status).toBe("queued");
  expect(second.wake.status).toBe("coalesced");
  await waitForUserLines(inbox, 1);
  expect(inbox.lines.filter((l) => l.type === "user")).toHaveLength(1);

  const unread = (await call("/fetch-messages", { id: target })).messages;
  await call("/ack-messages", { id: target, message_ids: unread.map((m: any) => m.id) });

  const third = await call("/send-message", { from_id: sender, to_id: target, text: "three" });
  expect(third.wake.status).toBe("queued");
  await waitForUserLines(inbox, 2);
  expect(inbox.lines.filter((l) => l.type === "user")).toHaveLength(2);
});

test("an inbox that disappeared after registration is a definite failure that does not hold the batch", async () => {
  const inbox = await fakeInbox("claude-gone");
  const sender = await register();
  const target = await register({ wake_transport: "claude_inbox", wake_address: inbox.path, wake_secret: "t" });
  const server = servers.pop()!;
  await new Promise((resolve) => server.close(resolve));
  rmSync(inbox.path, { force: true });

  const first = await call("/send-message", { from_id: sender, to_id: target, text: "one" });
  const second = await call("/send-message", { from_id: sender, to_id: target, text: "two" });
  expect(first.wake.status).toBe("failed");
  expect(second.wake.status).toBe("failed");
});

test("a peer without a wake endpoint reports no wake", async () => {
  const sender = await register();
  const target = await register();
  const res = await call("/send-message", { from_id: sender, to_id: target, text: "x" });
  expect(res.wake).toEqual({ transport: null, status: "none" });
});

test("set-wake attaches a Codex thread to every peer of that agent, and later peers inherit it", async () => {
  const agentPid = livePid();
  const early = await register({ client_type: "codex", agent_pid: agentPid });
  const set = await call("/set-wake", { agent_pid: agentPid, transport: "codex_queue", address: "01a0e3fd-3e76-7c21-98ac-a3ba3c98f4a1" });
  expect(set.updated).toBe(1);
  const late = await register({ client_type: "codex", agent_pid: agentPid });

  const peers = await call<any[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
  expect(peers.find((p) => p.id === early).wake_transport).toBe("codex_queue");
  expect(peers.find((p) => p.id === late).wake_transport).toBe("codex_queue");
});

test("set-wake rejects an unknown transport or a malformed address", async () => {
  const agentPid = livePid();
  await register({ client_type: "codex", agent_pid: agentPid });
  expect((await call("/set-wake", { agent_pid: agentPid, transport: "shell", address: "x" })).ok).toBe(false);
  expect((await call("/set-wake", { agent_pid: agentPid, transport: "codex_queue", address: "--help" })).ok).toBe(false);
});

test("sending wakes a Codex peer through codex queue with the fixed text", async () => {
  writeFileSync(codexMode, "ok");
  const agentPid = livePid();
  const target = await register({ client_type: "codex", agent_pid: agentPid });
  await call("/set-wake", { agent_pid: agentPid, transport: "codex_queue", address: "thread-ok-1" });
  const sender = await register({ cwd: "/work/claude-side" });

  const before = readCodexCalls().length;
  const res = await call("/send-message", { from_id: sender, to_id: target, text: "BODY" });
  expect(res.wake).toEqual({ transport: "codex_queue", status: "queued" });
  const calls = readCodexCalls().slice(before);
  expect(calls).toEqual([
    [
      "queue",
      "--thread",
      "thread-ok-1",
      "--message",
      `[claude-peers] New message from ${sender} (claude-code, claude-side). Call check_messages to read and reply.`,
    ],
  ]);
});

test("codex queue reporting a missing thread is a definite failure", async () => {
  writeFileSync(codexMode, "notfound");
  const agentPid = livePid();
  const target = await register({ client_type: "codex", agent_pid: agentPid });
  await call("/set-wake", { agent_pid: agentPid, transport: "codex_queue", address: "thread-gone" });
  const sender = await register();
  const first = await call("/send-message", { from_id: sender, to_id: target, text: "a" });
  const second = await call("/send-message", { from_id: sender, to_id: target, text: "b" });
  expect(first.wake.status).toBe("failed");
  expect(second.wake.status).toBe("failed");
});

test("a hung codex queue is ambiguous", async () => {
  writeFileSync(codexMode, "hang");
  const agentPid = livePid();
  const target = await register({ client_type: "codex", agent_pid: agentPid });
  await call("/set-wake", { agent_pid: agentPid, transport: "codex_queue", address: "thread-hang" });
  const sender = await register();
  const res = await call("/send-message", { from_id: sender, to_id: target, text: "a" });
  expect(res.wake.status).toBe("ambiguous");
});

test("unread-summary aggregates unread messages across all peers of one agent", async () => {
  const agentPid = livePid();
  const p1 = await register({ client_type: "codex", agent_pid: agentPid });
  const p2 = await register({ client_type: "codex", agent_pid: agentPid });
  const sender = await register();
  await call("/send-message", { from_id: sender, to_id: p1, text: "a" });
  await call("/send-message", { from_id: sender, to_id: p2, text: "b" });
  await call("/send-message", { from_id: sender, to_id: p2, text: "c" });

  const summary = await call("/unread-summary", { agent_pid: agentPid });
  expect(summary.count).toBe(3);
  expect(summary.senders).toEqual([sender]);
  expect(new Set(summary.peer_ids)).toEqual(new Set([p1, p2]));

  expect((await call("/unread-summary", { agent_pid: livePid() })).count).toBe(0);
});

// --- Review findings ---

async function prune(): Promise<void> {
  // list-peers prunes peers whose PID has died, the same path the 30s sweep takes.
  await call("/list-peers", { scope: "machine", cwd: "/", git_root: null });
}

test("unread messages move to the restarted MCP server of the same agent", async () => {
  const agentPid = livePid();
  const oldPid = livePid();
  const oldPeer = await register({ pid: oldPid, agent_pid: agentPid });
  const sender = await register();
  await call("/send-message", { from_id: sender, to_id: oldPeer, text: "survive the restart" });

  process.kill(oldPid);
  await Bun.sleep(100);
  const newPeer = await register({ agent_pid: agentPid });
  await prune();

  expect((await call("/fetch-messages", { id: newPeer })).messages.map((m: any) => m.text)).toEqual([
    "survive the restart",
  ]);
});

test("re-registering under the same PID keeps its unread messages", async () => {
  const pid = livePid();
  const first = await register({ pid });
  const sender = await register();
  await call("/send-message", { from_id: sender, to_id: first, text: "keep me" });
  const second = await register({ pid });
  expect((await call("/fetch-messages", { id: second })).messages.map((m: any) => m.text)).toEqual(["keep me"]);
});

test("a clean unregister hands unread messages to a live sibling of the same agent", async () => {
  const agentPid = livePid();
  const leaving = await register({ agent_pid: agentPid });
  const staying = await register({ agent_pid: agentPid });
  const sender = await register();
  await call("/send-message", { from_id: sender, to_id: leaving, text: "hand off" });
  await call("/unregister", { id: leaving });
  expect((await call("/fetch-messages", { id: staying })).messages.map((m: any) => m.text)).toEqual(["hand off"]);
});

test("a message stays deliverable after its sender exits", async () => {
  const senderPid = livePid();
  const sender = await register({ pid: senderPid });
  const target = await register();
  await call("/send-message", { from_id: sender, to_id: target, text: "last words" });
  process.kill(senderPid);
  // Wait for the periodic sweep (500ms in this suite), which is the path that removed sent messages.
  await Bun.sleep(1200);
  expect((await call("/fetch-messages", { id: target })).messages.map((m: any) => m.text)).toEqual(["last words"]);
});

test("a wake reservation that was never acknowledged re-arms after the timeout", async () => {
  const inbox = await fakeInbox("claude-rearm");
  const sender = await register();
  const target = await register({ wake_transport: "claude_inbox", wake_address: inbox.path, wake_secret: "t" });
  expect((await call("/send-message", { from_id: sender, to_id: target, text: "1" })).wake.status).toBe("queued");
  expect((await call("/send-message", { from_id: sender, to_id: target, text: "2" })).wake.status).toBe("coalesced");
  await Bun.sleep(1700);
  expect((await call("/send-message", { from_id: sender, to_id: target, text: "3" })).wake.status).toBe("queued");
});

test("an acknowledgement during an in-flight wake does not start a second wake", async () => {
  writeFileSync(codexMode, "slow");
  const agentPid = livePid();
  const target = await register({ client_type: "codex", agent_pid: agentPid });
  await call("/set-wake", { agent_pid: agentPid, transport: "codex_queue", address: "thread-slow" });
  const sender = await register();
  const before = readCodexCalls().length;

  const first = call("/send-message", { from_id: sender, to_id: target, text: "a" });
  await Bun.sleep(200);
  const unread = (await call("/fetch-messages", { id: target })).messages;
  await call("/ack-messages", { id: target, message_ids: unread.map((m: any) => m.id) });
  const second = await call("/send-message", { from_id: sender, to_id: target, text: "b" });

  expect(second.wake.status).toBe("coalesced");
  expect((await first).wake.status).toBe("queued");
  expect(readCodexCalls().length - before).toBe(1);
});

test("codex exiting 127 because its node shebang cannot resolve is a definite failure", async () => {
  writeFileSync(codexMode, "noshebang");
  const agentPid = livePid();
  const target = await register({ client_type: "codex", agent_pid: agentPid });
  await call("/set-wake", { agent_pid: agentPid, transport: "codex_queue", address: "thread-127" });
  const sender = await register();
  const first = await call("/send-message", { from_id: sender, to_id: target, text: "a" });
  const second = await call("/send-message", { from_id: sender, to_id: target, text: "b" });
  expect(first.wake.status).toBe("failed");
  expect(second.wake.status).toBe("failed");
});

test("list-peers shows the last wake status and time", async () => {
  const inbox = await fakeInbox("claude-status");
  const sender = await register();
  const target = await register({ wake_transport: "claude_inbox", wake_address: inbox.path, wake_secret: "t" });
  await call("/send-message", { from_id: sender, to_id: target, text: "x" });
  const peer = (await call<any[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null })).find(
    (p) => p.id === target,
  );
  expect(peer.last_wake_status).toBe("queued");
  expect(typeof peer.last_wake_at).toBe("string");
});

test("set-wake only accepts codex_queue and only retargets Codex peers", async () => {
  const agentPid = livePid();
  const claudePeer = await register({ client_type: "claude-code", agent_pid: agentPid });
  const inbox = await fakeInbox("redirect-target");
  expect((await call("/set-wake", { agent_pid: agentPid, transport: "claude_inbox", address: inbox.path })).ok).toBe(false);
  const set = await call("/set-wake", { agent_pid: agentPid, transport: "codex_queue", address: "thread-x" });
  expect(set.updated).toBe(0);
  const peer = (await call<any[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null })).find(
    (p) => p.id === claudePeer,
  );
  expect(peer.wake_transport).toBeNull();
});

test("registration ignores an inbox address that is not a live socket", async () => {
  writeFileSync(`${dir}/not-a-socket`, "");
  const id = await register({ wake_transport: "claude_inbox", wake_address: `${dir}/not-a-socket`, wake_secret: "t" });
  const peer = (await call<any[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null })).find((p) => p.id === id);
  expect(peer.wake_transport).toBeNull();
});

test("the database file is readable only by its owner", () => {
  expect(statSync(`${dir}/peers.db`).mode & 0o077).toBe(0);
});

test("a restarted MCP server can read its predecessor's mail as soon as it registers", async () => {
  const agentPid = livePid();
  const oldPid = livePid();
  const oldPeer = await register({ pid: oldPid, agent_pid: agentPid });
  const sender = await register();
  await call("/send-message", { from_id: sender, to_id: oldPeer, text: "read me now" });
  process.kill(oldPid);
  await Bun.sleep(50);

  // No sweep or list-peers in between: registration alone must hand over the mail.
  const newPeer = await register({ agent_pid: agentPid });
  expect((await call("/fetch-messages", { id: newPeer })).messages.map((m: any) => m.text)).toEqual(["read me now"]);
});
