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

test("set_id renames within the group", async () => {
  const a = await register("hsid1", "/sid1");
  const r = await post<{ peer_id: string; previous: string }>(`${broker.url}/set-id`, {
    instance_token: a.body.instance_token,
    new_peer_id: "alice",
  });
  expect(r.status).toBe(200);
  expect(r.body.peer_id).toBe("alice");
  expect(r.body.previous).toBe(a.body.peer_id);
});

test("set_id collides with active peer -> 409", async () => {
  const a = await register("hsid2a", "/sid2a");
  const b = await register("hsid2b", "/sid2b");
  await post(`${broker.url}/set-id`, { instance_token: a.body.instance_token, new_peer_id: "bob" });
  const r = await post<{ error: string }>(`${broker.url}/set-id`, {
    instance_token: b.body.instance_token,
    new_peer_id: "bob",
  });
  expect(r.status).toBe(409);
  expect(r.body.error).toContain("already taken");
});

test("set_id collides with dormant peer -> 409", async () => {
  const a = await register("hsid3a", "/sid3a");
  await post(`${broker.url}/set-id`, { instance_token: a.body.instance_token, new_peer_id: "carol" });
  // a goes dormant.
  await post(`${broker.url}/disconnect`, { instance_token: a.body.instance_token });
  const b = await register("hsid3b", "/sid3b");
  const r = await post<{ error: string }>(`${broker.url}/set-id`, {
    instance_token: b.body.instance_token,
    new_peer_id: "carol",
  });
  expect(r.status).toBe(409);
});

test("set_id rejects malformed names", async () => {
  const a = await register("hsid4", "/sid4");
  const r = await post<{ error: string }>(`${broker.url}/set-id`, {
    instance_token: a.body.instance_token,
    new_peer_id: "Has Spaces!",
  });
  expect(r.status).toBe(400);
});

test("messages survive a set_id rename (routing keyed by instance_token)", async () => {
  const a = await register("hsid5a", "/sid5a");
  const b = await register("hsid5b", "/sid5b");
  // a -> b initial peer_id
  await post(`${broker.url}/send-message`, {
    from_token: a.body.instance_token,
    to_peer_id: b.body.peer_id,
    text: "before-rename",
  });
  // rename b
  await post(`${broker.url}/set-id`, { instance_token: b.body.instance_token, new_peer_id: "renamed-b" });
  // b polls -- should receive the message even though their display name changed
  const poll = await post<{ messages: { text: string }[] }>(`${broker.url}/poll-messages`, {
    instance_token: b.body.instance_token,
  });
  expect(poll.body.messages.length).toBe(1);
  expect(poll.body.messages[0]!.text).toBe("before-rename");
});
