#!/usr/bin/env bun
/**
 * claude-peers MCP server (v0.3)
 *
 * Runs on the broker host (loopback to broker.ts). Spawned by client.ts via
 * SSH stdio, or directly by Claude Code in legacy local-only mode.
 *
 * Reads a single JSON handshake line on stdin BEFORE switching to the MCP
 * stdio transport. The handshake carries the client's local context plus
 * the resolved group identity (group_id, group_secret_hash, groups_map).
 *
 * Connects to the broker via WebSocket (loopback) for push delivery, with a
 * polling fallback for resilience. SIGINT/SIGTERM transitions the peer to
 * 'dormant' via /disconnect (resume-able), instead of /unregister (DELETE).
 */

import { PassThrough } from "node:stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { hostname } from "node:os";
import type {
  Peer,
  RegisterResponse,
  PollMessagesResponse,
  ClientMeta,
  GroupId,
  GroupStatsResponse,
  PeerId,
  InstanceToken,
  WhoamiResponse,
  ListGroupsResponse,
  SetIdResponse,
} from "./shared/types.ts";
import {
  generateSummary,
  heuristicSummary,
  getGitBranch,
  getRecentFiles,
  computeProjectKey,
} from "./shared/summarize.ts";
import {
  loadConfig,
  brokerUrl,
  resolveProvider,
  resolveGroup,
  computeGroupId,
  computeGroupSecretHash,
} from "./shared/config.ts";

const PEER_ID_REGEX = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

// --- Configuration ---

const config = await loadConfig();
const BROKER_URL = brokerUrl(config);
const POLL_INTERVAL_MS = 30_000; // fallback only; WS push is the primary path
const POLL_INTERVAL_DISCONNECTED_MS = 5_000; // tighter polling while WS is down
const HEARTBEAT_INTERVAL_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 2000;
const WS_RECONNECT_INITIAL_MS = 1000;
const WS_RECONNECT_MAX_MS = 30_000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

// --- Broker HTTP communication ---

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

