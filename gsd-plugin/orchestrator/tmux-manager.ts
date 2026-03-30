/**
 * tmux-manager.ts
 *
 * Self-contained module for all tmux interactions.
 * Spawns executor panes with gsd-watch sidebars, manages layout,
 * and handles graceful cleanup.
 *
 * No broker dependency — this module only shells out to tmux.
 */

// --- Configuration ---

/** Maximum concurrent executor panes to limit token consumption and tmux layout */
export const MAX_EXECUTOR_PANES = 3;

/** Default gsd-watch binary path */
const DEFAULT_GSD_WATCH_BIN = `${process.env.HOME}/.local/bin/gsd-watch`;

/** How long to wait for a pane to exit after Ctrl-C before force-killing */
const GRACEFUL_SHUTDOWN_MS = 2_000;

// --- Types ---

/** Metadata for a spawned executor tmux pane and its companion gsd-watch pane */
export interface SpawnedPane {
  /** tmux pane ID (e.g., "%42") */
  executorPaneId: string;
  /** gsd-watch pane ID (e.g., "%43") */
  watchPaneId: string;
  /** Epoch ms when the pane was spawned (for timeout tracking) */
  spawnedAt: number;
}

// --- Internal helpers ---

/** Run a tmux command, return trimmed stdout. Throws on non-zero exit. */
async function tmuxExec(args: string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`tmux ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout.trim();
}

/** Run a tmux command, ignore errors (for cleanup operations) */
async function tmuxExecSafe(args: string[]): Promise<void> {
  const proc = Bun.spawn(["tmux", ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

// --- Exported functions ---

/**
 * Check if the current process is running inside a tmux session.
 */
export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX;
}

/**
 * Get the current tmux pane ID (%N format).
 * Used to identify the orchestrator's own pane.
 */
export async function getCurrentPaneId(): Promise<string> {
  return tmuxExec(["display-message", "-p", "#{pane_id}"]);
}

/**
 * Spawn a single executor: creates a new tmux pane running Claude Code
 * with the executor agent, then creates a nested gsd-watch pane beside it.
 *
 * Layout: executor pane splits vertically below current layout (30% height),
 * then gsd-watch splits horizontally to the right of the executor (25% width).
 *
 * @param gitRoot - Project directory to cd into
 * @param agentPath - Absolute path to gsd-executor.md agent file
 * @param mcpConfigPath - Absolute path to .mcp.json for Claude Code --mcp-config
 * @param gsdWatchBin - Path to gsd-watch binary (default: ~/.local/bin/gsd-watch)
 * @returns SpawnedPane metadata
 */
export async function spawnExecutorPane(
  gitRoot: string,
  agentPath: string,
  mcpConfigPath?: string,
  gsdWatchBin?: string
): Promise<SpawnedPane> {
  const watchBin = gsdWatchBin ?? DEFAULT_GSD_WATCH_BIN;

  // Build the Claude Code command for the executor pane
  const claudeArgs = [
    "claude",
    "--agent", agentPath,
    "--permission-mode", "bypassPermissions",
  ];
  if (mcpConfigPath) {
    claudeArgs.push("--mcp-config", mcpConfigPath);
  }
  claudeArgs.push("-p", "You are a GSD executor peer. Set your summary to 'executor -- idle' and wait for execute_phase messages. Poll for messages every 10 seconds.");

  const claudeCmd = `cd "${gitRoot}" && ${claudeArgs.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}`;

  // 1. Spawn executor pane (vertical split below, 30% height, keep focus on orchestrator)
  const executorPaneId = await tmuxExec([
    "split-window", "-v", "-p", "30", "-d",
    "-P", "-F", "#{pane_id}",
    claudeCmd,
  ]);

  // 2. Spawn gsd-watch pane (horizontal split right of executor, 25% width)
  let watchPaneId: string;
  try {
    watchPaneId = await tmuxExec([
      "split-window", "-h", "-t", executorPaneId, "-p", "25", "-d",
      "-P", "-F", "#{pane_id}",
      `cd "${gitRoot}" && "${watchBin}" --no-emoji`,
    ]);
  } catch {
    // gsd-watch spawn failed — non-fatal, executor still works
    watchPaneId = "";
  }

  return {
    executorPaneId,
    watchPaneId,
    spawnedAt: Date.now(),
  };
}

/**
 * Gracefully kill a tmux pane. Sends Ctrl-C first, waits, then force-kills.
 * No-op if the pane no longer exists.
 */
export async function killPane(paneId: string): Promise<void> {
  if (!paneId) return;

  // Check if pane exists
  try {
    await tmuxExec(["has-session", "-t", paneId]);
  } catch {
    return; // Pane already gone
  }

  // Send Ctrl-C for graceful shutdown
  await tmuxExecSafe(["send-keys", "-t", paneId, "C-c", ""]);

  // Wait for graceful exit
  await new Promise((r) => setTimeout(r, GRACEFUL_SHUTDOWN_MS));

  // Force kill if still alive
  await tmuxExecSafe(["kill-pane", "-t", paneId]);
}

/**
 * Kill multiple spawned panes (executor + watch pairs).
 * Kills watch panes first (they're just monitors), then executor panes.
 */
export async function killSpawnedPanes(panes: SpawnedPane[]): Promise<void> {
  // Kill watch panes first (non-blocking, they're just viewers)
  const watchKills = panes
    .filter((p) => p.watchPaneId)
    .map((p) => tmuxExecSafe(["kill-pane", "-t", p.watchPaneId]));
  await Promise.allSettled(watchKills);

  // Kill executor panes (graceful)
  for (const pane of panes) {
    await killPane(pane.executorPaneId);
  }
}

/**
 * Check if a tmux pane is still alive.
 */
export async function isPaneAlive(paneId: string): Promise<boolean> {
  if (!paneId) return false;
  try {
    await tmuxExec(["display-message", "-t", paneId, "-p", "#{pane_id}"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Count how many executor panes from the given list are still alive.
 */
export async function countLivePanes(panes: SpawnedPane[]): Promise<number> {
  const checks = await Promise.all(panes.map((p) => isPaneAlive(p.executorPaneId)));
  return checks.filter(Boolean).length;
}

/**
 * List all tmux panes in the current session with their titles and commands.
 * Useful for debugging and duplicate detection.
 */
export async function listSessionPanes(): Promise<Array<{ id: string; title: string; command: string }>> {
  const raw = await tmuxExec([
    "list-panes", "-s",
    "-F", "#{pane_id}\t#{pane_title}\t#{pane_current_command}",
  ]);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => {
    const [id, title, command] = line.split("\t");
    return { id, title: title ?? "", command: command ?? "" };
  });
}
