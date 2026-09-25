#!/usr/bin/env bun
/**
 * claude-peers switchboard supervisor: the operator session's Monitor command.
 * It runs operator/loop.ts and restarts it by itself, so the operator model
 * is never in the reload or crash path:
 *   - loop exits RELOAD_EXIT (its code changed)  → restart at once, silently;
 *   - loop crashes                               → restart after a backoff,
 *     and print WATCHER-ERROR only if it keeps crashing.
 * Every line the loop prints (WAKE / UNDELIVERED / ACTIVITY) passes through.
 *
 * One switchboard at a time: the newest supervisor wins. On start it stops
 * the one named in SUPERVISOR_LOCK (a re-armed Monitor replaces a stale one
 * whose output nobody reads any more).
 *
 * Why (2026-09-25): the loop used to exit on reload and wait for the operator
 * to re-arm Monitor. The operator got distracted, never did, and mail sat
 * unrung for 34 minutes. Keep this file small: a change to it still needs a
 * Monitor re-arm, which the operator's heartbeat now guarantees.
 *
 *   bun operator/watch.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const LOOP = new URL("./loop.ts", import.meta.url).pathname;
const RELOAD_EXIT = 75; // mirrors loop.ts
const SUPERVISOR_LOCK = `${homedir()}/.claude-peers-supervisor.pid`;

const commandOf = (pid: number) => {
  const r = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]);
  return r.stdout.toString().trim();
};
try {
  const prev = Number(readFileSync(SUPERVISOR_LOCK, "utf8"));
  if (prev && prev !== process.pid && commandOf(prev).includes("operator/watch.ts")) process.kill(prev, "SIGTERM");
} catch {}
writeFileSync(SUPERVISOR_LOCK, String(process.pid));

let child: ReturnType<typeof Bun.spawn> | null = null;
const shutdown = () => { child?.kill(); process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

let crashes = 0;
for (;;) {
  const started = Date.now();
  child = Bun.spawn([process.execPath, LOOP], {
    stdout: "inherit", stderr: "inherit",
    env: { ...process.env, CLAUDE_PEERS_SUPERVISOR_PID: String(process.pid) },
  });
  const code = await child.exited;
  if (code === RELOAD_EXIT) { crashes = 0; continue; }
  crashes = Date.now() - started > 60_000 ? 1 : crashes + 1; // a long healthy run resets the streak
  if (crashes >= 3) console.log(`WATCHER-ERROR loop exited ${crashes} times in a row (last code ${code}); still restarting`);
  await Bun.sleep(Math.min(60_000, 2_000 * 2 ** Math.min(crashes, 5)));
}
