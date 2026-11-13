import type { Database } from "bun:sqlite";
import { wakeBatchMs } from "./delivery-state.ts";
import { liveMailboxIdsSql } from "./live-mailbox-groups.ts";

/**
 * Batched idle wakes.
 *
 * Every idle wake re-reads the woken seat's whole context. In the 24 h before
 * 2026-11-13, 1,208 of 3,858 agent turns were started only by peer mail. So an idle
 * seat holding only non-urgent mail is woken at most once per window, and the
 * wake then carries everything that queued meanwhile.
 *
 * The window is anchored on the seat's most recent acknowledged delivery
 * (MAX(delivered_at) across its mailbox). Every successful wake ends in that
 * acknowledgement, and the broker writes it, so both wake paths (the tmux
 * poller and the Claude standby watcher) read the same anchor from SQLite and
 * neither needs state of its own. A drain during an active turn also counts,
 * since that turn already saw the seat's mail.
 *
 * Only the wake is held. Messages stay queued and untouched, so check_messages,
 * prompt-time drains and message status see them exactly as before. Anything
 * that cannot be judged (unreadable DB, old fixture schema, odd timestamp)
 * returns false: the caller wakes the way it did before batching existed.
 */

// The window setting lives beside the undrained-warning threshold it feeds.
export { DEFAULT_WAKE_BATCH_MS, wakeBatchMs } from "./delivery-state.ts";

/** An urgent message starts with "URGENT:" (any case, after optional whitespace). */
export function isUrgentText(text: unknown): boolean {
  return typeof text === "string" && /^\s*urgent:/i.test(text);
}

/**
 * True when the idle wake for these mailboxes should wait: mail is pending,
 * none of it is urgent, and the last delivery is less than windowMs ago.
 */
export function wakeHeld(db: Database, peerIds: string[], nowMs: number, windowMs = wakeBatchMs()): boolean {
  if (windowMs <= 0 || peerIds.length === 0) return false;
  try {
    let pending = 0;
    let lastDelivery = Number.NEGATIVE_INFINITY;
    const pendingQuery = db.query(`SELECT text FROM messages WHERE to_id IN (${liveMailboxIdsSql}) AND delivered = 0`);
    const lastQuery = db.query(`SELECT MAX(delivered_at) AS last FROM messages WHERE to_id IN (${liveMailboxIdsSql}) AND delivered = 1`);
    for (const id of peerIds) {
      for (const row of pendingQuery.all(id) as Array<{ text: unknown }>) {
        if (isUrgentText(row.text)) return false;
        pending++;
      }
      const last = (lastQuery.get(id) as { last: string | null } | null)?.last;
      const parsed = last ? Date.parse(last) : Number.NaN;
      if (Number.isFinite(parsed) && parsed > lastDelivery) lastDelivery = parsed;
    }
    if (pending === 0 || !Number.isFinite(lastDelivery)) return false;
    const since = nowMs - lastDelivery;
    // A delivery stamped in the future means the clock moved; never hold on it.
    return since >= 0 && since < windowMs;
  } catch {
    return false;
  }
}

/** Mailbox rows for a Claude session, by thread identity and/or MCP pid. */
export function peerIdsForSession(db: Database, threadId: string | undefined, pid: number | undefined): string[] {
  const ids = new Set<string>();
  try {
    if (threadId) {
      for (const row of db.query("SELECT id FROM peers WHERE lower(thread_id) = lower(?)").all(threadId) as Array<{ id: string }>) ids.add(row.id);
    }
    if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0) {
      for (const row of db.query("SELECT id FROM peers WHERE pid = ?").all(pid) as Array<{ id: string }>) ids.add(row.id);
    }
  } catch {
    return [];
  }
  return [...ids];
}
