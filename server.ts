#!/usr/bin/env bun
/**
 * claude-peers MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for peer discovery and messaging.
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:claude-peers
 *
 * With .mcp.json:
 *   { "claude-peers": { "command": "bun", "args": ["./server.ts"] } }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  RegisterResponse,
  PollMessagesResponse,
  Message,
} from "./shared/types.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./shared/summarize.ts";

// --- Configuration ---

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;
const PEER_NAME = process.env.CLAUDE_PEERS_NAME ?? "";

// Detect if running inside Claude Desktop (launched via disclaimer wrapper)
function detectPeerType(): "cli" | "desktop" {
  try {
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-p", String(ppid), "-o", "command="]);
      const cmd = new TextDecoder().decode(proc.stdout).trim();
      if (cmd.includes("Claude.app") || cmd.includes("disclaimer")) {
        return "desktop";
      }
    }
  } catch { /* default to cli */ }
  return "cli";
}
const PEER_TYPE = detectPeerType();

// --- Broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
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

  log("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
    // Detach so the broker survives if this MCP server exits
    // On macOS/Linux, the broker will keep running
  });

  // Unref so this process can exit without waiting for the broker
  proc.unref();

  // Wait for it to come up
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// --- Utility ---

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging (stdout is the MCP protocol)
  console.error(`[claude-peers] ${msg}`);
}

async function ensureRegistered(): Promise<void> {
  // Re-register if our peer was cleaned up by the broker
  if (!myId) return;
  try {
    const peers = await brokerFetch<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: myCwd,
      git_root: myGitRoot,
    });
    if (!peers.some((p) => p.id === myId)) {
      const tty = getTty();
      const reg = await brokerFetch<RegisterResponse>("/register", {
        pid: process.pid,
        cwd: myCwd,
        git_root: myGitRoot,
        tty,
        summary: myLastSummary || PEER_NAME,
        peer_type: PEER_TYPE,
      });
      log(`Re-registered as peer ${reg.id} (was ${myId})`);
      myId = reg.id;
    }
  } catch {
    // Non-critical
  }
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
let myLastSummary: string = ""; // Track the most recent summary for re-registration
let hasSamplingSupport = false; // Whether the client supports sampling (createMessage)

// For desktop (Cowork), multiple sessions share this server process.
// Each session registers as a separate peer, keyed by session_id.
const desktopPeers = new Map<string, { peerId: PeerId; summary: string }>();

async function getDesktopPeerId(sessionId: string): Promise<PeerId> {
  const existing = desktopPeers.get(sessionId);
  if (existing) return existing.peerId;

  // Register a new peer for this desktop session
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: sessionId, // Use session sandbox path as CWD — distinguishes sessions
    git_root: null,
    tty: null,
    summary: "",
    peer_type: "desktop",
  });
  desktopPeers.set(sessionId, { peerId: reg.id, summary: "" });
  return reg.id;
}

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
      logging: {},
    },
    instructions: `You are connected to the claude-peers network. Other Claude Code instances on this machine can see you and send you messages.

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_summary, and from_cwd attributes to understand who sent the message. Reply by calling send_message with their from_id.

Available tools:
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo). Shows YOUR peer ID and all other peers with their IDs and summaries.
- send_message: Send a message to another instance by peer ID
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- check_messages: Manually check for new messages (call this periodically if you're expecting replies)

CRITICAL FIRST STEPS — do these immediately when you start:
1. Call set_summary with your role/name and what you're working on (e.g. "Design agent. Reviewing clinician UX mockups.")
2. Call list_peers with scope "machine" to see who else is online and learn your own peer ID.

Use summaries to identify peers — peer IDs change on restart, but summaries tell you who's who.

MESSAGING ROUTING — each peer has a Type (cli or desktop) shown in list_peers:
- To message a "cli" peer: use send_message (they receive it instantly via channel push)
- To message a "desktop" peer: use send_message (they receive it on their next tool call). If you are ALSO a desktop session and have access to dispatch:send_message, prefer that — it wakes idle sessions immediately.
- To message another desktop session from desktop: use dispatch:send_message with their session ID (from session_info:list_sessions) for instant delivery.` +
      (PEER_NAME ? `\n\nYour assigned identity is: "${PEER_NAME}". Always include this name when setting your summary. This is who you are on the network — do not adopt a different identity even if other peers' summaries seem to conflict.` : ""),
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances running on this machine. Returns their ID, working directory, git repo, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all instances on this computer. "directory" = same working directory. "repo" = same git repository (including worktrees or subdirectories).',
        },
        session_id: {
          type: "string" as const,
          description:
            "Optional. Cowork session identifier (sandbox CWD). Desktop sessions pass this to maintain independent peer identities.",
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer ID. The message will be pushed into their session immediately via channel notification.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID of the target Claude Code instance (from list_peers)",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
        session_id: {
          type: "string" as const,
          description:
            "Optional. Cowork session identifier (sandbox CWD). Desktop sessions pass this to maintain independent peer identities.",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other Claude Code instances when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
        session_id: {
          type: "string" as const,
          description:
            "Optional. Cowork session identifier (sandbox CWD). Desktop sessions pass this to maintain independent peer identities.",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Manually check for new messages from other Claude Code instances. Messages are normally pushed automatically via channel notifications, but you can use this as a fallback.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: {
          type: "string" as const,
          description:
            "Optional. Cowork session identifier (sandbox CWD). Desktop sessions pass this to maintain independent peer identities.",
        },
      },
    },
  },
];

