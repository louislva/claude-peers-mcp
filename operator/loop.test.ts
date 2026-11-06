import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { DISPLACED_EXIT } from "./lifecycle.ts";

// The loop process itself, isolated: HOME points at a temp dir (lock and
// liveness stamp live there) and the broker port is closed, so any attempt to
// touch the board would print an error instead of silently succeeding.
const LOOP = new URL("./loop.ts", import.meta.url).pathname;
async function runLoop(supervisorPid: number, lockPid: number | null) {
  const home = mkdtempSync(`${tmpdir()}/peers-loop-`);
  if (lockPid !== null) writeFileSync(`${home}/.claude-peers-supervisor.pid`, String(lockPid));
  const p = Bun.spawn([process.execPath, LOOP], {
    env: { ...process.env, HOME: home, CLAUDE_PEERS_PORT: "1", CLAUDE_PEERS_SUPERVISOR_PID: String(supervisorPid) },
    stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill(), 8000);
  const code = await p.exited; clearTimeout(timer);
  return { code, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text(), stamped: existsSync(`${home}/.claude-peers-watcher.json`) };
}

describe("the loop never touches the board without an owning supervisor", () => {
  test("orphaned (supervisor pid gone): exits before any claim, print or stamp", async () => {
    const r = await runLoop(2_147_000_000, 2_147_000_000);
    expect(r).toEqual({ code: DISPLACED_EXIT, out: "", err: "", stamped: false });
  });

  test("displaced (a newer live supervisor holds the lock): exits the same way", async () => {
    const r = await runLoop(process.ppid, process.pid); // both alive; lock names the other one
    expect(r).toEqual({ code: DISPLACED_EXIT, out: "", err: "", stamped: false });
  });
});
