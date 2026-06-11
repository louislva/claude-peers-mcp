/**
 * claude-peers opencode plugin
 *
 * opencode cannot receive MCP channel notifications (a Claude Code-only
 * protocol), so without this plugin an opencode session can send peer
 * messages but never sees inbound ones. This plugin closes the gap: it polls
 * the broker for messages addressed to this session's peer and injects them
 * into the active opencode session via the server API (`session.prompt_async`),
 * queueing while the agent is mid-turn and flushing on `session.idle`.
 *
 * The peer identity is the one registered by the claude-peers MCP server
 * (server.ts), which opencode spawns as a descendant process — the plugin
 * finds it by matching broker-registered PIDs against its own process tree.
 *
 * Install (in addition to the MCP server entry in opencode.jsonc):
 *   mkdir -p ~/.config/opencode/plugins
 *   ln -s ~/claude-peers-mcp/opencode-plugin.ts ~/.config/opencode/plugins/claude-peers.ts
 *
 * NOTE: this file must keep a single default export — opencode treats every
 * export of a plugin file as a plugin. Helpers live in shared/opencode.ts.
 */

import type { Plugin } from "@opencode-ai/plugin";
import type { Message, Peer, PeerId, PollMessagesResponse } from "./shared/types.ts";
import { descendantPids, formatChannelMessage, parsePsOutput } from "./shared/opencode.ts";

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;

function log(msg: string) {
  console.error(`[claude-peers plugin] ${msg}`);
}

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`Broker error (${path}): ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

async function listPeers(cwd: string): Promise<Peer[]> {
  return brokerFetch<Peer[]>("/list-peers", { scope: "machine", cwd, git_root: null });
}

/**
 * Find the broker peer registered by the claude-peers MCP server that this
 * opencode process spawned (it registers with its own PID, and is a
 * descendant of ours).
 */
async function findMyPeerId(cwd: string): Promise<PeerId | null> {
  const ps = Bun.spawnSync(["ps", "-eo", "pid=,ppid=,args="]);
  const descendants = descendantPids(parsePsOutput(ps.stdout.toString()), process.pid);
  const peers = await listPeers(cwd);
  return peers.find((p) => descendants.has(p.pid))?.id ?? null;
}

const ClaudePeersPlugin: Plugin = async ({ client, directory }) => {
  let peerId: PeerId | null = null;
  let lastSessionID: string | null = null;
  let pending: string[] = [];
  let loggedBrokerDown = false;

  async function activeSessionID(): Promise<string | null> {
    if (lastSessionID) return lastSessionID;
    const res = await client.session.list();
    const sessions = res.data ?? [];
    if (sessions.length === 0) return null;
    sessions.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
    return sessions[0]!.id;
  }

  async function isBusy(sessionID: string): Promise<boolean> {
    try {
      const res = await client.session.status();
      const status = res.data?.[sessionID];
      return status !== undefined && status.type !== "idle";
    } catch {
      return false;
    }
  }

  async function prompt(sessionID: string, text: string) {
    await client.session.promptAsync({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text }] },
    });
  }

  /** Deliver now if the session is idle, otherwise hold until session.idle. */
  async function deliver(text: string) {
    const sessionID = await activeSessionID();
    if (!sessionID || (await isBusy(sessionID))) {
      pending.push(text);
      return;
    }
    await prompt(sessionID, text);
  }

  async function flushPending(sessionID: string) {
    if (pending.length === 0) return;
    const batch = pending.splice(0).join("\n\n");
    await prompt(sessionID, batch);
  }

  async function tick() {
    try {
      if (!peerId) {
        peerId = await findMyPeerId(directory);
        if (!peerId) return; // MCP server not registered yet; retry next tick
        log(`Delivering inbound messages for peer ${peerId}`);
      }
      const { messages } = await brokerFetch<PollMessagesResponse>("/poll-messages", {
        id: peerId,
      });
      if (messages.length === 0) return;

      let peers: Peer[] = [];
      try {
        peers = await listPeers(directory);
      } catch {
        // Sender context is optional
      }
      for (const msg of messages as Message[]) {
        const sender = peers.find((p) => p.id === msg.from_id);
        await deliver(formatChannelMessage(msg, sender));
        log(`Delivered message from ${msg.from_id}: ${msg.text.slice(0, 80)}`);
      }
      loggedBrokerDown = false;
    } catch (e) {
      if (!loggedBrokerDown) {
        log(`Broker unreachable, will keep retrying: ${e instanceof Error ? e.message : e}`);
        loggedBrokerDown = true;
      }
      peerId = null; // re-resolve in case the MCP server re-registered
    }
  }

  setInterval(tick, POLL_INTERVAL_MS);
  log(`Watching broker at ${BROKER_URL} (dir: ${directory})`);

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        lastSessionID = event.properties.sessionID;
        await flushPending(event.properties.sessionID);
      }
    },
  };
};

export default { id: "claude-peers", server: ClaudePeersPlugin };
