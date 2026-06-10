/**
 * Pure helpers for the opencode plugin (opencode-plugin.ts).
 *
 * Kept separate because opencode treats every export of a plugin file as a
 * plugin entry — the plugin file itself must only have its default export.
 */

import type { Message, Peer } from "./types.ts";

export type PsRow = { pid: number; ppid: number; args: string };

/** Parse `ps -eo pid=,ppid=,args=` output into rows. */
export function parsePsOutput(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) rows.push({ pid: +m[1]!, ppid: +m[2]!, args: m[3]! });
  }
  return rows;
}

/** Collect all descendant PIDs of root (children, grandchildren, ...). */
export function descendantPids(rows: PsRow[], root: number): Set<number> {
  const childrenOf = new Map<number, number[]>();
  for (const r of rows) {
    const list = childrenOf.get(r.ppid);
    if (list) list.push(r.pid);
    else childrenOf.set(r.ppid, [r.pid]);
  }
  const found = new Set<number>();
  const stack = [root];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    for (const child of childrenOf.get(pid) ?? []) {
      if (!found.has(child)) {
        found.add(child);
        stack.push(child);
      }
    }
  }
  return found;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Format an inbound peer message the same way Claude Code renders channel
 * notifications, so agent-facing instructions apply to both runtimes.
 */
export function formatChannelMessage(msg: Message, sender?: Peer): string {
  const attrs = [`source="claude-peers"`, `from_id="${escapeAttr(msg.from_id)}"`];
  if (sender?.summary) attrs.push(`from_summary="${escapeAttr(sender.summary)}"`);
  if (sender?.cwd) attrs.push(`from_cwd="${escapeAttr(sender.cwd)}"`);
  attrs.push(`sent_at="${escapeAttr(msg.sent_at)}"`);
  return (
    `<channel ${attrs.join(" ")}>\n${msg.text}\n</channel>\n` +
    `(Message from another agent on the claude-peers network — ` +
    `reply with the claude-peers send_message tool using the from_id above, then continue your work.)`
  );
}
