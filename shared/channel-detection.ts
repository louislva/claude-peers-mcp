// Detects whether the parent `claude` process was launched with
// `--dangerously-load-development-channels server:claude-peers`.
//
// This flag is a *client-side* permission gate, NOT an MCP protocol capability.
// `getClientCapabilities()` does not surface it — the client's capability block
// only contains `elicitation` and `roots`. The only reliable signal is the
// parent process's argv.
//
// In the current stdio invocation model, the immediate parent process is the
// `claude` binary; no tree-walk is needed. If that assumption ever breaks
// (e.g. a shell wrapper or process supervisor interposes), `detectChannelLoaded()`
// returns `false` gracefully rather than erroring, and operators see a `Channel: no`
// rather than a crash.

function log(msg: string): void {
  // Match server.ts's log prefix so all `[claude-peers]` stderr is grep-able.
  console.error(`[claude-peers] ${msg}`);
}

export function matchesChannelFlag(parentArgs: string | null): boolean {
  if (!parentArgs) return false;
  // Extract the flag value — handles both `--flag value` and `--flag=value`.
  const flagMatch = parentArgs.match(/--dangerously-load-development-channels[ =](\S+)/);
  const value = flagMatch?.[1];
  if (!value) return false;
  // Value is a comma-separated list of `server:NAME` entries.
  // Exact match per entry avoids false positives like `server:claude-peers-fork`.
  return value.split(",").includes("server:claude-peers");
}

export async function readParentArgs(pid: number): Promise<string | null> {
  // Linux: /proc/<pid>/cmdline is null-separated argv.
  try {
    const f = Bun.file(`/proc/${pid}/cmdline`);
    if (await f.exists()) {
      const text = await f.text();
      if (text) return text.replace(/\0/g, " ").trim();
    }
  } catch (e) {
    log(`readParentArgs(/proc/${pid}/cmdline) failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // macOS/BSD fallback: ps -p <pid> -o args=
  try {
    const proc = Bun.spawnSync(["ps", "-p", String(pid), "-o", "args="]);
    if (proc.exitCode === 0) {
      return new TextDecoder().decode(proc.stdout).trim();
    }
    log(`readParentArgs(ps -p ${pid}) exited ${proc.exitCode}; reporting unknown`);
  } catch (e) {
    log(`readParentArgs(ps spawn) failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return null;
}

// `pid` is optional — defaults to `process.ppid` for production. Tests inject a
// controlled pid (e.g. a subprocess they spawned with a known argv) so the
// composition path itself is covered, not just the matcher and reader helpers.
export async function detectChannelLoaded(pid?: number): Promise<boolean> {
  const targetPid = pid ?? process.ppid;
  if (!targetPid) return false;
  const args = await readParentArgs(targetPid);
  return matchesChannelFlag(args);
}
