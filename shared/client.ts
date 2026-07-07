import type { ClientType, ReceiverMode } from "./types.ts";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  comm: string;
  args: string;
}

function normalizedClient(value: string | undefined): ClientType | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v === "claude" || v === "claude-code") return "claude";
  if (v === "codex") return "codex";
  if (v === "gemini" || v === "gemini-cli") return "gemini";
  if (v === "unknown") return "unknown";
  return null;
}

function commandName(value: string): string {
  return value.trim().split(/\s+/)[0]?.toLowerCase().replace(/^.*\//, "") ?? "";
}

function argTokens(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

function hasGeminiCliLauncher(args: string): boolean {
  return argTokens(args).some((token) => {
    const normalized = token.replace(/^['"]|['"]$/g, "").toLowerCase();
    const base = normalized.replace(/^.*\//, "");
    return normalized.includes("@google/gemini-cli/") || base === "gemini.js" || base === "gemini-cli.js";
  });
}

export function isClientProcess(row: ProcessInfo, clientType: Exclude<ClientType, "unknown">): boolean {
  const comm = commandName(row.comm);
  const firstArg = commandName(row.args);
  if (clientType === "claude") return comm === "claude" || firstArg === "claude";
  if (comm === clientType || comm.startsWith(`${clientType}-`)) return true;
  if (firstArg === clientType || firstArg.startsWith(`${clientType}-`)) return true;
  return clientType === "gemini" && (comm === "node" || comm === "bun" || comm === "npx") && hasGeminiCliLauncher(row.args);
}

export function isCodexAppServerProcess(row: ProcessInfo): boolean {
  const comm = commandName(row.comm);
  const firstArg = commandName(row.args);
  if (comm !== "codex" && firstArg !== "codex") return false;
  return /\bapp-server\b/.test(row.args);
}

export function findClientPidFromProcessChain(
  startPid: number,
  processes: Map<number, ProcessInfo>,
  clientType: Exclude<ClientType, "unknown">,
): number | null {
  let current = startPid;
  for (let i = 0; i < 30; i++) {
    const p = processes.get(current);
    if (!p) break;
    if (isClientProcess(p, clientType)) {
      // Codex Desktop runs MCP servers and hooks under a long-lived
      // `codex app-server` process. That process is a transport host, not the
      // visible tmux lane that should receive peer mail. Return null here so
      // callers can fall back to a visible TTY Codex resolver instead of
      // registering the app-server as a routable peer.
      if (clientType === "codex" && isCodexAppServerProcess(p)) return null;
      return p.pid;
    }
    if (p.ppid <= 1 || p.ppid === current) break;
    current = p.ppid;
  }
  return null;
}

// Claude Code pre-warms spare sessions (`claude --bg-spare /tmp/cc-daemon-...`)
// that load MCP servers before any real session exists. A spare inherits stale
// CLAUDE_PEER_NAME / TMUX_PANE env from the shell that started the daemon, so
// registering it creates a ghost duplicate on a pane it does not occupy
// (observed 2026-06-10: ux.2#3 squatting pane %34). Returns the spare ancestor
// row when the chain contains one, else null.
export function findBgSpareAncestor(
  startPid: number,
  processes: Map<number, ProcessInfo>,
): ProcessInfo | null {
  let current = startPid;
  for (let i = 0; i < 30; i++) {
    const p = processes.get(current);
    if (!p) break;
    if (/(^|\s)--bg-spare(\s|$)/.test(p.args)) return p;
    if (p.ppid <= 1 || p.ppid === current) break;
    current = p.ppid;
  }
  return null;
}

export function detectClientFromProcessChain(
  startPid: number,
  processes: Map<number, ProcessInfo>,
  env: Record<string, string | undefined> = process.env,
): ClientType {
  const override = normalizedClient(env.CLAUDE_PEERS_CLIENT_TYPE);
  if (override) return override;

  let current = startPid;
  for (let i = 0; i < 30; i++) {
    const p = processes.get(current);
    if (!p) break;
    if (isClientProcess(p, "codex")) return "codex";
    if (isClientProcess(p, "gemini")) return "gemini";
    if (isClientProcess(p, "claude")) return "claude";
    if (p.ppid <= 1 || p.ppid === current) break;
    current = p.ppid;
  }
  return "unknown";
}

export function initialReceiverMode(clientType: ClientType): ReceiverMode {
  if (clientType === "claude") return "claude-channel";
  if (clientType === "codex") return "manual-drain";
  if (clientType === "gemini") return "manual-drain";
  return "unknown";
}
