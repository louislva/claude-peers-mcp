#!/usr/bin/env bun
/**
 * claude-peers CLI (v0.3)
 *
 * Utility commands for managing the broker and inspecting peers.
 *
 * Note: this CLI talks to the broker on 127.0.0.1:<port>. Run it on the host
 * where the broker lives. For a remote broker, use:
 *   ssh user@broker-host "cd /srv/claude-peers && bun cli.ts status"
 *
 * Usage:
 *   bun cli.ts status                   -- Show broker status and all peers
 *   bun cli.ts peers [--include-dormant]-- List all peers across groups
 *   bun cli.ts groups                   -- Show active peer counts per group
 *   bun cli.ts kill-broker              -- Stop the broker daemon (Linux/macOS only)
 *
 * Note: 'send' is intentionally absent in v0.3 -- use the MCP send_message tool
 * from inside Claude Code. The broker requires a valid instance_token for
 * routing, which only registered peers hold.
 */

import { loadConfig, brokerUrl } from "./shared/config.ts";
import type { Peer, GroupStatsResponse } from "./shared/types.ts";

const config = await loadConfig();
const BROKER_URL = brokerUrl(config);

async function brokerGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

function formatPeerLine(p: Peer): string {
  const head = p.host && p.client_pid
    ? `[${p.group_id}] ${p.peer_id}  (${p.host} - PID: ${p.client_pid})`
    : `[${p.group_id}] ${p.peer_id}  PID:${p.pid}`;
  const statusTag = p.status === "active" ? "" : `  <${p.status}>`;
  return `${head}${statusTag}  ${p.cwd}`;
}

const cmd = process.argv[2];
const flags = process.argv.slice(3);

switch (cmd) {
  case "status": {
    try {
      const health = await brokerGet<{ status: string; peers: number; ws_clients?: number }>("/health");
      console.log(`Broker: ${health.status} (${health.peers} active peer(s))`);
      if (typeof health.ws_clients === "number") {
        console.log(`WebSocket clients: ${health.ws_clients}`);
      }
      console.log(`URL: ${BROKER_URL}`);

      if (health.peers > 0) {
        const peers = await brokerGet<Peer[]>("/admin/peers");
        console.log("\nActive peers:");
        for (const p of peers) {
          console.log(`  ${formatPeerLine(p)}`);
          if (p.summary) console.log(`         ${p.summary}`);
          if (p.project_key) console.log(`         Project: ${p.project_key}`);
          if (p.tty) console.log(`         TTY: ${p.tty}`);
          console.log(`         Last seen: ${p.last_seen}`);
        }
      }
    } catch {
      console.log(`Broker is not running (or not reachable at ${BROKER_URL}).`);
    }
    break;
  }

  case "peers": {
    const includeDormant = flags.includes("--include-dormant");
    try {
      const url = includeDormant ? "/admin/peers?include_dormant=1" : "/admin/peers";
      const peers = await brokerGet<Peer[]>(url);
      if (peers.length === 0) {
        console.log("No peers registered.");
      } else {
        for (const p of peers) {
          console.log(formatPeerLine(p));
          if (p.summary) console.log(`  Summary: ${p.summary}`);
          if (p.project_key) console.log(`  Project: ${p.project_key}`);
        }
      }
    } catch {
      console.log(`Broker is not running (or not reachable at ${BROKER_URL}).`);
    }
    break;
  }

  case "groups": {
    try {
      const stats = await brokerGet<GroupStatsResponse>("/group-stats");
      if (stats.groups.length === 0) {
        console.log("No groups with active peers.");
      } else {
        console.log("Active peers per group:");
        for (const g of stats.groups) {
          console.log(`  ${g.group_id}  ${g.active_peers}`);
        }
      }
    } catch {
      console.log(`Broker is not running (or not reachable at ${BROKER_URL}).`);
    }
    break;
  }

  case "kill-broker": {
    if (process.platform === "win32") {
      console.error("kill-broker is Linux/macOS only (uses lsof). On Windows, stop the broker process manually.");
      process.exit(1);
    }
    try {
      const health = await brokerGet<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} active peer(s). Shutting down...`);
      const proc = Bun.spawnSync(["lsof", "-ti", `:${config.port}`]);
      const pids = new TextDecoder()
        .decode(proc.stdout)
        .trim()
        .split("\n")
        .filter((p) => p);
      for (const pid of pids) {
        process.kill(parseInt(pid), "SIGTERM");
      }
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  default:
    console.log(`claude-peers CLI v0.3

Usage:
  bun cli.ts status                       Show broker status and all peers
  bun cli.ts peers [--include-dormant]    List peers across all groups
  bun cli.ts groups                       Show active peer counts per group
  bun cli.ts kill-broker                  Stop the broker daemon (Linux/macOS only)

Note: 'send' is no longer available -- use the MCP send_message tool from
within Claude Code (the broker requires a valid instance_token).

Configuration: env CLAUDE_PEERS_PORT (default 7899) or settings file.
Broker URL: ${BROKER_URL}`);
}
