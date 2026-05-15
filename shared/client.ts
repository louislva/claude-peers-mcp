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
  if (v === "unknown") return "unknown";
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
    const comm = p.comm.toLowerCase().replace(/^.*\//, "");
    if (comm === "codex" || comm.startsWith("codex-")) return "codex";
    if (comm === "claude") return "claude";
    const firstArg = p.args.trim().split(/\s+/)[0]?.toLowerCase().replace(/^.*\//, "") ?? "";
    if (firstArg === "codex" || firstArg.startsWith("codex-")) return "codex";
    if (firstArg === "claude") return "claude";
    if (p.ppid <= 1 || p.ppid === current) break;
    current = p.ppid;
  }
  return "unknown";
}

export function initialReceiverMode(clientType: ClientType): ReceiverMode {
  if (clientType === "claude") return "claude-channel";
  if (clientType === "codex") return "manual-drain";
  return "unknown";
}
