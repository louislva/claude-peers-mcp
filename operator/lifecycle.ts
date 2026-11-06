/**
 * Switchboard lifecycle rules shared by the watch.ts supervisor and the
 * loop.ts worker. Pure, so they are unit-tested (Astra review of 599f231).
 *
 * Ownership is the content of SUPERVISOR_LOCK: last writer wins (written by
 * atomic rename), and every other supervisor and its loop step aside on
 * their next check. Killing the previous supervisor is only a fast path;
 * correctness comes from this check, so concurrent starts cannot both ring.
 */
import { homedir } from "node:os";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const SUPERVISOR_LOCK = `${homedir()}/.claude-peers-supervisor.pid`;
export const RELOAD_EXIT = 75;   // loop → supervisor: my code changed, restart me
export const DISPLACED_EXIT = 76; // loop → supervisor: we no longer own the switchboard, exit too

export function mayRing(s: { supervisorPid: number; lockPid: number | null; isAlive: (pid: number) => boolean }): boolean {
  if (!s.supervisorPid) return true; // manual run (--once), no supervisor involved
  return s.lockPid === s.supervisorPid && s.isAlive(s.supervisorPid);
}

/** Report a crash streak once, when it reaches three; never repeat per crash. */
export const shouldReportCrash = (crashes: number) => crashes === 3;

export const readLockPid = (): number | null => {
  try { return Number(readFileSync(SUPERVISOR_LOCK, "utf8")) || null; } catch { return null; }
};
export const writeLockPid = (pid: number) => {
  const tmp = `${SUPERVISOR_LOCK}.${pid}`;
  writeFileSync(tmp, String(pid));
  renameSync(tmp, SUPERVISOR_LOCK);
};
export const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