async function brokerGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`);
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
  });
  proc.unref();

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
    if (code === 0) return text.trim();
  } catch {
    // not a git repo
  }
  return null;
}

// --- Handshake ---

function readHandshake(): Promise<{
  meta: ClientMeta | null;
  stream: PassThrough;
}> {
  const stream = new PassThrough();
  let resolved = false;
  let buffer: Buffer = Buffer.alloc(0);

  return new Promise((resolve) => {
    const stdin = process.stdin;

    const finalize = (meta: ClientMeta | null, leftover: Buffer) => {
      if (resolved) return;
      resolved = true;
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      clearTimeout(timer);
      if (leftover.length > 0) {
        stream.write(leftover);
      }
      stdin.on("data", (chunk: Buffer) => stream.write(chunk));
      stdin.on("end", () => stream.end());
      resolve({ meta, stream });
    };

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const nl = buffer.indexOf(0x0a);
      if (nl === -1) return;
      const line = buffer.subarray(0, nl).toString("utf-8");
      const rest = buffer.subarray(nl + 1);
      try {
        const parsed = JSON.parse(line) as { client_meta?: ClientMeta };
        if (parsed && parsed.client_meta) {
          finalize(parsed.client_meta, rest);
          return;
        }
      } catch {
        // Not a handshake line: this is already MCP traffic.
      }
      finalize(null, buffer);
    };

    const onEnd = () => finalize(null, buffer);
    const timer = setTimeout(() => finalize(null, buffer), HANDSHAKE_TIMEOUT_MS);

    stdin.on("data", onData);
    stdin.on("end", onEnd);
  });
}

// --- State (v0.3 dual identity) ---

let myInstanceToken: InstanceToken | null = null;
let myPeerId: PeerId | null = null;
let myGroupId: GroupId = "default";
let myGroupsMap: Record<string, GroupId> = { default: "default" };
let myCwd = process.cwd();
let myGitRoot: string | null = null;
let myProjectKey: string | null = null;
let myHost: string = hostname();
let myClientPid: number = process.pid;
let myRegisteredAt: string = "";
let wsConnected: boolean = false;
let wsSocket: WebSocket | null = null;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsReconnectDelay: number = WS_RECONNECT_INITIAL_MS;

function groupNameForId(id: GroupId): string {
  for (const [name, gid] of Object.entries(myGroupsMap)) {
    if (gid === id) return name;
  }
  return id === "default" ? "default" : "<unknown>";
}

// --- WebSocket transport ---

function scheduleWsReconnect() {
  if (wsReconnectTimer) return;
  const delay = Math.min(wsReconnectDelay, WS_RECONNECT_MAX_MS);
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_RECONNECT_MAX_MS);
    connectWs();
  }, delay);
}

function clearWsReconnect() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  wsReconnectDelay = WS_RECONNECT_INITIAL_MS;
}

function connectWs() {
  if (!myInstanceToken) return;
  // Close any existing socket cleanly before opening a new one.
  if (wsSocket && wsSocket.readyState !== WebSocket.CLOSED) {
    try { wsSocket.close(); } catch { /* ignore */ }
  }
  const wsUrl = BROKER_URL.replace(/^http/, "ws") + "/ws";
  const ws = new WebSocket(wsUrl);
  wsSocket = ws;

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "auth", instance_token: myInstanceToken }));
    wsConnected = true;
    clearWsReconnect();
    log("WebSocket connected");
  });

  ws.addEventListener("message", async (ev) => {
    let frame: { type: string; [k: string]: unknown };
    try {
      frame = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
    } catch {
      return;
    }
    if (frame.type === "message") {
      const f = frame as {
        type: "message";
        id: number;
        from_peer_id: string;
        from_summary: string;
        from_host: string;
        from_cwd: string;
        text: string;
        sent_at: string;
      };
      try {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: f.text,
            meta: {
              from_peer_id: f.from_peer_id,
              from_summary: f.from_summary,
              from_cwd: f.from_cwd,
              from_host: f.from_host,
              sent_at: f.sent_at,
            },
          },
        });
        log(`Pushed message from ${f.from_peer_id}: ${f.text.slice(0, 80)}`);
      } catch (e) {
        log(`Notification dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });

  ws.addEventListener("close", () => {
    wsConnected = false;
    wsSocket = null;
    log("WebSocket closed; will retry");
    scheduleWsReconnect();
  });

  ws.addEventListener("error", () => {
    // 'close' will fire too -- log here just for visibility
    wsConnected = false;
  });
}

// --- MCP server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.3.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-peers network. Other Claude Code instances on this machine and on other PCs sharing the same broker can see you and send you messages, scoped to your current group.

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message with the from_peer_id, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder -- answer right away, even if you're in the middle of something.

