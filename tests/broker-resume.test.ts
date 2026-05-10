import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";

let broker: TestBroker;

beforeAll(async () => { broker = await startBroker(); });
afterAll(async () => { await stopBroker(broker); });

async function register(host: string, cwd: string, pid: number = livePid()) {
  return post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
    pid, cwd, git_root: null, tty: null, summary: "", host, client_pid: 1,
    project_key: null, group_id: "default", group_secret_hash: null,
  });
}

test("re-register after /disconnect resurrects the same instance_token and peer_id", async () => {
  const a = await register("hostR", "/p1");
  const tok1 = a.body.instance_token;
  const id1 = a.body.peer_id;

  await post(`${broker.url}/disconnect`, { instance_token: tok1 });

  const a2 = await register("hostR", "/p1");
  expect(a2.body.instance_token).toBe(tok1);
  expect(a2.body.peer_id).toBe(id1);
});

test("dead-pid registration on the same (host, cwd) is treated as resurrect", async () => {
  // First, register with a known-dead pid (very large, unlikely to be assigned).
  const deadPid = 999_999_999;
  const a = await register("hostD", "/dp", deadPid);
  const tok1 = a.body.instance_token;
  const id1 = a.body.peer_id;

  // Re-register with a live pid; broker should detect dead pid -> resurrect.
  const a2 = await register("hostD", "/dp", livePid());
  expect(a2.body.instance_token).toBe(tok1);
  expect(a2.body.peer_id).toBe(id1);
});

test("different (host, cwd, group) yields distinct peers", async () => {
  const a = await register("h1", "/c1");
  const b = await register("h2", "/c1"); // different host
  const c = await register("h1", "/c2"); // different cwd
  expect(a.body.instance_token).not.toBe(b.body.instance_token);
  expect(a.body.instance_token).not.toBe(c.body.instance_token);
});
