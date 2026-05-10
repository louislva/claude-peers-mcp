import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";

let broker: TestBroker;

beforeAll(async () => { broker = await startBroker(); });
afterAll(async () => { await stopBroker(broker); });

async function register(host: string, cwd: string) {
  return post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
    pid: livePid(), cwd, git_root: null, tty: null, summary: "", host, client_pid: 1,
    project_key: null, group_id: "default", group_secret_hash: null,
  });
}

function openWs(token: string | null): Promise<{ ws: WebSocket; firstClose: { code: number; reason: string } | null }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(broker.wsUrl);
    let resolved = false;
    let firstClose: { code: number; reason: string } | null = null;
    ws.addEventListener("open", () => {
      if (token !== null) ws.send(JSON.stringify({ type: "auth", instance_token: token }));
      else resolve({ ws, firstClose });
      // For valid auth: the broker doesn't send anything immediately back; resolve after a tick
      // so the caller can wire 'message' listeners.
      if (token !== null) {
        setTimeout(() => { if (!resolved) { resolved = true; resolve({ ws, firstClose }); } }, 100);
      }
    });
    ws.addEventListener("close", (e) => {
      firstClose = { code: e.code, reason: e.reason };
      if (!resolved) { resolved = true; resolve({ ws, firstClose }); }
    });
    ws.addEventListener("error", () => { if (!resolved) { resolved = true; reject(new Error("ws error")); } });
    setTimeout(() => { if (!resolved) { resolved = true; reject(new Error("ws timeout")); } }, 2000);
  });
}

test("auth with a valid instance_token keeps the socket open", async () => {
  const a = await register("ws1", "/ws1");
  const { ws } = await openWs(a.body.instance_token);
  // small tick to let the auth take effect
  await Bun.sleep(50);
  expect(ws.readyState).toBe(WebSocket.OPEN);
  ws.close();
});

test("auth with bogus instance_token closes the socket with 1008", async () => {
  const { firstClose } = await openWs("bogus-token-not-a-uuid");
  expect(firstClose).not.toBeNull();
  expect(firstClose!.code).toBe(1008);
});

test("send-message pushes immediately over WebSocket", async () => {
  const a = await register("ws2a", "/ws2a");
  const b = await register("ws2b", "/ws2b");

  const messages: any[] = [];
  const ws = new WebSocket(broker.wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "auth", instance_token: b.body.instance_token }));
      resolve();
    });
    ws.addEventListener("error", () => reject(new Error("ws err")));
    setTimeout(() => reject(new Error("ws open timeout")), 2000);
  });
  ws.addEventListener("message", (ev) => {
    const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
    messages.push(JSON.parse(text));
  });

  // Give auth a moment to register in wsPool.
  await Bun.sleep(100);
  await post(`${broker.url}/send-message`, {
    from_token: a.body.instance_token,
    to_peer_id: b.body.peer_id,
    text: "ws-direct",
  });
  // Wait briefly for the push.
  for (let i = 0; i < 20 && messages.length === 0; i++) await Bun.sleep(50);

  expect(messages.length).toBe(1);
  expect(messages[0].type).toBe("message");
  expect(messages[0].text).toBe("ws-direct");
  expect(messages[0].from_peer_id).toBe(a.body.peer_id);
  ws.close();
});

test("pending messages flush on reconnect", async () => {
  const a = await register("ws3a", "/ws3a");
  const b = await register("ws3b", "/ws3b");

  // No WS open: send accumulates as pending.
  await post(`${broker.url}/send-message`, {
    from_token: a.body.instance_token,
    to_peer_id: b.body.peer_id,
    text: "queued-1",
  });
  await post(`${broker.url}/send-message`, {
    from_token: a.body.instance_token,
    to_peer_id: b.body.peer_id,
    text: "queued-2",
  });

  // Now connect b's WS; both should arrive.
  const messages: any[] = [];
  const ws = new WebSocket(broker.wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "auth", instance_token: b.body.instance_token }));
      resolve();
    });
    ws.addEventListener("error", () => reject(new Error("ws err")));
    setTimeout(() => reject(new Error("open timeout")), 2000);
  });
  ws.addEventListener("message", (ev) => {
    const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
    messages.push(JSON.parse(text));
  });

  for (let i = 0; i < 30 && messages.length < 2; i++) await Bun.sleep(50);
  expect(messages.length).toBe(2);
  expect(messages.map((m) => m.text).sort()).toEqual(["queued-1", "queued-2"]);
  ws.close();
});
