/**
 * Reap predicate — single source of truth for "is this peer reapable?"
 *
 * Extracted from broker.ts (#7 narrow, 2026-05-14) so tests can import the
 * real symbol instead of mirroring it. Pure module: no top-level side
 * effects, no DB connection, no listener — safe to import from tests
 * without spawning a competing broker (broker.ts:930 has top-level
 * Bun.serve which is why broker.ts itself can't be imported from tests).
 *
 * Used by liveAndFreshPeers (broker.ts) on every reap path: the periodic
 * cleanStalePeers sweep AND the per-request handleListPeers /
 * handleBroadcast checks. Both apply the same predicate, both fire the
 * same side-effect cleanup, both reach the same DB end-state.
 *
 * Two reap conditions, either sufficient:
 *   1. PID dead (kill(pid,0) returns ESRCH) — original behavior
 *   2. last_seen older than ttlMs — catches PID-alive zombies (a
 *      `bun server.ts` whose parent claude died but bun lingered)
 *
 * NaN guard: malformed last_seen string fails parsing → only the PID gate
 * can reap it, never the TTL gate. Defensive — prevents a single bad row
 * from cascading into mass deletion.
 */

export const PEER_GHOST_AFTER_MS = 90_000;

/**
 * Returns true if the peer should be reaped, false if it should survive.
 * Generic over peer shape so tests can pass minimal {pid, last_seen}
 * fixtures without constructing the full Peer interface.
 */
export function isReapable(
  peer: { pid: number; last_seen: string },
  isPidAlive: (pid: number) => boolean,
  now: number,
  ttlMs: number,
): boolean {
  if (!isPidAlive(peer.pid)) return true;
  const lastSeenMs = new Date(peer.last_seen).getTime();
  if (Number.isNaN(lastSeenMs)) return false; // graceful: invalid timestamp not auto-reaped
  return now - lastSeenMs > ttlMs;
}

/**
 * TTL ceiling on the "preserve a DEAD seat that still holds undelivered mail"
 * rule (liveAndFreshPeers preserve branch). A dead seat's inbox is recoverable
 * by a returning session via the rehydrate/inherit path — but only worth keeping
 * for a bounded window. Without this ceiling a session that dies with unread mail
 * and never returns keeps its row + mail FOREVER (the reaper won't drop the row
 * because it has mail; the orphan-mail sweep won't drop the mail because the row
 * still exists — a mutual-protection deadlock).
 *
 * Returns true when the dead-with-mail seat has aged past graceMs and should now
 * be reaped (row + stranded mail) instead of preserved. `graceMs` is floored at
 * `floorMs` (the rehydrate window) so a seat is ALWAYS inheritable for at least
 * that long regardless of a misconfigured env override. A non-finite/NaN ageMs
 * (corrupt last_seen) returns false here — those rows are handled by the caller's
 * existing lastSeenValid guard, not this one.
 */
export function deadSeatMailExpired(ageMs: number, graceMs: number, floorMs: number): boolean {
  if (!Number.isFinite(ageMs)) return false;
  return ageMs > Math.max(floorMs, graceMs);
}

/**
 * Pure size-cap decision for the broker's own log (rotateBrokerLogIfLarge).
 * Extracted here for the same reason as isReapable/deadSeatMailExpired —
 * broker.ts is not import-safe, so the predicate lives in this side-effect-free
 * module and the fs orchestration (statSync → truncateSync) stays in the broker.
 * Returns true when the log should be truncated (strictly over the cap; a log
 * exactly at the cap is not rotated, mirroring the strict-`>` boundary used
 * elsewhere in this module).
 */
export function shouldRotateLog(sizeBytes: number, maxBytes: number): boolean {
  return sizeBytes > maxBytes;
}
