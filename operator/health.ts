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

/** Written by the watcher loop after every pass. */
export const PASS_STAMP = `${homedir()}/.claude-peers-watcher.json`;
/** The loop passes every ~2s; a minute of silence means it is not running. */
export const STALE_AFTER_MS = 60_000;

export function assessHealth(s: {
  now: number;
  broker: { status: string; wake?: boolean } | null;
  lastPassAt: number | null;
}): string[] {
  const out: string[] = [];
  if (!s.broker) out.push("BROKER-DOWN broker not answering on /health; push Kiel");
  else if (!s.broker.wake) out.push("BROKER-DOWN broker is running without wake support; push Kiel");
  if (s.lastPassAt === null) out.push("WATCHER-DOWN no watcher pass on record; re-arm Monitor now");
  else if (s.now - s.lastPassAt > STALE_AFTER_MS)
    out.push(`WATCHER-DOWN last pass ${Math.round((s.now - s.lastPassAt) / 60_000)} min ago; re-arm Monitor now`);
  return out;
}

if (import.meta.main) {
  const port = process.env.CLAUDE_PEERS_PORT ?? "7899";
  const broker = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) })
    .then(r => (r.ok ? r.json() : null)).catch(() => null);
  let lastPassAt: number | null = null;
  try { lastPassAt = JSON.parse(readFileSync(PASS_STAMP, "utf8")).at ?? null; } catch {}
  for (const line of assessHealth({ now: Date.now(), broker, lastPassAt })) console.log(line);
}
