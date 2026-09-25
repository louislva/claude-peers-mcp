#!/usr/bin/env bun
/**
 * claude-peers switchboard supervisor: the operator session's Monitor command.
 * It runs operator/loop.ts and restarts it by itself, so the operator model
 * is never in the reload or crash path:
 *   - loop exits RELOAD_EXIT (its code changed)  → restart at once, silently;
 *   - loop exits DISPLACED_EXIT (lost ownership) → exit too;
 *   - loop crashes                               → restart after a backoff,
 *     printing WATCHER-ERROR once per crash streak (at the third).
 * Every line the loop prints (WAKE / UNDELIVERED / ACTIVITY) passes through.
 *
 * One switchboard at a time: ownership is SUPERVISOR_LOCK's content (atomic
 * rename, last writer wins; see lifecycle.ts). Killing the previous owner is
 * only a fast path: a displaced supervisor and its loop also step aside at
 * their next check, so concurrent starts cannot both ring.
 *
 * Why (2026-09-25): the loop used to exit on reload and wait for the operator
 * to re-arm Monitor. The operator got distracted, never did, and mail sat
 * unrung for 34 minutes. Keep this file small: a change to it still needs a
 * Monitor re-arm, which the operator's heartbeat guarantees.
 *
 *   bun operator/watch.ts
 */
import { DISPLACED_EXIT, RELOAD_EXIT, readLockPid, shouldReportCrash, writeLockPid } from "./lifecycle.ts";

const LOOP = new URL("./loop.ts", import.meta.url).pathname;

const commandOf = (pid: number) =>
  Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]).stdout.toString().trim();
const prev = readLockPid();
writeLockPid(process.pid);
if (prev && prev !== process.pid && commandOf(prev).includes("operator/watch.ts")) {
  try { process.kill(prev, "SIGTERM"); } catch {}
}

let child: ReturnType<typeof Bun.spawn> | null = null;
const shutdown = () => { child?.kill(); process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

let crashes = 0;
for (;;) {
  if (readLockPid() !== process.pid) shutdown(); // displaced while we slept
  const started = Date.now();
  child = Bun.spawn([process.execPath, LOOP], {
    stdout: "inherit", stderr: "inherit",
    env: { ...process.env, CLAUDE_PEERS_SUPERVISOR_PID: String(process.pid) },
  });
  const code = await child.exited;
  if (code === RELOAD_EXIT) { crashes = 0; continue; }
  if (code === DISPLACED_EXIT) shutdown();
  crashes = Date.now() - started > 60_000 ? 1 : crashes + 1; // a long healthy run resets the streak
  if (shouldReportCrash(crashes)) console.log(`WATCHER-ERROR loop crashed ${crashes} times in a row (last code ${code}); still restarting`);
  await Bun.sleep(Math.min(60_000, 2_000 * 2 ** Math.min(crashes, 5)));
}
