#!/usr/bin/env bun
/**
 * gsd-comms CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 *
 * Usage:
 *   bun cli.ts status          — Show broker status and all peers
 *   bun cli.ts peers           — List all peers
 *   bun cli.ts send <id> <msg> — Send a message to a peer
 *   bun cli.ts stats           — Show DB size, row counts, retention policy
 *   bun cli.ts prune           — Manually trigger data retention cleanup
 *   bun cli.ts db-path         — Print the database file path
 *   bun cli.ts kill-broker     — Stop the broker daemon
 */

import { envWithDeprecation } from "./shared/env.ts";

const BROKER_PORT = parseInt(envWithDeprecation("GSD_COMMS_PORT", "CLAUDE_PEERS_PORT") ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(3000),
  });
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
      console.log(`URL: ${BROKER_URL}`);

      if (health.peers > 0) {
        const peers = await brokerFetch<
          Array<{
            id: string;
            pid: number;
            cwd: string;
            git_root: string | null;
            tty: string | null;
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
          console.log(`  ${p.id}  PID:${p.pid}  ${p.cwd}`);
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
          const parts = [`${p.id}  PID:${p.pid}  ${p.cwd}`];
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

  case "stats": {
    try {
      const stats = await brokerFetch<{
        db_path: string;
        db_size_bytes: number;
        db_size_human: string;
        wal_size_bytes: number;
        schema_version: number;
        retention: {
          messages_hours: number;
          sessions_days: number;
          waves_days: number;
        };
        counts: {
          peers: number;
          messages_total: number;
          messages_undelivered: number;
          messages_delivered: number;
          sessions_active: number;
          sessions_completed: number;
          waves_total: number;
          waves_running: number;
          waves_completed: number;
          tasks_total: number;
          tasks_running: number;
          tasks_completed: number;
        };
      }>("/stats");

      console.log("=== gsd-comms Database Stats ===\n");

      console.log(`Database:  ${stats.db_path}`);
      console.log(`Size:      ${stats.db_size_human} (db: ${formatBytes(stats.db_size_bytes)}, wal: ${formatBytes(stats.wal_size_bytes)})`);
      console.log(`Schema:    v${stats.schema_version}`);

      console.log(`\n--- Retention Policy ---`);
      console.log(`Messages:  ${stats.retention.messages_hours}h (delivered)`);
      console.log(`Sessions:  ${stats.retention.sessions_days}d (completed)`);
      console.log(`Waves:     ${stats.retention.waves_days}d (completed/failed)`);

      console.log(`\n--- Row Counts ---`);
      console.log(`Peers:     ${stats.counts.peers} active`);
      console.log(`Messages:  ${stats.counts.messages_total} total (${stats.counts.messages_undelivered} pending, ${stats.counts.messages_delivered} delivered)`);
      console.log(`Sessions:  ${stats.counts.sessions_active} active, ${stats.counts.sessions_completed} completed`);
      console.log(`Waves:     ${stats.counts.waves_total} total (${stats.counts.waves_running} running, ${stats.counts.waves_completed} done)`);
      console.log(`Tasks:     ${stats.counts.tasks_total} total (${stats.counts.tasks_running} running, ${stats.counts.tasks_completed} done)`);

      // Disk size warning
      const totalBytes = stats.db_size_bytes + stats.wal_size_bytes;
      if (totalBytes > 100 * 1024 * 1024) {
        console.log(`\n!! WARNING: DB is over 100 MB. Run 'bun cli.ts prune' to clean up.`);
      } else if (totalBytes > 50 * 1024 * 1024) {
        console.log(`\n! Note: DB is over 50 MB. Consider running 'bun cli.ts prune'.`);
      }
    } catch {
      // Broker not running — try to read DB directly
      const dbPath = envWithDeprecation("GSD_COMMS_DB", "CLAUDE_PEERS_DB") ?? `${process.env.HOME}/.gsd-comms.db`;
      try {
        const file = Bun.file(dbPath);
        const size = file.size;
        console.log(`Broker is not running.`);
        console.log(`Database: ${dbPath} (${formatBytes(size)})`);
        console.log(`\nStart the broker to see full stats, or run 'bun cli.ts prune' after starting.`);
      } catch {
        console.log("Broker is not running and no database found.");
      }
    }
    break;
  }

  case "prune": {
    try {
      const result = await brokerFetch<{
        messages_pruned: number;
        sessions_pruned: number;
        waves_pruned: number;
        tasks_pruned: number;
      }>("/prune", {});

      const total = result.messages_pruned + result.sessions_pruned + result.waves_pruned + result.tasks_pruned;
      if (total === 0) {
        console.log("Nothing to prune — all data is within retention limits.");
      } else {
        console.log("Pruned:");
        if (result.messages_pruned > 0) console.log(`  ${result.messages_pruned} delivered message(s)`);
        if (result.sessions_pruned > 0) console.log(`  ${result.sessions_pruned} completed session(s)`);
        if (result.waves_pruned > 0) console.log(`  ${result.waves_pruned} completed wave(s)`);
        if (result.tasks_pruned > 0) console.log(`  ${result.tasks_pruned} task assignment(s)`);
      }

      // VACUUM to reclaim disk space
      console.log("\nRunning VACUUM to reclaim disk space...");
      const vacuum = await brokerFetch<{ ok: boolean; size_before: string; size_after: string }>("/vacuum", {});
      console.log(`Size: ${vacuum.size_before} -> ${vacuum.size_after}`);
    } catch {
      console.log("Broker is not running. Start it first to prune data.");
    }
    break;
  }

  case "db-path": {
    const dbPath = envWithDeprecation("GSD_COMMS_DB", "CLAUDE_PEERS_DB") ?? `${process.env.HOME}/.gsd-comms.db`;
    console.log(dbPath);
    break;
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);
      // Find and kill the broker process on the port
      const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
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
    console.log(`gsd-comms CLI

Usage:
  bun cli.ts status          Show broker status and all peers
  bun cli.ts peers           List all peers
  bun cli.ts send <id> <msg> Send a message to a peer
  bun cli.ts stats           Show DB size, row counts, retention policy
  bun cli.ts prune           Manually trigger data retention cleanup
  bun cli.ts db-path         Print the database file path
  bun cli.ts kill-broker     Stop the broker daemon

Environment:
  GSD_COMMS_PORT               Broker port (default: 7899)
  GSD_COMMS_DB                 Database path (default: ~/.gsd-comms.db)
  GSD_COMMS_RETAIN_MESSAGES_MS Message retention in ms (default: 86400000 = 24h)
  GSD_COMMS_RETAIN_SESSIONS_MS Session retention in ms (default: 604800000 = 7d)
  GSD_COMMS_RETAIN_WAVES_MS    Wave retention in ms (default: 2592000000 = 30d)

  Legacy CLAUDE_PEERS_* names still work with a deprecation note.`);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
