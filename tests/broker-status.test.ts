import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, get, livePid, type TestBroker } from "./_helper.ts";
import { Database } from "bun:sqlite";

let broker: TestBroker;

beforeAll(async () => {
  // Use a tighter dormant TTL so we can exercise purge in-test.
  broker = await startBroker({ CLAUDE_PEERS_DORMANT_TTL_HOURS: "0" });
});
afterAll(async () => { await stopBroker(broker); });

async function register(host: string, cwd: string, pid: number) {
  return post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
    pid, cwd, git_root: null, tty: null, summary: "", host, client_pid: 1,
    project_key: null, group_id: "default", group_secret_hash: null,
  });
}

test("disconnect transitions a peer to 'dormant', and list_peers excludes it", async () => {
  const a = await register("hs1a", "/hs1a", livePid());
  const b = await register("hs1b", "/hs1b", livePid());
  await post(`${broker.url}/disconnect`, { instance_token: a.body.instance_token });

  const peers = await post<unknown[]>(`${broker.url}/list-peers`, {
    scope: "machine",
    instance_token: b.body.instance_token,
    cwd: "/x",
    git_root: null,
  });
  const tokens = peers.body.map((p: any) => p.instance_token);
  expect(tokens).not.toContain(a.body.instance_token);
});

test("admin/peers exposes dormant when ?include_dormant=1", async () => {
  const a = await register("hs2", "/hs2", livePid());
  await post(`${broker.url}/disconnect`, { instance_token: a.body.instance_token });

  const without = await get<any[]>(`${broker.url}/admin/peers`);
  expect(without.body.find((p) => p.instance_token === a.body.instance_token)).toBeUndefined();

  const withDormant = await get<any[]>(`${broker.url}/admin/peers?include_dormant=1`);
  const found = withDormant.body.find((p) => p.instance_token === a.body.instance_token);
  expect(found).toBeDefined();
  expect(found.status).toBe("dormant");
});

test("dormant peers past TTL are purged by cleanStalePeers", async () => {
  const a = await register("hs3", "/hs3", livePid());
  // Force disconnect (dormant) and backdate last_seen so it's past TTL=0.
  await post(`${broker.url}/disconnect`, { instance_token: a.body.instance_token });

  // Reach into the broker DB directly to backdate.
  const db = new Database(broker.dbPath);
  db.run("UPDATE peers SET last_seen = ? WHERE instance_token = ?", [
    "2000-01-01T00:00:00Z",
    a.body.instance_token,
  ]);
  db.close();

  // Wait for the next cleanStalePeers tick (interval is 30s), but invoking
  // /register on a fresh peer is enough to keep the broker active. We wait up
  // to 32s; in CI this is acceptable, locally use a shorter window via a hint.
  // For this test we rely on the fact that the very next register() call also
  // walks through cleanStalePeers via the periodic timer; we'll trigger one
  // and then poll admin/peers.
  let stillThere = true;
  for (let i = 0; i < 65 && stillThere; i++) {
    await Bun.sleep(500);
    const peers = await get<any[]>(`${broker.url}/admin/peers?include_dormant=1`);
    stillThere = !!peers.body.find((p) => p.instance_token === a.body.instance_token);
  }
  expect(stillThere).toBe(false);
}, 40_000);
