#!/usr/bin/env bun
/**
 * claude-peers delivery hook for Claude Code
 *
 * Channel push only works in sessions launched with
 * `--dangerously-load-development-channels server:claude-peers`; sessions
 * without it (notably daemon-hosted "claude agents" sessions) silently drop
 * the notification, and the MCP handshake gives the server no way to tell
 * the difference. This hook closes the gap at turn boundaries:
 *
 *  1. fetches this session's unacked messages from the broker
 *  2. checks the session transcript to see which ones already surfaced as
 *     channel notifications (exact per-message delivery confirmation)
 *  3. acks everything it saw, and injects the ones that never surfaced —
 *     as additionalContext on UserPromptSubmit, or by blocking on Stop so
 *     the agent processes them before finishing
 *
 * Register in ~/.claude/settings.json under hooks.UserPromptSubmit and
 * hooks.Stop:
 *   { "hooks": [{ "type": "command",
 *     "command": "bun /path/to/claude-peers-mcp/hooks/claude-peers-hook.ts" }] }
 *
 * Env: CLAUDE_PEERS_PORT (default 7899), CLAUDE_PEERS_PEER_ID (override
 * peer discovery, mainly for tests).
 */

import type { Message, Peer, PeerId, PollMessagesResponse } from "../shared/types.ts";
import { formatChannelMessage, parsePsOutput, type PsRow } from "../shared/opencode.ts";

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`Broker error (${path}): ${res.status}`);
  return res.json() as Promise<T>;
}

/** PIDs of this process's ancestors (nearest first, excluding init). */
function ancestorPids(rows: PsRow[], start: number): number[] {
  const parentOf = new Map(rows.map((r) => [r.pid, r.ppid]));
  const chain: number[] = [];
  let pid = parentOf.get(start);
  while (pid && pid > 1 && !chain.includes(pid)) {
    chain.push(pid);
    pid = parentOf.get(pid);
  }
  return chain;
}

/**
 * Find the peer registered by this session's MCP server: the hook and the
 * server are both descendants of the same Claude Code process, so the peer
 * whose server's parent is our nearest shared ancestor is ours.
 */
async function findMyPeerId(cwd: string): Promise<PeerId | null> {
  if (process.env.CLAUDE_PEERS_PEER_ID) return process.env.CLAUDE_PEERS_PEER_ID;
  const rows = parsePsOutput(Bun.spawnSync(["ps", "-eo", "pid=,ppid=,args="]).stdout.toString());
  const ancestors = ancestorPids(rows, process.pid);
  const parentOf = new Map(rows.map((r) => [r.pid, r.ppid]));
  const peers = await brokerFetch<Peer[]>("/list-peers", {
    scope: "machine",
    cwd,
    git_root: null,
  });
  // Prefer the peer attached to our NEAREST ancestor (the Claude process
  // itself), so we never match a sibling session through a shared supervisor.
  let best: { id: PeerId; depth: number } | null = null;
  for (const peer of peers) {
    const serverParent = parentOf.get(peer.pid);
    if (serverParent === undefined) continue;
    const depth = ancestors.indexOf(serverParent);
    if (depth >= 0 && (best === null || depth < best.depth)) {
      best = { id: peer.id, depth };
    }
  }
  return best?.id ?? null;
}

async function main() {
  const input = (await new Response(process.stdin).json()) as {
    hook_event_name?: string;
    transcript_path?: string;
    cwd?: string;
  };

  let peerId: PeerId | null;
  let messages: Message[];
  try {
    peerId = await findMyPeerId(input.cwd ?? process.cwd());
    if (!peerId) return;
    const res = await brokerFetch<PollMessagesResponse>("/fetch-messages", { id: peerId });
    messages = res.messages;
  } catch {
    return; // broker down or too old — never break the session over delivery
  }
  if (messages.length === 0) return;

  // A message that already surfaced as a channel notification appears in the
  // transcript with its exact sent_at timestamp in the channel attributes.
  let transcript = "";
  if (input.transcript_path) {
    transcript = await Bun.file(input.transcript_path)
      .text()
      .catch(() => "");
  }
  const undelivered = messages.filter((m) => !transcript.includes(m.sent_at));

  // Everything fetched is now accounted for: surfaced ones were already seen,
  // the rest are delivered below.
  await brokerFetch("/ack-messages", { id: peerId, message_ids: messages.map((m) => m.id) });

  if (undelivered.length === 0) return;

  let senders: Peer[] = [];
  try {
    senders = await brokerFetch<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: input.cwd ?? process.cwd(),
      git_root: null,
    });
  } catch {
    // sender context is optional
  }
  const body = undelivered
    .map((m) => formatChannelMessage(m, senders.find((p) => p.id === m.from_id)))
    .join("\n\n");

  if (input.hook_event_name === "Stop") {
    console.log(
      JSON.stringify({
        decision: "block",
        reason:
          `Peer message(s) arrived via claude-peers while you were working:\n\n${body}\n\n` +
          `Handle them (reply with send_message where appropriate), then finish.`,
      })
    );
  } else {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: input.hook_event_name ?? "UserPromptSubmit",
          additionalContext: body,
        },
      })
    );
  }
}

main().catch(() => {
  // Hooks must never crash the session
});
