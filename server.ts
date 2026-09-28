#!/usr/bin/env bun
/**
 * claude-peers MCP server
 *
 * Stdio MCP server spawned once per AI coding agent (Claude Code, Codex CLI).
 * Connects to the shared broker daemon for peer discovery and messaging.
 * The broker wakes recipients natively (Claude inbox socket, `codex queue`) with a fixed
 * nudge; check_messages reads and acknowledges. Claude sessions without an inbox socket
 * fall back to claude/channel push.
 *
 * Usage:
 *   bun server.ts [--client-type claude-code|codex|cli]
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_SOCKET_PATH } from "./shared/types.ts";
import type {
  PeerId,
  ClientType,
  Peer,
  RegisterRequest,
  RegisterResponse,
  PollMessagesResponse,
  AckMessagesResponse,
  SendMessageResponse,
  WakeStatus,
  Message,
} from "./shared/types.ts";

// --- Client type detection ---

function parseClientType(): ClientType {
  const idx = process.argv.indexOf("--client-type");
  if (idx !== -1 && process.argv[idx + 1]) {
    const val = process.argv[idx + 1];
    if (val === "codex" || val === "claude-code" || val === "cli") return val;
  }
  return "claude-code";
}

const CLIENT_TYPE: ClientType = parseClientType();

// --- Configuration ---

const SOCKET_PATH = process.env.CLAUDE_PEERS_SOCKET ?? DEFAULT_SOCKET_PATH;
const BROKER_TCP = process.env.CLAUDE_PEERS_URL; // optional TCP fallback for debugging
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;

// --- Broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const url = BROKER_TCP ? `${BROKER_TCP}${path}` : `http://localhost${path}`;
  const opts: RequestInit & { unix?: string } = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  if (!BROKER_TCP) opts.unix = SOCKET_PATH;

  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const url = BROKER_TCP ? `${BROKER_TCP}/health` : "http://localhost/health";
    const opts: RequestInit & { unix?: string } = { signal: AbortSignal.timeout(2000) };
    if (!BROKER_TCP) opts.unix = SOCKET_PATH;
    const res = await fetch(url, opts);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  // Broker is managed by launchd (com.minoan.claude-peers-broker.plist).
  // If not running, wait briefly in case it's starting up.
  log("Broker not reachable, waiting for launchd to start it...");
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isBrokerAlive()) {
      log("Broker is now available");
      return;
    }
  }

  throw new Error(
    "Broker not running. Ensure com.minoan.claude-peers-broker is loaded: " +
    "launchctl load ~/Library/LaunchAgents/com.minoan.claude-peers-broker.plist"
  );
}

// --- Utility ---

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging (stdout is the MCP protocol)
  console.error(`[claude-peers] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

function getTty(): string | null {
  try {
    // Try to get the parent's tty from the process tree
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") {
        return tty;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// --- State ---

let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

// Claude Code v2.1.224+ exports its inbox socket to MCP servers; the broker wakes through it.
const INBOX_SOCKET = CLIENT_TYPE === "claude-code" ? process.env.CLAUDE_CODE_MESSAGING_SOCKET : undefined;
const INBOX_TOKEN = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
const WAKE_NUDGE_PREFIX = "[claude-peers] New message from";

// --- MCP Server ---

// --- Client-adaptive MCP configuration ---

function buildCapabilities(): Record<string, unknown> {
  const caps: Record<string, unknown> = { tools: {} };
  if (CLIENT_TYPE === "claude-code") {
    caps.experimental = { "claude/channel": {} };
  }
  return caps;
}

function buildInstructions(): string {
  const common = `You are connected to the claude-peers network. Other AI coding agents (Claude Code, Codex CLI) on this machine can see you and send you messages.

Available tools:
- list_peers: Discover other AI coding agents (scope: machine/directory/repo)
- send_message: Send a message to another peer by ID
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- check_messages: Manually check for new messages

When you start, proactively call set_summary to describe what you're working on. This helps other peers understand your context.`;

  const nudge = `When a message starting "${WAKE_NUDGE_PREFIX} <peer_id>" arrives, that is claude-peers waking you: call check_messages right away, reply with send_message, then resume your work. The nudge never contains the message itself.`;

  if (CLIENT_TYPE === "claude-code") {
    return `${common}

${nudge}

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_summary, and from_cwd attributes to understand who sent the message. Reply by calling send_message with their from_id.`;
  }

  // Codex: woken through `codex queue` once a SessionStart hook has registered the thread.
  return `${common}

${nudge}

An idle thread is woken by that nudge; a busy one sees it after the current turn. Also call check_messages at the start of each turn, since wakes can fail. When you find messages, reply using send_message before continuing your work.

Read the from_id field to identify the sender. Use list_peers to see their summary and working directory for context.`;
}

const mcp = new Server(
  { name: "claude-peers", version: "0.1.0" },
  {
    capabilities: buildCapabilities(),
    instructions: buildInstructions(),
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other AI coding agents running on this machine. Returns their ID, client type, working directory, git repo, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all peers on this computer. "directory" = same working directory. "repo" = same git repository (including worktrees or subdirectories).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another AI coding agent by peer ID. The broker wakes the recipient (Claude inbox socket or codex queue) and reports whether the wake was queued.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID of the target agent (from list_peers)",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other peers when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Read and acknowledge messages from other peers. Call it whenever a claude-peers wake nudge arrives, and at the start of each turn.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "kill_peer",
    description:
      "Forcibly terminate another peer's agent session by sending SIGTERM to its parent process. This is irreversible and aborts any in-progress work. Use only when a peer is confirmed stuck or unresponsive and cannot be reached via send_message. Peers that finish work unregister themselves automatically.",
    inputSchema: {
      type: "object" as const,
      properties: {
        peer_id: {
          type: "string" as const,
          description: "The peer ID to kill (from list_peers)",
        },
      },
      required: ["peer_id"],
    },
  },
];

function describeWake(status: WakeStatus, transport: string | null): string {
  switch (status) {
    case "queued":
      return `Recipient woken via ${transport}.`;
    case "coalesced":
      return "Recipient already has a pending wake for its unread messages.";
    case "failed":
      return `Wake via ${transport} failed; the recipient sees this when it next checks or finishes its turn.`;
    case "ambiguous":
      return `Wake via ${transport} timed out; delivery of the nudge is unknown.`;
    default:
      return "Recipient has no wake endpoint; it sees this on its next check_messages.";
  }
}

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId,
        });

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other peers found (scope: ${scope}).`,
              },
            ],
          };
        }

        const lines = peers.map((p) => {
          const parts = [
            `ID: ${p.id}`,
            `Type: ${p.client_type ?? "claude-code"}`,
            `PID: ${p.pid}`,
            `CWD: ${p.cwd}`,
          ];
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.tty) parts.push(`TTY: ${p.tty}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          const lastWake = p.last_wake_status ? `, last ${p.last_wake_status} at ${p.last_wake_at}` : "";
          parts.push(`Wake: ${p.wake_transport ?? "none (sees messages only when it checks)"}${lastWake}`);
          parts.push(`Last seen: ${p.last_seen}`);
          return parts.join("\n  ");
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<SendMessageResponse>("/send-message", {
          from_id: myId,
          to_id,
          text: message,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Message sent to peer ${to_id}. ${describeWake(result.wake?.status ?? "none", result.wake?.transport ?? null)}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        // History first, then unread: anything arriving between the two calls lands in the unread
        // set, so every message shown as history is either acked already or marked [NEW] here.
        const history = await brokerFetch<{ messages: Message[] }>("/message-history", {
          id: myId,
          limit: 20,
        });
        const unread = await brokerFetch<PollMessagesResponse>("/fetch-messages", { id: myId });
        const newIds = new Set(unread.messages.map((m) => m.id));
        // Unread messages outside the history window are still shown before they are acked.
        const shown = [
          ...history.messages,
          ...unread.messages.filter((m) => !history.messages.some((h) => h.id === m.id)),
        ].sort((a, b) => b.sent_at.localeCompare(a.sent_at));

        // Acknowledge exactly what is shown; anything newer stays unread for the next check.
        if (newIds.size > 0) {
          await brokerFetch<AckMessagesResponse>("/ack-messages", { id: myId, message_ids: [...newIds] });
        }

        if (shown.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No messages." }],
          };
        }

        // Build peer lookup for enrichment
        let peerMap = new Map<string, Peer>();
        try {
          const peers = await brokerFetch<Peer[]>("/list-peers", {
            scope: "machine",
            cwd: myCwd,
            git_root: myGitRoot,
          });
          for (const p of peers) peerMap.set(p.id, p);
        } catch {
          // Non-critical
        }

        const newCount = newIds.size;
        const lines = shown.map((m) => {
          const isNew = newIds.has(m.id);
          const isSent = m.from_id === myId;
          const otherId = isSent ? m.to_id : m.from_id;
          const otherPeer = peerMap.get(otherId);
          const tag = otherPeer?.client_type ?? "unknown";
          const context = otherPeer ? (otherPeer.summary || otherPeer.cwd) : otherId;
          const direction = isSent ? `To ${otherId}` : `From ${otherId}`;
          const prefix = isNew ? "[NEW] " : "";
          return `${prefix}[${tag}] ${direction} (${context}) — ${m.sent_at}\n  ${m.text}`;
        });

        const header = newCount > 0
          ? `${shown.length} message(s) (${newCount} new):`
          : `${shown.length} message(s):`;

        return {
          content: [
            {
              type: "text" as const,
              text: `${header}\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "kill_peer": {
      const { peer_id } = args as { peer_id: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string; killed_pid?: number }>("/kill-peer", {
          id: peer_id,
          from_id: myId,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to kill peer: ${result.error}` }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Killed peer ${peer_id} (PID ${result.killed_pid}). The agent session has been terminated.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error killing peer: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Polling loop for inbound messages ---

// Fallback for Claude sessions without an inbox socket. A channel push can be silently
// dropped (sessions launched without the development-channels flag), so pushing never
// acknowledges; check_messages does.
let polling = false;
let pushedIds = new Set<number>();

async function pollAndPushMessages() {
  if (CLIENT_TYPE !== "claude-code") return;
  if (!myId || polling) return;
  polling = true;

  try {
    const result = await brokerFetch<PollMessagesResponse>("/fetch-messages", { id: myId });
    const unreadIds = new Set(result.messages.map((m) => m.id));
    pushedIds = new Set([...pushedIds].filter((id) => unreadIds.has(id)));

    for (const msg of result.messages) {
      if (pushedIds.has(msg.id)) continue;
      pushedIds.add(msg.id);
      // Look up the sender's info for context
      let fromSummary = "";
      let fromCwd = "";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          cwd: myCwd,
          git_root: myGitRoot,
        });
        const sender = peers.find((p) => p.id === msg.from_id);
        if (sender) {
          fromSummary = sender.summary;
          fromCwd = sender.cwd;
        }
      } catch {
        // Non-critical, proceed without sender info
      }

      // Push as channel notification — this is what makes it immediate
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.text,
          meta: {
            from_id: msg.from_id,
            from_summary: fromSummary,
            from_cwd: fromCwd,
            sent_at: msg.sent_at,
          },
        },
      });

      log(`Pushed message from ${msg.from_id}: ${msg.text.slice(0, 80)}`);
    }
  } catch (e) {
    // Broker might be down temporarily, don't crash
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    polling = false;
  }
}

// --- Startup ---

async function main() {
  // 1. Ensure broker is running
  await ensureBroker();

  // 2. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  log(`Client type: ${CLIENT_TYPE}`);
  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);

  // 3. Register with broker (no auto-summary — use set_summary tool manually)
  const registration: RegisterRequest = {
    pid: process.pid,
    agent_pid: process.ppid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    client_type: CLIENT_TYPE,
    summary: "",
  };
  if (INBOX_SOCKET) {
    registration.wake_transport = "claude_inbox";
    registration.wake_address = INBOX_SOCKET;
    registration.wake_secret = INBOX_TOKEN;
  }
  const reg = await brokerFetch<RegisterResponse>("/register", registration);
  myId = reg.id;
  log(`Registered as peer ${myId} (wake: ${INBOX_SOCKET ? "claude_inbox" : "none until a hook sets one"})`);

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log(`MCP connected (client_type: ${CLIENT_TYPE})`);

  // 6. Start polling for inbound messages (only for clients that support push)
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let orphanTimer: ReturnType<typeof setInterval> | null = null;
  if (CLIENT_TYPE === "claude-code" && !INBOX_SOCKET) {
    pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);
  } else {
    log("Channel push disabled — the broker wakes this peer natively or it uses check_messages");
  }

  // 7. Start heartbeat
  const heartbeatTimer = setInterval(async () => {
    if (myId) {
      try {
        await brokerFetch("/heartbeat", { id: myId });
      } catch {
        // Non-critical
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 8. Clean up on exit
  let cleanupCalled = false;
  const cleanup = async () => {
    if (cleanupCalled) return;
    cleanupCalled = true;
    if (pollTimer) clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    if (orphanTimer) clearInterval(orphanTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    try { await mcp.close(); } catch {}
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // 9. Detect parent death — stdin close (primary) + PPID check (fallback)
  process.stdin.on("end", () => {
    log("stdin closed (parent exited), shutting down");
    cleanup();
  });
  process.stdin.on("close", () => {
    log("stdin closed (parent exited), shutting down");
    cleanup();
  });

  const startupPpid = process.ppid;
  orphanTimer = setInterval(() => {
    if (process.ppid !== startupPpid || process.ppid === 1) {
      log("Parent process exited (orphan detected), shutting down");
      cleanup();
    }
  }, 30_000);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
