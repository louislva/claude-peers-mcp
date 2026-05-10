import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, groupId, sha256Hex, type TestBroker } from "./_helper.ts";

let broker: TestBroker;

beforeAll(async () => { broker = await startBroker(); });
afterAll(async () => { await stopBroker(broker); });

async function register(extra: Record<string, unknown> = {}) {
  return post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
    pid: livePid(),
    cwd: "/tmp/foo",
    git_root: null,
    tty: null,
    summary: "",
    host: "h1",
    client_pid: 1,
    project_key: null,
    group_id: "default",
    group_secret_hash: null,
    ...extra,
  });
}

test("TOFU creates a new group on first register", async () => {
  const gid = await groupId("secret-1");
  const hash = await sha256Hex("secret-1");
  const res = await register({ group_id: gid, group_secret_hash: hash, host: "tofu1", cwd: "/p1" });
  expect(res.status).toBe(200);
  expect(res.body.instance_token).toBeTruthy();
});

test("TOFU rejects mismatched secret_hash with 401", async () => {
  const gid = await groupId("secret-2");
  const goodHash = await sha256Hex("secret-2");
  const r1 = await register({ group_id: gid, group_secret_hash: goodHash, host: "tofu2", cwd: "/p2" });
  expect(r1.status).toBe(200);
  const r2 = await register({ group_id: gid, group_secret_hash: "deadbeef", host: "tofu2", cwd: "/p3" });
  expect(r2.status).toBe(401);
});

test("list_peers is isolated by group", async () => {
  const gA = await groupId("alpha");
  const hA = await sha256Hex("alpha");
  const gB = await groupId("beta");
  const hB = await sha256Hex("beta");

  const a = await register({ group_id: gA, group_secret_hash: hA, host: "ga-host", cwd: "/ga" });
  const b = await register({ group_id: gA, group_secret_hash: hA, host: "ga-host2", cwd: "/ga2" });
  const c = await register({ group_id: gB, group_secret_hash: hB, host: "gb-host", cwd: "/gb" });

  const list = await post<unknown[]>(`${broker.url}/list-peers`, {
    scope: "machine",
    instance_token: a.body.instance_token,
    cwd: "/ga",
    git_root: null,
  });

  // a's caller is in gA; should see b (also in gA), not c (in gB).
  const tokens = list.body.map((p: any) => p.instance_token);
  expect(tokens).toContain(b.body.instance_token);
  expect(tokens).not.toContain(c.body.instance_token);
  expect(tokens).not.toContain(a.body.instance_token); // self excluded
});

test("send_message rejects cross-group routing", async () => {
  const gA = await groupId("xg-a");
  const hA = await sha256Hex("xg-a");
  const gB = await groupId("xg-b");
  const hB = await sha256Hex("xg-b");

  const a = await register({ group_id: gA, group_secret_hash: hA, host: "xa", cwd: "/xa" });
  const b = await register({ group_id: gB, group_secret_hash: hB, host: "xb", cwd: "/xb" });

  const send = await post<{ ok: boolean; error?: string }>(`${broker.url}/send-message`, {
    from_token: a.body.instance_token,
    to_peer_id: b.body.peer_id,
    text: "hi",
  });
  expect(send.body.ok).toBe(false);
  expect(send.body.error).toContain("not found in your group");
});

test("'default' group accepts registration without secret", async () => {
  const r = await register({ host: "def-host", cwd: "/def" });
  expect(r.status).toBe(200);
});
