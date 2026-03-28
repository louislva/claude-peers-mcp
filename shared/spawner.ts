/**
 * Ghostty terminal spawner for Claude Code peers.
 *
 * Uses Ghostty's AppleScript API (1.3+) to open tabs, split panes,
 * and start Claude Code instances with assigned roles.
 *
 * macOS only — requires Ghostty and osascript.
 */

export interface SpawnConfig {
  roles: string[];
  cwd: string;
  prompt?: string;
}

export interface SpawnResult {
  ok: boolean;
  error?: string;
  spawned_roles?: string[];
}

/**
 * Build the claude command string for a given role.
 */
export function buildClaudeCommand(role: string, prompt?: string): string {
  let cmd = `CLAUDE_PEERS_ROLE="${role}" claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers`;
  if (prompt) {
    // Escape single quotes in prompt for shell safety
    const escaped = prompt.replace(/'/g, "'\\''");
    cmd += ` '${escaped}'`;
  }
  return cmd;
}

/**
 * Generate AppleScript to spawn peers in Ghostty splits.
 *
 * Layout strategy:
 * - 1 peer: single pane
 * - 2 peers: right split (side by side)
 * - 3 peers: right split, then down split on left
 * - 4 peers: right split, then down split on both
 */
export function generateAppleScript(config: SpawnConfig): string {
  const { roles, cwd, prompt } = config;
  const commands = roles.map((role) => buildClaudeCommand(role, prompt));

  // Escape backslashes and quotes for AppleScript string literals
  const escapeCwd = cwd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  // cd command to set working directory (since surface configuration is unreliable)
  const cdCmd = `cd "${escapeCwd}"`;

  const lines: string[] = [
    'tell application "Ghostty"',
    "  activate",
    "",
  ];

  if (roles.length === 1) {
    lines.push(
      "  set newTab to new tab in front window",
      "  set t1 to focused terminal of newTab",
      `  input text "${escapeAS(cdCmd)} && ${escapeAS(commands[0])}" to t1`,
      '  send key "enter" to t1',
    );
  } else if (roles.length === 2) {
    lines.push(
      "  set newTab to new tab in front window",
      "  set t1 to focused terminal of newTab",
      "  set t2 to split t1 direction right",
      `  input text "${escapeAS(cdCmd)} && ${escapeAS(commands[0])}" to t1`,
      '  send key "enter" to t1',
      `  input text "${escapeAS(cdCmd)} && ${escapeAS(commands[1])}" to t2`,
      '  send key "enter" to t2',
    );
  } else if (roles.length === 3) {
    lines.push(
      "  set newTab to new tab in front window",
      "  set t1 to focused terminal of newTab",
      "  set t2 to split t1 direction right",
      "  set t3 to split t1 direction down",
      `  input text "${escapeAS(cdCmd)} && ${escapeAS(commands[0])}" to t1`,
      '  send key "enter" to t1',
      `  input text "${escapeAS(cdCmd)} && ${escapeAS(commands[1])}" to t2`,
      '  send key "enter" to t2',
      `  input text "${escapeAS(cdCmd)} && ${escapeAS(commands[2])}" to t3`,
      '  send key "enter" to t3',
    );
  } else if (roles.length >= 4) {
    lines.push(
      "  set newTab to new tab in front window",
      "  set t1 to focused terminal of newTab",
      "  set t2 to split t1 direction right",
      "  set t3 to split t1 direction down",
      "  set t4 to split t2 direction down",
      `  input text "${escapeAS(cdCmd)} && ${escapeAS(commands[0])}" to t1`,
      '  send key "enter" to t1',
      `  input text "${escapeAS(cdCmd)} && ${escapeAS(commands[1])}" to t2`,
      '  send key "enter" to t2',
      `  input text "${escapeAS(cdCmd)} && ${escapeAS(commands[2])}" to t3`,
      '  send key "enter" to t3',
      `  input text "${escapeAS(cdCmd)} && ${escapeAS(commands[3])}" to t4`,
      '  send key "enter" to t4',
    );
  }

  lines.push("end tell");
  return lines.join("\n");
}

/**
 * Escape a string for use inside AppleScript double-quoted string.
 */
function escapeAS(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Check if Ghostty is running on macOS.
 */
async function isGhosttyRunning(): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      ["osascript", "-e", 'tell application "System Events" to (name of processes) contains "Ghostty"'],
      { stdout: "pipe", stderr: "ignore" },
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Spawn Claude Code peers in Ghostty terminal splits.
 */
export async function spawnPeersInGhostty(config: SpawnConfig): Promise<SpawnResult> {
  // Platform check
  if (process.platform !== "darwin") {
    return { ok: false, error: "spawn_peers requires macOS with Ghostty" };
  }

  // Validate roles
  if (config.roles.length === 0) {
    return { ok: false, error: "At least one role is required" };
  }
  if (config.roles.length > 4) {
    return { ok: false, error: "Maximum 4 roles supported per spawn" };
  }

  // Check Ghostty
  if (!(await isGhosttyRunning())) {
    return { ok: false, error: "Ghostty is not running" };
  }

  // Generate and execute AppleScript
  const script = generateAppleScript(config);

  try {
    const proc = Bun.spawn(["osascript", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return { ok: false, error: `AppleScript failed: ${stderr.trim()}` };
    }

    return { ok: true, spawned_roles: config.roles };
  } catch (e) {
    return {
      ok: false,
      error: `Failed to execute osascript: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