Available tools:
- list_peers: Discover other Claude Code instances in your group (scope: machine/directory/repo).
- send_message: Send a message to another instance by peer_id.
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers in your group).
- check_messages: Manually check for new messages (polling fallback; messages normally arrive via WebSocket push).
- whoami: Show your current peer_id, group, host, cwd, and WebSocket status.
- list_groups: Show available groups defined in user config and how many active peers each has.
- switch_group: Move this session to another group (disconnect + re-register).
- set_id: Rename your peer_id within the current group (display name only; routing is unchanged).

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances connected to the same broker, in your current group. Returns peer_id, host, working directory, git repo, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all peers in your group on the broker. "directory" = same working directory. "repo" = same git repository (matched cross-PC via the normalized git remote URL).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer_id. The message is pushed via WebSocket if the recipient is connected, otherwise queued for their next poll.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_peer_id: {
          type: "string" as const,
          description: "The peer_id of the target Claude Code instance (from list_peers). Must be in your current group.",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to_peer_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. Visible to other peers in your group.",
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
      "Manually poll for new messages. Messages normally arrive automatically via WebSocket; use this if you suspect the push channel is down.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "whoami",
    description:
      "Return your current peer_id, host, cwd, group_name, summary, and WebSocket connectivity status.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "list_groups",
    description:
      "List groups available in user config and how many active peers each has. Includes the current group.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "switch_group",
    description:
      "Move this session to another group by name. Disconnects the current peer (kept as dormant for resume) and re-registers in the target group.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string" as const,
          description: "The group name as defined in user config (or 'default').",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "set_id",
    description:
      "Rename your peer_id within the current group. Refused with 409 if the name is already taken by another peer (active or dormant) in your group.",
    inputSchema: {
      type: "object" as const,
      properties: {
        new_id: {
          type: "string" as const,
          description: "Your new peer_id. Must match ^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$",
        },
      },
      required: ["new_id"],
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

function formatPeer(p: Peer): string {
  const idLine = p.host && p.client_pid
    ? `peer_id: ${p.peer_id}  (${p.host} - PID: ${p.client_pid})`
    : `peer_id: ${p.peer_id}`;
  const parts = [idLine, `CWD: ${p.cwd}`];
  if (p.git_root) parts.push(`Repo: ${p.git_root}`);
  if (p.project_key) parts.push(`Project: ${p.project_key}`);
  if (p.tty) parts.push(`TTY: ${p.tty}`);
  if (p.summary) parts.push(`Summary: ${p.summary}`);
  parts.push(`Last seen: ${p.last_seen}`);
  return parts.join("\n  ");
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo";
      if (!myInstanceToken) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          instance_token: myInstanceToken,
          cwd: myCwd,
          git_root: myGitRoot,
          project_key: myProjectKey,
        });

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other Claude Code instances found in group '${groupNameForId(myGroupId)}' (scope: ${scope}).`,
              },
            ],
          };
        }

        const lines = peers.map(formatPeer);
        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) in group '${groupNameForId(myGroupId)}' (scope: ${scope}):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "send_message": {
      // Accept both new (to_peer_id) and legacy (to_id) for robustness.
      const a = args as { to_peer_id?: string; to_id?: string; message: string };
      const target = a.to_peer_id ?? a.to_id;
      if (!target) {
        return {
          content: [{ type: "text" as const, text: "Missing 'to_peer_id'" }],
          isError: true,
        };
      }
      if (!myInstanceToken) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_token: myInstanceToken,
          to_peer_id: target,
          text: a.message,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Message sent to peer '${target}'` }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error sending message: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myInstanceToken) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { instance_token: myInstanceToken, summary });
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!myInstanceToken) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", {
          instance_token: myInstanceToken,
        });
        if (result.messages.length === 0) {
          return { content: [{ type: "text" as const, text: "No new messages." }] };
        }
        // Resolve from_token -> from_peer_id by listing peers in the group.
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          instance_token: myInstanceToken,
          cwd: myCwd,
          git_root: myGitRoot,
          project_key: myProjectKey,
        });
        const tokenToId = new Map(peers.map((p) => [p.instance_token, p.peer_id]));
        const lines = result.messages.map((m) => {
          const peerId = tokenToId.get(m.from_token) ?? "<dormant peer>";
          return `From ${peerId} (${m.sent_at}):\n${m.text}`;
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
          content: [{ type: "text" as const, text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "whoami": {
      if (!myInstanceToken || !myPeerId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      // Pull current summary fresh from the broker via list_peers (own row not returned),
      // so fall back to a local cached summary or the latest set value. Simpler:
      // we rely on the latest applied set_summary or initial heuristic — reflected
      // by re-querying our own row via a lightweight self-lookup.
      let currentSummary = "";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          instance_token: myInstanceToken,
          cwd: myCwd,
          git_root: myGitRoot,
          project_key: myProjectKey,
        });
        // list_peers excludes self; for whoami we don't need others. Try a
        // best-effort: if the broker exposes the row through some other path we'd
        // use it; for now, summary is reported by /poll-messages context. Skip.
        void peers;
      } catch { /* non-fatal */ }
      const result: WhoamiResponse = {
        peer_id: myPeerId,
        host: myHost,
        client_pid: myClientPid,
        cwd: myCwd,
        git_root: myGitRoot,
        project_key: myProjectKey,
        group_name: groupNameForId(myGroupId),
        summary: currentSummary,
        registered_at: myRegisteredAt,
        ws_connected: wsConnected,
      };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    }

    case "list_groups": {
      try {
        const stats = await brokerGet<GroupStatsResponse>("/group-stats");
        const counts = new Map(stats.groups.map((g) => [g.group_id, g.active_peers]));
        const available = Object.keys(myGroupsMap).map((name) => ({
          name,
          active_peers: counts.get(myGroupsMap[name]!) ?? 0,
        }));
        const result: ListGroupsResponse = {
          current: groupNameForId(myGroupId),
          available,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error listing groups: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "switch_group": {
      const { name: targetName } = args as { name: string };
      if (!myInstanceToken) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      let secret: string | null;
      if (targetName === "default") {
        secret = null;
      } else {
        const candidate = config.groups[targetName];
        if (!candidate) {
          return {
            content: [{ type: "text" as const, text: `Group '${targetName}' not in user config` }],
            isError: true,
          };
        }
        secret = candidate;
      }
      const newGroupId = computeGroupId(secret);
      const newSecretHash = computeGroupSecretHash(secret);
      try {
        await brokerFetch("/disconnect", { instance_token: myInstanceToken });
        // Cancel any pending WS reconnect before switching identity.
        clearWsReconnect();
        if (wsSocket && wsSocket.readyState !== WebSocket.CLOSED) {
          try { wsSocket.close(); } catch { /* ignore */ }
        }
        const reg = await brokerFetch<RegisterResponse>("/register", {
          pid: process.pid,
          cwd: myCwd,
          git_root: myGitRoot,
          tty: null,
          summary: "",
          host: myHost,
          client_pid: myClientPid,
          project_key: myProjectKey,
          group_id: newGroupId,
          group_secret_hash: newSecretHash,
        });
        myInstanceToken = reg.instance_token;
        myPeerId = reg.peer_id;
        myGroupId = newGroupId;
        myRegisteredAt = new Date().toISOString();
        connectWs();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: true, new_peer_id: myPeerId, group_name: targetName }),
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error switching group: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "set_id": {
      const { new_id } = args as { new_id: string };
      if (!PEER_ID_REGEX.test(new_id)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Invalid peer_id (must match ^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$)",
            },
          ],
          isError: true,
        };
      }
      if (!myInstanceToken) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<SetIdResponse | { error: string }>("/set-id", {
          instance_token: myInstanceToken,
          new_peer_id: new_id,
        });
        if ("error" in result) {
          return {
            content: [{ type: "text" as const, text: result.error }],
            isError: true,
          };
        }
        myPeerId = result.peer_id;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error setting id: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Polling fallback ---

async function pollAndPushMessages() {
  if (!myInstanceToken) return;
  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", {
      instance_token: myInstanceToken,
    });
    if (result.messages.length === 0) return;

    let peers: Peer[] = [];
    try {
      peers = await brokerFetch<Peer[]>("/list-peers", {
        scope: "machine",
        instance_token: myInstanceToken,
        cwd: myCwd,
        git_root: myGitRoot,
        project_key: myProjectKey,
      });
    } catch { /* non-critical */ }
    const tokenInfo = new Map<string, { peer_id: string; summary: string; host: string; cwd: string }>(
      peers.map((p) => [p.instance_token, { peer_id: p.peer_id, summary: p.summary, host: p.host ?? "", cwd: p.cwd }])
    );

    for (const msg of result.messages) {
      const info = tokenInfo.get(msg.from_token);
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.text,
          meta: {
            from_peer_id: info?.peer_id ?? "<unknown>",
            from_summary: info?.summary ?? "",
            from_cwd: info?.cwd ?? "",
            from_host: info?.host ?? "",
            sent_at: msg.sent_at,
          },
        },
      });
      log(`Pushed (poll) message from ${info?.peer_id ?? msg.from_token}: ${msg.text.slice(0, 80)}`);
    }
  } catch (e) {
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Startup ---

async function main() {
  log("Awaiting client handshake on stdin...");
  const { meta, stream: stdinStream } = await readHandshake();

  let host: string;
  let clientPid: number;
  let tty: string | null;
  let gitBranch: string | null;
  let recentFiles: string[];
  let groupId: GroupId;
  let groupSecretHash: string | null;
  let groupsMap: Record<string, GroupId>;

  if (meta) {
    log(`Handshake received from host ${meta.host}, client_pid ${meta.client_pid}`);
    myCwd = meta.cwd;
    myGitRoot = meta.git_root;
    myProjectKey = meta.project_key;
    host = meta.host;
    clientPid = meta.client_pid;
    tty = meta.tty ?? null;
    gitBranch = meta.git_branch ?? null;
    recentFiles = meta.recent_files ?? [];
    groupId = meta.group_id ?? "default";
    groupSecretHash = meta.group_secret_hash ?? null;
    groupsMap = meta.groups_map ?? { default: "default" };
  } else {
    log("No handshake -- legacy mode, resolving group locally");
    myCwd = process.cwd();
    myGitRoot = await getGitRoot(myCwd);
    myProjectKey = await computeProjectKey(myCwd);
    host = hostname();
    clientPid = process.pid;
    tty = null;
    gitBranch = await getGitBranch(myCwd);
    recentFiles = await getRecentFiles(myCwd);
    const resolved = resolveGroup(myCwd, myGitRoot, config);
    groupId = resolved.group_id;
    groupSecretHash = resolved.group_secret_hash;
    groupsMap = resolved.groups_map;
    log(`Local group resolution: ${resolved.name} (id: ${groupId.slice(0, 8)})`);
  }

  myHost = host;
  myClientPid = clientPid;
  myGroupId = groupId;
  myGroupsMap = groupsMap;

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`Project key: ${myProjectKey ?? "(none)"}`);
  log(`Host: ${host}  client_pid: ${clientPid}`);
  log(`Group: ${groupNameForId(groupId)} (id: ${groupId.slice(0, 8)})`);

  await ensureBroker();

  const initialSummary = heuristicSummary({
    cwd: myCwd,
    git_root: myGitRoot,
    git_branch: gitBranch,
    recent_files: recentFiles,
  });
  log(`Heuristic summary: ${initialSummary}`);

  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
    host,
    client_pid: clientPid,
    project_key: myProjectKey,
    group_id: groupId,
    group_secret_hash: groupSecretHash,
  });
  myInstanceToken = reg.instance_token;
  myPeerId = reg.peer_id;
  myRegisteredAt = new Date().toISOString();
  log(`Registered as peer '${myPeerId}' (instance ${myInstanceToken.slice(0, 8)})`);

  // Background summary upgrade.
  (async () => {
    try {
      const provider = resolveProvider(config);
      const summary = await generateSummary(
        { cwd: myCwd, git_root: myGitRoot, git_branch: gitBranch, recent_files: recentFiles },
        {
          provider,
          api_key: config.summary_api_key ?? process.env.ANTHROPIC_API_KEY ?? null,
          model: config.summary_model,
          base_url: config.summary_base_url,
        }
      );
      log(`Summary provider: ${provider} (model: ${config.summary_model})`);
      if (summary && summary !== initialSummary && myInstanceToken) {
        await brokerFetch("/set-summary", { instance_token: myInstanceToken, summary });
        log(`Summary upgraded: ${summary}`);
      }
    } catch (e) {
      log(`Background summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  const transport = new StdioServerTransport(stdinStream as unknown as NodeJS.ReadableStream, process.stdout);
  await mcp.connect(transport);
  log("MCP connected");

  // Open WebSocket for push delivery.
  connectWs();

  // Polling fallback. Tighter cadence while WS is down.
  const pollTimer = setInterval(() => {
    if (!wsConnected) {
      // Fast cadence; the longer cadence below will also fire eventually.
    }
    void pollAndPushMessages();
  }, POLL_INTERVAL_DISCONNECTED_MS);
  const pollLongTimer = setInterval(() => {
    if (wsConnected) void pollAndPushMessages();
  }, POLL_INTERVAL_MS);

  const heartbeatTimer = setInterval(async () => {
    if (myInstanceToken) {
      try {
        await brokerFetch("/heartbeat", { instance_token: myInstanceToken });
      } catch { /* non-critical */ }
    }
  }, HEARTBEAT_INTERVAL_MS);

  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(pollLongTimer);
    clearInterval(heartbeatTimer);
    clearWsReconnect();
    if (wsSocket && wsSocket.readyState !== WebSocket.CLOSED) {
      try { wsSocket.close(); } catch { /* ignore */ }
    }
    if (myInstanceToken) {
      try {
        await brokerFetch("/disconnect", { instance_token: myInstanceToken });
        log("Disconnected (peer kept as dormant for resume)");
      } catch { /* best effort */ }
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