// --- Tool handlers ---

// Track pending message previews for dynamic tool descriptions
let pendingMessagePreview = "";

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  if (!pendingMessagePreview) return { tools: TOOLS };

  // Inject message preview into check_messages description
  const dynamicTools = TOOLS.map((t) => {
    if (t.name === "check_messages") {
      return {
        ...t,
        description: `⚠️ NEW MESSAGES WAITING — CALL THIS TOOL NOW.\n\nPreview: ${pendingMessagePreview}\n\n${t.description}`,
      };
    }
    return t;
  });
  return { tools: dynamicTools };
});

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  log(`Tool call raw request: ${JSON.stringify(req.params)}`);
  const { name, arguments: args } = req.params;
  const sessionId = args?.session_id as string | undefined;
  const effectivePeerId =
    sessionId && PEER_TYPE === "desktop"
      ? await getDesktopPeerId(sessionId)
      : myId;
  const toolResult = await handleTool(name, args, effectivePeerId, sessionId);
  return appendPendingMessages(toolResult, name, effectivePeerId);
});

async function handleTool(name: string, args: Record<string, unknown> | undefined, effectivePeerId: PeerId | null, sessionId: string | undefined): Promise<any> {
  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: effectivePeerId,
        });

        const header = `Your peer ID: ${effectivePeerId}\n\n`;

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${header}No other Claude Code instances found (scope: ${scope}).`,
              },
            ],
          };
        }

        const lines = peers.map((p) => {
          const parts = [
            `ID: ${p.id}`,
            `Type: ${p.peer_type ?? "cli"}`,
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
              text: `${header}Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`,
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
      if (!to_id) {
        return {
          content: [{ type: "text" as const, text: "Missing to_id. Call list_peers first to get peer IDs, then pass the ID as to_id." }],
          isError: true,
        };
      }
      if (!effectivePeerId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_id: effectivePeerId,
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
      if (!effectivePeerId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { id: effectivePeerId, summary });
        // Update the right summary store
        if (sessionId && PEER_TYPE === "desktop") {
          const entry = desktopPeers.get(sessionId);
          if (entry) entry.summary = summary;
        } else {
          myLastSummary = summary;
        }
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}" (your peer ID: ${effectivePeerId})` }],
        };
      } catch (e) {
        // If peer was cleaned up, re-register
        const errMsg = e instanceof Error ? e.message : String(e);
        if (errMsg.includes("not found")) {
          try {
            if (sessionId && PEER_TYPE === "desktop") {
              // Re-register with summary in one call (avoids extra /set-summary round-trip)
              desktopPeers.delete(sessionId);
              const reg = await brokerFetch<RegisterResponse>("/register", {
                pid: process.pid,
                cwd: sessionId,
                git_root: null,
                tty: null,
                summary,
                peer_type: "desktop",
              });
              desktopPeers.set(sessionId, { peerId: reg.id, summary });
              log(`Re-registered desktop session ${sessionId} as peer ${reg.id}`);
              return {
                content: [{ type: "text" as const, text: `Re-registered and summary set: "${summary}" (new peer ID: ${reg.id})` }],
              };
            } else {
              const tty = getTty();
              const reg = await brokerFetch<RegisterResponse>("/register", {
                pid: process.pid,
                cwd: myCwd,
                git_root: myGitRoot,
                tty,
                summary,
              });
              myId = reg.id;
              myLastSummary = summary;
              log(`Re-registered as peer ${myId} after stale cleanup`);
              return {
                content: [{ type: "text" as const, text: `Re-registered and summary set: "${summary}" (new peer ID: ${myId})` }],
              };
            }
          } catch (regErr) {
            // fall through to error
          }
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${errMsg}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!effectivePeerId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: effectivePeerId });
        if (result.messages.length > 0) {
          await ackMessages(result.messages);
        }
        if (pendingMessagePreview) {
          pendingMessagePreview = "";
          try {
            await mcp.notification({ method: "notifications/tools/list_changed" });
          } catch { /* non-critical */ }
        }
        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }
        const lines = result.messages.map(
          (m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`
        );
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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- Piggyback message delivery on every tool call ---
// Appends pending messages to any tool response so Desktop sessions
// get messages opportunistically without calling check_messages.

async function appendPendingMessages(result: { content: { type: string; text: string }[] }, toolName: string, effectivePeerId: PeerId | null) {
  if (!effectivePeerId || toolName === "check_messages" || !pendingMessagePreview) return result;
  try {
    const pending = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: effectivePeerId });
    if (pending.messages.length > 0) {
      await ackMessages(pending.messages);
      const inbox = pending.messages
        .map((m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`)
        .join("\n\n---\n\n");
      result.content.push({
        type: "text" as const,
        text: `\n\n📨 ${pending.messages.length} new message(s) arrived:\n\n${inbox}`,
      });
    }
  } catch {
    // Non-critical
  }
  return result;
}

