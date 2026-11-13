#!/usr/bin/env bun
// Standby-watcher helper: prints "hold" when this idle Claude session's wake
// should wait for the batch window (see shared/wake-batch.ts), else "wake".
// Usage: claude-wake-batch.ts <session_id|""> <mcp_pid|"">
// Any failure prints "wake", which is the watcher's behavior before batching.
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { peerIdsForSession, wakeHeld } from "../shared/wake-batch.ts";

export function wakeBatchDecision(dbPath: string, threadId: string | undefined, pid: number | undefined, nowMs = Date.now()): "hold" | "wake" {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    return wakeHeld(db, peerIdsForSession(db, threadId, pid), nowMs) ? "hold" : "wake";
  } catch {
    return "wake";
  } finally {
    db?.close();
  }
}

if (import.meta.main) {
  const [threadArg, pidArg] = process.argv.slice(2);
  const pid = pidArg && /^\d+$/.test(pidArg) ? Number(pidArg) : undefined;
  const dbPath = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME || homedir()}/.claude-peers.db`;
  process.stdout.write(`${wakeBatchDecision(dbPath, threadArg || undefined, pid)}\n`);
}
