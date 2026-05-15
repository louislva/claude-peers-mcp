#!/usr/bin/env bun
import { readlinkSync } from "node:fs";
import { renderInboundLine } from "../shared/render.ts";
import type { Message } from "../shared/types.ts";

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const MAX_MESSAGES = 25;
const MAX_BYTES = 64 * 1024;

interface ProcRow {
  pid: number;
  ppid: number;
  comm: string;
  args: string;
}

interface AckByPidResponse {
  ok: boolean;
  peer_id?: string;
  acked?: number;
  error?: string;
}

function log(msg: string): void {
  console.error(`[claude-peers codex-hook] ${msg}`);
}

function processTable(): Map<number, ProcRow> {
  const table = new Map<number, ProcRow>();
  const proc = Bun.spawnSync(["ps", "-eo", "pid=,ppid=,comm=,args="]);
  if (proc.exitCode !== 0) return table;
  const text = new TextDecoder().decode(proc.stdout);
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    table.set(Number(m[1]), {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      comm: m[3] ?? "",
      args: m[4] ?? "",
    });
  }
  return table;
}

function isCodexProcess(row: ProcRow): boolean {
  const text = `${row.comm} ${row.args}`.toLowerCase();
  return /(^|[/\s])codex([-\s]|$)/.test(text);
}

function isPeersServer(row: ProcRow): boolean {
  return /claude-peers-mcp\/server\.ts/.test(row.args) || (/\/server\.ts/.test(row.args) && /claude-peers/.test(row.args));
}

function descendants(rootPid: number, table: Map<number, ProcRow>): ProcRow[] {
  const children = new Map<number, ProcRow[]>();
  for (const row of table.values()) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const out: ProcRow[] = [];
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    out.push(next);
    stack.push(...(children.get(next.pid) ?? []));
  }
  return out;
}

function cwdOf(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function findCodexAncestor(table: Map<number, ProcRow>, startPid = process.ppid): number | null {
  let current = startPid;
  for (let i = 0; i < 30; i++) {
    const row = table.get(current);
    if (!row) return null;
    if (isCodexProcess(row)) return row.pid;
    if (row.ppid <= 1 || row.ppid === row.pid) return null;
    current = row.ppid;
  }
  return null;
}

export function findMcpPidFromTable(
  table: Map<number, ProcRow>,
  startPid: number,
  hookCwd: string,
  cwdResolver: (pid: number) => string | null = cwdOf,
): number | null {
  const codexPid = findCodexAncestor(table, startPid);
  if (!codexPid) return null;

  const candidates = descendants(codexPid, table)
    .filter(isPeersServer)
    .filter((row) => row.pid !== process.pid);
  const cwdMatches = candidates.filter((row) => cwdResolver(row.pid) === hookCwd);
  const selected = cwdMatches.length > 0 ? cwdMatches : candidates;
  if (selected.length === 1) return selected[0]!.pid;
  return null;
}

function findMcpPid(): number | null {
  const envPid = Number(process.env.CLAUDE_PEERS_MCP_PID ?? "");
  if (Number.isInteger(envPid) && envPid > 1) return envPid;

  const table = processTable();
  const codexPid = findCodexAncestor(table);
  if (!codexPid) {
    log("no Codex ancestor found");
    return null;
  }

  const hookCwd = process.cwd();
  const candidates = descendants(codexPid, table)
    .filter(isPeersServer)
    .filter((row) => row.pid !== process.pid);
  const cwdMatches = candidates.filter((row) => cwdOf(row.pid) === hookCwd);
  const selected = cwdMatches.length > 0 ? cwdMatches : candidates;
  if (selected.length === 1) return selected[0]!.pid;
  if (selected.length > 1) {
    log(`multiple claude-peers MCP candidates: ${selected.map((p) => p.pid).join(",")}`);
    return null;
  }
  log("no claude-peers MCP candidate found");
  return null;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = typeof json === "object" && json && "error" in json ? String((json as { error: unknown }).error) : res.statusText;
    throw new Error(`${path} ${res.status}: ${err}`);
  }
  return json as T;
}

async function heartbeat(pid: number, status: "ok" | "error", drained = 0, error?: string): Promise<void> {
  try {
    await post("/hook-heartbeat-by-pid", {
      pid,
      caller_pid: process.pid,
      status,
      drained,
      error,
    });
  } catch (e) {
    log(`heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main(): Promise<void> {
  const pid = findMcpPid();
  if (!pid) {
    process.exitCode = 1;
    return;
  }

  const drainId = `codex-hook:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let claimed: { peer_id?: string; drain_id?: string; messages?: Message[] };
  try {
    claimed = await post("/claim-by-pid", {
      pid,
      caller_pid: process.pid,
      drain_id: drainId,
      limit: MAX_MESSAGES,
      max_bytes: MAX_BYTES,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`claim failed: ${msg}`);
    await heartbeat(pid, "error", 0, msg);
    return;
  }

  const messages = claimed.messages ?? [];
  if (messages.length === 0 || !claimed.drain_id) {
    await heartbeat(pid, "ok", 0);
    return;
  }

  try {
    const ack = await post<AckByPidResponse>("/ack-by-pid", {
      pid,
      caller_pid: process.pid,
      drain_id: claimed.drain_id,
      ids: messages.map((m) => m.id),
      via: "codex-hook",
    });
    if (ack.acked !== messages.length) {
      throw new Error(`ack mismatch: expected ${messages.length}, got ${ack.acked ?? 0}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`ack failed before stdout emit: ${msg}`);
    await heartbeat(pid, "error", 0, msg);
    process.exitCode = 1;
    return;
  }

  const lines = messages.map(renderInboundLine);
  const context = `---\n${messages.length} pending peer message(s):\n\n${lines.join("\n\n")}`;
  const output = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
    suppressOutput: true,
  };

  try {
    await Bun.write(Bun.stdout, `${JSON.stringify(output)}\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`stdout emit failed after ack: ${msg}`);
    await heartbeat(pid, "error", 0, msg);
    process.exitCode = 1;
    return;
  }
  await heartbeat(pid, "ok", messages.length);
}

if (import.meta.main) {
  main().catch((e) => {
    log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
