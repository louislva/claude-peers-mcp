#!/usr/bin/env bun
/**
 * Operator heartbeat check. The operator session runs this on a timer
 * (peers-operator skill, "Heartbeat") and acts on what it prints; it prints
 * nothing when all is well, so a healthy tick costs no output.
 *
 * Why it exists (2026-09-25): the watcher exited on a code reload, the
 * operator model got distracted and never re-armed it, and mail sat unrung
 * for 34 minutes with nothing noticing. A watcher cannot report its own
 * absence; this check reads the pass stamp the watcher leaves behind.
 *
 *   bun operator/health.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAlive, readLockPid } from "./lifecycle.ts";

/** Written by the watcher loop every few seconds, even mid-pass:
 *  { pid, at, pass_started_at } (pass_started_at is null between passes). */
export const PASS_STAMP = `${homedir()}/.claude-peers-watcher.json`;
/** The loop stamps every ~5s; a minute of silence means it is not running. */
export const STALE_AFTER_MS = 60_000;
/** A live loop inside one pass this long is stuck (dispatch timeouts are 60s each). */
export const STUCK_AFTER_MS = 15 * 60_000;

const mins = (ms: number) => Math.round(ms / 60_000);

export function assessHealth(s: {
  now: number;
  broker: { status: string; wake?: boolean } | null;
  aliveAt: number | null;
  passStartedAt: number | null;
  /** Owner-bound health: the stamp only counts if the lock owner wrote it and still runs. */
  stampOwner?: number | null;
  lockOwner?: number | null;
  ownerAlive?: boolean;
}): string[] {
  const out: string[] = [];
  if (!s.broker) out.push("BROKER-DOWN broker not answering on /health; push Kiel");
  else if (!s.broker.wake) out.push("BROKER-DOWN broker is running without wake support; push Kiel");
  if (s.lockOwner !== undefined && s.stampOwner !== undefined && s.aliveAt !== null && s.stampOwner !== s.lockOwner)
    out.push(`WATCHER-DOWN liveness stamp is from supervisor ${s.stampOwner}, not the owner ${s.lockOwner}; re-arm Monitor now`);
  else if (s.lockOwner && s.ownerAlive === false)
    out.push(`WATCHER-DOWN owning supervisor ${s.lockOwner} is not running; re-arm Monitor now`);
  else if (s.aliveAt === null) out.push("WATCHER-DOWN no watcher pass on record; re-arm Monitor now");
  else if (s.now - s.aliveAt > STALE_AFTER_MS)
    out.push(`WATCHER-DOWN last pass ${mins(s.now - s.aliveAt)} min ago; re-arm Monitor now`);
  // Stuck is reported, never re-armed: re-arming would kill a pass that may be mid-dispatch.
  else if (s.passStartedAt !== null && s.now - s.passStartedAt > STUCK_AFTER_MS)
    out.push(`WATCHER-STUCK one pass has run ${mins(s.now - s.passStartedAt)} min; push Kiel`);
  return out;
}

if (import.meta.main) {
  const port = process.env.CLAUDE_PEERS_PORT ?? "7899";
  const broker = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) })
    .then(r => (r.ok ? r.json() : null)).catch(() => null);
  let aliveAt: number | null = null, passStartedAt: number | null = null, stampOwner: number | null = null;
  try { const s = JSON.parse(readFileSync(PASS_STAMP, "utf8")); aliveAt = s.at ?? null; passStartedAt = s.pass_started_at ?? null; stampOwner = s.supervisor ?? null; } catch {}
  const lockOwner = readLockPid();
  for (const line of assessHealth({ now: Date.now(), broker, aliveAt, passStartedAt, stampOwner, lockOwner, ownerAlive: lockOwner ? isAlive(lockOwner) : undefined })) console.log(line);
}
