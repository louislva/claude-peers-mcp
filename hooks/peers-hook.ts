#!/usr/bin/env bun
/**
 * claude-peers turn-boundary hook for Claude Code and Codex CLI.
 *
 *   bun hooks/peers-hook.ts --harness claude|codex   (hook payload JSON on stdin)
 *
 * - SessionStart (Codex): registers the thread ID so the broker can wake it via `codex queue`.
 * - UserPromptSubmit / SessionStart: surfaces unread peer messages as context.
 * - PreToolUse (Bash): warns before `git add|commit|push` while peer messages are unread.
 * - Stop: blocks finishing while peer messages are unread, the safety net for failed wakes.
 *
 * Fails open: if the broker is down or the session has no peer, it prints nothing.
 */

import { basename, dirname } from "node:path";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { DEFAULT_SOCKET_PATH } from "../shared/types.ts";
import type { SetWakeResponse, UnreadSummaryResponse } from "../shared/types.ts";

const LOG_FILE = process.env.CLAUDE_PEERS_HOOK_LOG ?? `${process.env.HOME}/.claude/run/claude-peers-hook.log`;
const LOG_MAX_BYTES = 1_000_000;

// Failing open must not mean failing invisibly: record why the hook stayed silent.
function logQuietFailure(harness: string, event: string | undefined, detail: string): void {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    try {
      if (statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch {}
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${harness} ${event ?? "?"} ${detail}\n`);
  } catch {}
}

export type Harness = "claude" | "codex";

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
  tool_input?: { command?: string | string[] };
}

const GIT_STAGING = /\bgit\s+(?:-C\s+\S+\s+)?(add|commit|push)\b/;

export function stagingCommand(payload: HookPayload): boolean {
  const command = payload.tool_input?.command;
  const text = Array.isArray(command) ? command.join(" ") : (command ?? "");
  return GIT_STAGING.test(text);
}

function unreadLine(summary: UnreadSummaryResponse): string {
  return `claude-peers: ${summary.count} unread peer message(s) from ${summary.senders.join(", ")}.`;
}

// Returns the hook's stdout, or null to stay silent.
export function hookResponse(harness: Harness, payload: HookPayload, summary: UnreadSummaryResponse): string | null {
  // An older broker answers /unread-summary with a 404 body that has no count.
  if (!(typeof summary.count === "number" && summary.count > 0)) return null;
  const event = payload.hook_event_name;

  switch (event) {
    case "Stop":
      // A second block in a row would loop; the first one already put the reminder in context.
      if (payload.stop_hook_active) return null;
      return JSON.stringify({
        decision: "block",
        reason: `${unreadLine(summary)} Call check_messages and reply before finishing.`,
      });
    case "PreToolUse":
      if (!stagingCommand(payload)) return null;
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: `${unreadLine(summary)} A peer may have flagged these files; call check_messages before staging or pushing.`,
        },
      });
    case "UserPromptSubmit":
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `${unreadLine(summary)} Call check_messages.`,
        },
      });
    case "SessionStart":
      if (harness !== "codex") return null;
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `${unreadLine(summary)} Call check_messages.`,
        },
      });
    default:
      return null;
  }
}

function parentOf(pid: number): { ppid: number; comm: string } | null {
  const proc = Bun.spawnSync(["ps", "-o", "ppid=,comm=", "-p", String(pid)]);
  const out = new TextDecoder().decode(proc.stdout).trim();
  const match = out.match(/^(\d+)\s+(.+)$/);
  return match ? { ppid: Number(match[1]), comm: match[2]! } : null;
}

// The agent process is the MCP server's parent, so the broker keys peers by it.
export function findAgentPid(harness: Harness, startPid = process.ppid): number | null {
  const override = Number(process.env.CLAUDE_PEERS_AGENT_PID);
  if (override > 1) return override;
  let pid = startPid;
  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    const info = parentOf(pid);
    if (!info) return null;
    // comm is the executable path alone; it may contain spaces ("Application Support/...").
    const name = basename(info.comm);
    if (name === harness) return pid;
    pid = info.ppid;
  }
  return null;
}

async function brokerCall<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    unix: process.env.CLAUDE_PEERS_SOCKET ?? DEFAULT_SOCKET_PATH,
    signal: AbortSignal.timeout(2000),
  } as RequestInit);
  return res.json() as Promise<T>;
}

// Codex SessionStart can run before the MCP server registers, so every Codex event that carries
// the thread ID repeats the registration; /set-wake is idempotent.
const CODEX_WAKE_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "Stop"]);

async function main(harness: Harness, payload: HookPayload): Promise<void> {
  const event = payload.hook_event_name;

  // Cheap exit for the common case: most Bash calls are not staging.
  if (event === "PreToolUse" && !stagingCommand(payload)) return;

  const agentPid = findAgentPid(harness);
  if (!agentPid) {
    logQuietFailure(harness, event, "no claude/codex ancestor process found");
    return;
  }

  if (harness === "codex" && payload.session_id && CODEX_WAKE_EVENTS.has(event ?? "")) {
    const set = await brokerCall<SetWakeResponse>("/set-wake", {
      agent_pid: agentPid,
      transport: "codex_queue",
      address: payload.session_id,
    });
    if (!set.ok) logQuietFailure(harness, event, `set-wake rejected: ${set.error}`);
    else if (set.updated === 0) logQuietFailure(harness, event, `set-wake updated no peer for agent ${agentPid}`);
  }

  const summary = await brokerCall<UnreadSummaryResponse>("/unread-summary", { agent_pid: agentPid });
  const output = hookResponse(harness, payload, summary);
  if (output) process.stdout.write(output);
}

if (import.meta.main) {
  const harnessArg = process.argv[process.argv.indexOf("--harness") + 1];
  const harness: Harness = harnessArg === "codex" ? "codex" : "claude";
  let payload: HookPayload = {};
  Bun.stdin
    .json()
    .then((parsed) => {
      payload = parsed as HookPayload;
      return main(harness, payload);
    })
    .catch((e) => {
      // Fail open: a broken hook must never block the agent.
      logQuietFailure(harness, payload.hook_event_name, e instanceof Error ? e.message : String(e));
    });
}
