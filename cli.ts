#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 *
 * Usage:
 *   bun cli.ts status          — Show broker status and all peers
 *   bun cli.ts peers           — List all peers
 *   bun cli.ts send <id> <msg> — Send a message to a peer
 *   bun cli.ts kill-broker     — Stop the broker daemon
 */

import { DEFAULT_SOCKET_PATH } from "./shared/types.ts";

const SOCKET_PATH = process.env.CLAUDE_PEERS_SOCKET ?? DEFAULT_SOCKET_PATH;
const BROKER_TCP = process.env.CLAUDE_PEERS_URL; // optional TCP fallback

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const url = BROKER_TCP ? `${BROKER_TCP}${path}` : `http://localhost${path}`;
  const fetchOpts: RequestInit & { unix?: string } = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};
  fetchOpts.signal = AbortSignal.timeout(3000);
  if (!BROKER_TCP) fetchOpts.unix = SOCKET_PATH;

  const res = await fetch(url, fetchOpts);
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

const cmd = process.argv[2];

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker: ${health.status} (${health.peers} peer(s) registered)`);
      console.log(`Socket: ${SOCKET_PATH}`);

      if (health.peers > 0) {
        const peers = await brokerFetch<
          Array<{
            id: string;
            pid: number;
            cwd: string;
            git_root: string | null;
            tty: string | null;
            client_type: string;
            summary: string;
            last_seen: string;
          }>
        >("/list-peers", {
          scope: "machine",
          cwd: "/",
          git_root: null,
        });

        console.log("\nPeers:");
        for (const p of peers) {
          const tag = p.client_type ?? "claude-code";
          console.log(`  ${p.id}  [${tag}]  PID:${p.pid}  ${p.cwd}`);
          if (p.summary) console.log(`         ${p.summary}`);
          if (p.tty) console.log(`         TTY: ${p.tty}`);
          console.log(`         Last seen: ${p.last_seen}`);
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "peers": {
    try {
      const peers = await brokerFetch<
        Array<{
          id: string;
          pid: number;
          cwd: string;
          git_root: string | null;
          tty: string | null;
          client_type: string;
          summary: string;
          last_seen: string;
        }>
      >("/list-peers", {
        scope: "machine",
        cwd: "/",
        git_root: null,
      });

      if (peers.length === 0) {
        console.log("No peers registered.");
      } else {
        for (const p of peers) {
          const tag = p.client_type ?? "claude-code";
          const parts = [`${p.id}  [${tag}]  PID:${p.pid}  ${p.cwd}`];
          if (p.summary) parts.push(`  Summary: ${p.summary}`);
          console.log(parts.join("\n"));
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "send": {
    const toId = process.argv[3];
    const msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) {
      console.error("Usage: bun cli.ts send <peer-id> <message>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
        from_id: "cli",
        to_id: toId,
        text: msg,
      });
      if (result.ok) {
        console.log(`Message sent to ${toId}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "kill": {
    const killId = process.argv[3];
    if (!killId) {
      console.error("Usage: bun cli.ts kill <peer-id>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string; killed_pid?: number }>("/kill-peer", {
        id: killId,
      });
      if (result.ok) {
        console.log(`Killed peer ${killId} (PID ${result.killed_pid})`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);
      // Use launchctl to stop the broker (socket-based, no port to lsof)
      const uid = new TextDecoder().decode(Bun.spawnSync(["id", "-u"]).stdout).trim();
      const proc = Bun.spawnSync(["launchctl", "kill", "SIGTERM", `gui/${uid}/com.minoan.claude-peers-broker`]);
      if (proc.exitCode === 0) {
        console.log("Broker stopped.");
      } else {
        console.log("launchctl kill failed — broker may not be managed by launchd.");
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  default:
    console.log(`claude-peers CLI

Usage:
  bun cli.ts status          Show broker status and all peers
  bun cli.ts peers           List all peers
  bun cli.ts send <id> <msg> Send a message to a peer
  bun cli.ts kill <id>       Kill a peer's agent session
  bun cli.ts kill-broker     Stop the broker daemon`);
}
