import { readFileSync, readlinkSync } from "node:fs";
import { isClientProcess, isCodexAppServerProcess, type ProcessInfo } from "./client.ts";

export interface VisibleCodexProcess {
  pid: number;
  cwd: string;
  tty: string;
  env: Record<string, string | undefined>;
}

export interface VisibleCodexReaders {
  getTty?: (pid: number) => string | null;
  cwdOf?: (pid: number) => string | null;
  environOf?: (pid: number) => Record<string, string | undefined>;
  processStartTicks?: (pid: number) => number | null;
}

function commandName(value: string): string {
  return value.trim().split(/\s+/)[0]?.toLowerCase().replace(/^.*\//, "") ?? "";
}

function defaultGetTty(pid: number): string | null {
  try {
    const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(pid)]);
    const tty = new TextDecoder().decode(proc.stdout).trim();
    return tty && tty !== "?" && tty !== "??" ? tty : null;
  } catch {
    return null;
  }
}

function defaultCwdOf(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function defaultEnvironOf(pid: number): Record<string, string | undefined> {
  try {
    const text = readFileSync(`/proc/${pid}/environ`, "utf8");
    const env: Record<string, string | undefined> = {};
    for (const entry of text.split("\0")) {
      const idx = entry.indexOf("=");
      if (idx <= 0) continue;
      env[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    return env;
  } catch {
    return {};
  }
}

export function processStartTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const startTicks = Number(fields[19]);
    return Number.isFinite(startTicks) ? startTicks : null;
  } catch {
    return null;
  }
}

export function hasVisibleCodexIdentityEnv(env: Record<string, string | undefined>): boolean {
  return Boolean(env.CLAUDE_PEER_NAME || env.TMUX_PANE);
}

export function isVisibleCodexProcess(row: ProcessInfo): boolean {
  return isClientProcess(row, "codex") && !isCodexAppServerProcess(row);
}

export function isVisibleCodexArgs(args: string): boolean {
  const first = commandName(args);
  if (first !== "codex" && !first.startsWith("codex-")) return false;
  return !/\bapp-server\b/.test(args);
}

export function findSingleVisibleCodexProcess(
  processes: Map<number, ProcessInfo> | Iterable<ProcessInfo>,
  cwdHint: string,
  readers: VisibleCodexReaders = {},
): VisibleCodexProcess | null {
  const ttyReader = readers.getTty ?? defaultGetTty;
  const cwdReader = readers.cwdOf ?? defaultCwdOf;
  const envReader = readers.environOf ?? defaultEnvironOf;
  const rows = processes instanceof Map ? processes.values() : processes;
  const candidates: VisibleCodexProcess[] = [];

  for (const row of rows) {
    if (!isVisibleCodexProcess(row)) continue;
    const tty = ttyReader(row.pid);
    if (!tty) continue;
    const cwd = cwdReader(row.pid);
    if (!cwd || cwd !== cwdHint) continue;
    const env = envReader(row.pid);
    if (!hasVisibleCodexIdentityEnv(env)) continue;
    candidates.push({ pid: row.pid, cwd, tty, env });
  }

  return candidates.length === 1 ? candidates[0]! : null;
}

export function findNearestVisibleCodexProcessByStart(
  processes: Map<number, ProcessInfo> | Iterable<ProcessInfo>,
  cwdHint: string,
  anchorPid: number,
  readers: VisibleCodexReaders = {},
  maxStartTickDelta = 2_000,
): VisibleCodexProcess | null {
  const startTicksReader = readers.processStartTicks ?? processStartTicks;
  const anchorStart = startTicksReader(anchorPid);
  if (anchorStart === null) return null;

  const rows = processes instanceof Map ? processes.values() : processes;
  const candidates = Array.from(rows)
    .filter((row) => row.pid !== anchorPid)
    .map((row) => {
      const startTicks = startTicksReader(row.pid);
      if (startTicks === null) return null;
      const visible = findSingleVisibleCodexProcess([row], cwdHint, readers);
      if (!visible) return null;
      const delta = anchorStart - startTicks;
      if (delta < 0 || delta > maxStartTickDelta) return null;
      return { visible, delta };
    })
    .filter((entry): entry is { visible: VisibleCodexProcess; delta: number } => entry !== null)
    .sort((a, b) => a.delta - b.delta);

  if (candidates.length === 0) return null;
  if (candidates.length > 1 && candidates[0]!.delta === candidates[1]!.delta) return null;
  return candidates[0]!.visible;
}
