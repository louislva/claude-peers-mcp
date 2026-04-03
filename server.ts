#!/usr/bin/env bun
/**
 * claude-peers MCP server
 *
 * Stdio MCP server spawned once per AI coding agent (Claude Code, Codex CLI).
 * Connects to the shared broker daemon for peer discovery and messaging.
 * Declares claude/channel capability (Claude Code only) for push notifications.
 * Codex and other clients rely on check_messages polling.
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
  RegisterResponse,
  PollMessagesResponse,
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

  if (CLIENT_TYPE === "claude-code") {
    return `${common}

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_summary, and from_cwd attributes to understand who sent the message. Reply by calling send_message with their from_id.`;
  }

  // Codex and other clients: no push notifications, must poll
  return `${common}

You do not receive push notifications for incoming messages. Call check_messages at the start of each turn and periodically during long tasks to see if any peer has messaged you. When you find messages, reply using send_message before continuing your work.

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
      "Send a message to another AI coding agent by peer ID. Claude Code peers receive it instantly via push; Codex peers see it on their next check_messages call.",
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
      "Check for new messages from other peers. Claude Code peers receive messages via push; Codex peers should call this at the start of each turn.",
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
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
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
          content: [{ type: "text" as const, text: `Message sent to peer ${to_id}` }],
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
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }

        // Enrich messages with sender context (same as push path)
        let peerMap = new Map<string, Peer>();
        try {
          const peers = await brokerFetch<Peer[]>("/list-peers", {
            scope: "machine",
            cwd: myCwd,
            git_root: myGitRoot,
          });
          for (const p of peers) peerMap.set(p.id, p);
        } catch {
          // Non-critical — proceed without enrichment
        }

        const lines = result.messages.map((m) => {
          const sender = peerMap.get(m.from_id);
          const header = sender
            ? `From ${m.from_id} [${sender.client_type ?? "claude-code"}] (${sender.summary || sender.cwd})`
            : `From ${m.from_id}`;
          return `${header} (${m.sent_at}):\n${m.text}`;
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
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

let polling = false;

async function pollAndPushMessages() {
  if (CLIENT_TYPE !== "claude-code") return;
  if (!myId || polling) return;
  polling = true;

  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

    for (const msg of result.messages) {
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
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    client_type: CLIENT_TYPE,
    summary: "",
  });
  myId = reg.id;
  log(`Registered as peer ${myId}`);

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log(`MCP connected (client_type: ${CLIENT_TYPE})`);

  // 6. Start polling for inbound messages (only for clients that support push)
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  if (CLIENT_TYPE === "claude-code") {
    pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);
  } else {
    log("Push notifications disabled — peer must use check_messages");
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
  const cleanup = async () => {
    if (pollTimer) clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