// --- Message ack helper ---

let lastSeenMessageId = 0;
// Track message IDs already pushed via channel to avoid re-pushing every poll cycle.
// Messages are NOT acked by the poll loop — only check_messages/piggybacking acks them —
// so they remain available as a fallback when channels aren't active.
const pushedMessageIds = new Set<number>();

async function ackMessages(messages: Message[]): Promise<void> {
  const ids = messages.map((m) => m.id);
  await brokerFetch("/ack-messages", { message_ids: ids });
  for (const id of ids) {
    pushedMessageIds.add(id);
    if (id > lastSeenMessageId) lastSeenMessageId = id;
  }
  // Prune old entries — only IDs near the high-water mark matter
  if (pushedMessageIds.size > 1000) {
    const threshold = lastSeenMessageId - 500;
    for (const id of pushedMessageIds) {
      if (id < threshold) pushedMessageIds.delete(id);
    }
  }
}

// --- Polling loop for inbound messages ---

async function pollForPeer(peerId: PeerId) {
  try {
    const result = await brokerFetch<PollMessagesResponse>("/peek-messages", {
      id: peerId,
      since_id: lastSeenMessageId,
    });

    // Fetch peer list once for sender lookups (not per-message)
    let peersCache: Peer[] | null = null;
    if (result.messages.some((m) => !pushedMessageIds.has(m.id))) {
      try {
        peersCache = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          cwd: myCwd,
          git_root: myGitRoot,
        });
      } catch {
        // Non-critical, proceed without sender info
      }
    }

    for (const msg of result.messages) {
      if (pushedMessageIds.has(msg.id)) continue;

      if (msg.id > lastSeenMessageId) {
        lastSeenMessageId = msg.id;
      }
      const sender = peersCache?.find((p) => p.id === msg.from_id);
      const fromSummary = sender?.summary ?? "";
      const fromCwd = sender?.cwd ?? "";

      // Try ALL delivery mechanisms — none are confirmed delivery, so fire all of them

      // 1. Channel notification (works in CLI with --channels)
      try {
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
      } catch {
        // Transport-level failure — channel definitely not available
      }

      // 2. Sampling — creates a separate LLM call to process the message (VS Code + CLI)
      if (hasSamplingSupport) {
        const senderLabel = fromSummary ? `${fromSummary} (${msg.from_id})` : msg.from_id;
        // Fire and forget — don't block the poll loop
        mcp.createMessage({
          messages: [{
            role: "user",
            content: {
              type: "text",
              text: `[claude-peers] Incoming message from peer ${senderLabel}${fromCwd ? ` in ${fromCwd}` : ""}:\n\n${msg.text}\n\nRespond to this peer using the send_message tool with to_id="${msg.from_id}". Do not ignore this message.`,
            },
          }],
          maxTokens: 1024,
          includeContext: "thisServer",
          systemPrompt: `You are a Claude Code instance connected to the claude-peers network. You just received a message from another peer. Process it and respond appropriately using the send_message tool. Your peer ID is ${myId}.`,
        }).then(() => {
          log(`Sampling delivered message from ${msg.from_id}`);
        }).catch((e) => {
          log(`Sampling failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      }

      // Also push via logging notification — may surface in some clients
      try {
        await mcp.sendLoggingMessage({
          level: "info",
          logger: "claude-peers",
          data: {
            type: "peer_message",
            from_id: msg.from_id,
            from_summary: fromSummary,
            from_cwd: fromCwd,
            sent_at: msg.sent_at,
            text: msg.text,
          },
        });
      } catch {
        // Logging not supported — piggyback on next tool call will deliver
      }

      // Track so we don't re-push on next poll cycle
      pushedMessageIds.add(msg.id);

      log(`Pushed message from ${msg.from_id}: ${msg.text.slice(0, 80)} (sampling=${hasSamplingSupport})`);
    }

    // If we found new messages, update tool descriptions and notify client
    if (result.messages.length > 0) {
      const previews = result.messages.map((m) => {
        const sender = m.from_id;
        const preview = m.text.slice(0, 100);
        return `[${sender}]: ${preview}`;
      });
      pendingMessagePreview = previews.join(" | ");

      // Tell client to re-fetch tool list — they'll see the message in check_messages description
      try {
        await mcp.notification({
          method: "notifications/tools/list_changed",
        });
        log("Sent tools/list_changed notification");
      } catch {
        // Client doesn't support it
      }
    }
  } catch (e) {
    // Broker might be down temporarily, don't crash
    log(`Poll error (${peerId}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function pollAndPushMessages() {
  const peerIds: PeerId[] = [];
  if (myId) peerIds.push(myId);
  for (const [_, entry] of desktopPeers) peerIds.push(entry.peerId);
  await Promise.all(peerIds.map(pollForPeer));
}

// --- Startup ---

async function main() {
  // 1. Ensure broker is running
  await ensureBroker();

  // 2. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);

  // 3. Generate initial summary via gpt-5.4-nano (non-blocking, best-effort)
  // CLAUDE_PEERS_NAME takes priority — it's the fixed identity for this session.
  let initialSummary = PEER_NAME;
  if (PEER_NAME) {
    log(`Fixed identity: ${PEER_NAME}`);
  }
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({
        cwd: myCwd,
        git_root: myGitRoot,
        git_branch: branch,
        recent_files: recentFiles,
      });
      if (summary && !PEER_NAME) {
        initialSummary = summary;
        log(`Auto-summary: ${summary}`);
      }
    } catch (e) {
      log(`Auto-summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  // Wait briefly for summary, but don't block startup
  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);

  // 4. Register with broker
  log(`Peer type: ${PEER_TYPE}`);
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
    peer_type: PEER_TYPE,
  });
  myId = reg.id;
  log(`Registered as peer ${myId}`);

  // If broker restored a cached summary from a previous session, use it
  if (reg.restored_summary) {
    myLastSummary = reg.restored_summary;
    initialSummary = reg.restored_summary;
    log(`Restored summary from previous session: "${reg.restored_summary}"`);
  } else if (initialSummary) {
    myLastSummary = initialSummary;
  }

  // If summary generation is still running, update it when done
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId) {
        try {
          await brokerFetch("/set-summary", { id: myId, summary: initialSummary });
          myLastSummary = initialSummary;
          log(`Late auto-summary applied: ${initialSummary}`);
        } catch {
          // Non-critical
        }
      }
    });
  }

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 5b. Detect client capabilities for message delivery
  try {
    const caps = mcp.getClientCapabilities();
    hasSamplingSupport = !!caps?.sampling;
    log(`Client capabilities: sampling=${hasSamplingSupport}`);
  } catch {
    log("Could not read client capabilities");
  }

  // 6. Start polling for inbound messages
  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);

  // 7. Start heartbeat (also re-registers if peer was cleaned up)
  const heartbeatTimer = setInterval(async () => {
    const beats: Promise<void>[] = [];
    if (myId) {
      beats.push(
        ensureRegistered()
          .then(() => brokerFetch("/heartbeat", { id: myId }))
          .then(() => {})
          .catch(() => {})
      );
    }
    for (const [_, entry] of desktopPeers) {
      beats.push(
        brokerFetch("/heartbeat", { id: entry.peerId })
          .then(() => {})
          .catch(() => {})
      );
    }
    await Promise.all(beats);
  }, HEARTBEAT_INTERVAL_MS);

  // 8. Clean up on exit
  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    // Unregister all desktop session peers
    for (const [sessionId, entry] of desktopPeers) {
      try {
        await brokerFetch("/unregister", { id: entry.peerId });
        log(`Unregistered desktop session ${sessionId}`);
      } catch {
        // Best effort
      }
    }
    desktopPeers.clear();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
