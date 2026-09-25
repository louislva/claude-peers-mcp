import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

// Real supervisor processes, isolated: HOME is a temp dir (lock + stamp) and
// the broker port is closed, so their loops never touch the live board.
const WATCH = new URL("./watch.ts", import.meta.url).pathname;
const home = mkdtempSync(`${tmpdir()}/peers-watch-`);
const env = { ...process.env, HOME: home, CLAUDE_PEERS_PORT: "1" };
const start = () => Bun.spawn([process.execPath, WATCH], { env, stdout: "pipe", stderr: "ignore" });
const lockPid = () => { try { return Number(readFileSync(`${home}/.claude-peers-supervisor.pid`, "utf8")); } catch { return 0; } };
const until = async (cond: () => boolean) => { for (let i = 0; i < 100 && !cond(); i++) await Bun.sleep(50); };

test("a newer supervisor takes over; the old one says DISPLACED once, and an expired owner says nothing", async () => {
  const a = start();
  await until(() => lockPid() === a.pid);
  const b = start();
  await until(() => lockPid() === b.pid);

  expect(await a.exited).toBe(0);
  expect((await new Response(a.stdout).text()).trim())
    .toBe(`DISPLACED switchboard now owned by supervisor ${b.pid}; do not re-arm`);

  b.kill("SIGTERM"); // what a Monitor expiry does: owner stops, operator must re-arm
  expect(await b.exited).toBe(0);
  expect((await new Response(b.stdout).text()).trim()).toBe("");
}, 15_000);
