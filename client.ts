#!/usr/bin/env bun
/**
 * claude-peers client shim
 *
 * Spawned by Claude Code as the MCP server. Detects local context (cwd, git
 * root, branch, recent files, hostname, pid, project key from git remote),
 * spawns ssh to the remote server.ts, sends a JSON handshake on stdin's
 * first line, then forwards stdio transparently between Claude Code and ssh.
 *
 * Configuration:
 *   - CLAUDE_PEERS_REMOTE              "user@host[:port]" (required)
 *   - CLAUDE_PEERS_SSH_OPTS            CSV of extra ssh args (optional)
 *   - CLAUDE_PEERS_REMOTE_SERVER_PATH  path to server.ts on remote (optional)
 *
 * Or in $XDG_CONFIG_HOME/claude-peers/config.json (Linux/macOS) or
 * %APPDATA%\claude-peers\config.json (Windows).
 */

import { hostname } from "node:os";
import { loadConfig, resolveGroup } from "./shared/config.ts";
import {
  getGitBranch,
  getRecentFiles,
  computeProjectKey,
} from "./shared/summarize.ts";
import type { ClientMeta } from "./shared/types.ts";

function log(msg: string) {
  console.error(`[claude-peers-client] ${msg}`);
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

/**
 * Parse "user@host[:port]" into ssh args.
 * Returns the user@host plus an optional ["-p", port] array.
 */
function parseRemote(remote: string): { target: string; portArgs: string[] } {
  // Match optional :port at the end, but be careful: a port is digits only
  // and there can be a colon in the user part of an IPv6 host (rare).
  const match = remote.match(/^(.+):(\d+)$/);
  if (match) {
    return { target: match[1], portArgs: ["-p", match[2]] };
  }
  return { target: remote, portArgs: [] };
}

async function main() {
  const config = await loadConfig();

  if (!config.remote) {
    log("CLAUDE_PEERS_REMOTE is not set (or 'remote' missing in config file).");
    log("Set it to user@host[:port] and try again.");
    process.exit(1);
  }

  const cwd = process.cwd();
  const [git_root, git_branch, recent_files, project_key] = await Promise.all([
    getGitRoot(cwd),
    getGitBranch(cwd),
    getRecentFiles(cwd, 10),
    computeProjectKey(cwd),
  ]);

  // v0.3: resolve the group locally; the secret never leaves this PC.
  const { name: groupName, group_id, group_secret_hash, groups_map } = resolveGroup(
    cwd,
    git_root,
    config
  );
  log(`Group: ${groupName} (id: ${group_id.slice(0, 8)})`);

  const meta: ClientMeta = {
    host: hostname(),
    client_pid: process.pid,
    cwd,
    git_root,
    git_branch,
    recent_files,
    project_key,
    tty: null,
    group_id,
    group_secret_hash,
    groups_map,
  };

  const handshake = JSON.stringify({ client_meta: meta }) + "\n";

  const { target, portArgs } = parseRemote(config.remote);
  const sshArgs: string[] = [
    ...portArgs,
    ...config.ssh_opts,
    target,
    "bun",
    config.remote_server_path,
  ];

  log(`Connecting: ssh ${sshArgs.join(" ")}`);

  const proc = Bun.spawn(["ssh", ...sshArgs], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  // Handshake first
  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(handshake));

  // Forward stdin -> ssh stdin
  // Pipe Node Readable (process.stdin) into the Bun WritableStreamDefaultWriter.
  process.stdin.on("data", (chunk: Buffer) => {
    writer.write(new Uint8Array(chunk)).catch(() => {
      // Pipe broken; will be handled when proc exits
    });
  });
  process.stdin.on("end", () => {
    writer.close().catch(() => {});
  });

  // Forward ssh stdout -> our stdout
  (async () => {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) process.stdout.write(value);
      }
    } catch (e) {
      log(`Forward error: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  // Propagate signals
  const onSignal = (sig: NodeJS.Signals) => {
    try {
      proc.kill(sig);
    } catch {
      // ignore
    }
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  const code = await proc.exited;
  log(`ssh exited with code ${code}`);
  process.exit(code ?? 0);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
