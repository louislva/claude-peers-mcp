#!/usr/bin/env bun
import { readFileSync, readlinkSync } from "node:fs";
import { isClientProcess as sharedIsClientProcess, isCodexAppServerProcess as sharedIsCodexAppServerProcess, type ProcessInfo } from "../shared/client.ts";
import { renderInboundLine } from "../shared/render.ts";
import type { ClientType, Message, ReceiverMode } from "../shared/types.ts";
import { findSingleVisibleCodexProcess } from "../shared/visible-codex.ts";

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const MAX_MESSAGES = 25;
const MAX_BYTES = 64 * 1024;
const CLIENT_TYPE: Extract<ClientType, "codex" | "gemini"> =
  process.env.CLAUDE_PEERS_CLIENT_TYPE === "gemini" ? "gemini" : "codex";
const RECEIVER_MODE: Extract<ReceiverMode, "codex-hook" | "gemini-hook"> =
  CLIENT_TYPE === "gemini" ? "gemini-hook" : "codex-hook";
const HOOK_EVENT_NAME = process.env.CLAUDE_PEERS_HOOK_EVENT_NAME ??
  (CLIENT_TYPE === "gemini" ? "BeforeAgent" : "UserPromptSubmit");
const REGISTER_SCRIPT = new URL("./register-peer-session.ts", import.meta.url).pathname;
const REGISTER_TIMEOUT_MS = 2_000;

type ProcRow = ProcessInfo;

interface AckByPidResponse {
  ok: boolean;
  peer_id?: string;
  acked?: number;
  error?: string;
}

type ClaimResponse = { peer_id?: string; drain_id?: string; messages?: Message[] };
type ClaimFn = (pid: number, drainId: string) => Promise<ClaimResponse>;
interface RegistrationProcess {
  exited: Promise<number>;
  kill(signal?: string | number): void;
  stderr?: ReadableStream<Uint8Array> | number | null;
}

export class BrokerHttpError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
    public readonly brokerError: string,
  ) {
    super(`${path} ${status}: ${brokerError}`);
  }
}

function log(msg: string): void {
  console.error(`[claude-peers ${CLIENT_TYPE}-hook] ${msg}`);
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

function isClientProcess(row: ProcRow, clientType = CLIENT_TYPE): boolean {
  return sharedIsClientProcess(row, clientType);
}

function isCodexAppServerProcess(row: ProcRow): boolean {
  return sharedIsCodexAppServerProcess(row);
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

function getTty(pid: number): string | null {
  try {
    const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(pid)]);
    const tty = new TextDecoder().decode(proc.stdout).trim();
    return tty && tty !== "?" && tty !== "??" ? tty : null;
  } catch {
    return null;
  }
}

function hasPeerIdentityEnv(pid: number): boolean {
  try {
    const text = readFileSync(`/proc/${pid}/environ`, "utf8");
    return text.includes("CLAUDE_PEER_NAME=") || text.includes("TMUX_PANE=");
  } catch {
    return false;
  }
}

function findClientAncestor(table: Map<number, ProcRow>, startPid = process.ppid, clientType = CLIENT_TYPE): number | null {
  let current = startPid;
  for (let i = 0; i < 30; i++) {
    const row = table.get(current);
    if (!row) return null;
    if (isClientProcess(row, clientType)) {
      if (clientType === "codex" && isCodexAppServerProcess(row)) return null;
      return row.pid;
    }
    if (row.ppid <= 1 || row.ppid === row.pid) return null;
    current = row.ppid;
  }
  return null;
}

function findCodexAppServerAncestor(table: Map<number, ProcRow>, startPid = process.ppid): ProcRow | null {
  let current = startPid;
  for (let i = 0; i < 30; i++) {
    const row = table.get(current);
    if (!row) return null;
    if (isCodexAppServerProcess(row)) return row;
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
  clientType = CLIENT_TYPE,
): number | null {
  const clientPid = findClientAncestor(table, startPid, clientType);
  if (!clientPid) return null;

  const candidates = descendants(clientPid, table)
    .filter(isPeersServer)
    .filter((row) => row.pid !== process.pid);
  const cwdMatches = candidates.filter((row) => cwdResolver(row.pid) === hookCwd);
  const selected = cwdMatches.length > 0 ? cwdMatches : candidates;
  if (selected.length === 1) return selected[0]!.pid;
  return null;
}

export function findClientPidFromTable(
  table: Map<number, ProcRow>,
  startPid = process.ppid,
  clientType = CLIENT_TYPE,
): number | null {
  return findClientAncestor(table, startPid, clientType);
}

export function findHookPeerPidsFromTable(
  table: Map<number, ProcRow>,
  startPid = process.ppid,
  hookCwd = process.cwd(),
  cwdReader: (pid: number) => string | null = cwdOf,
  clientType = CLIENT_TYPE,
  envPid: number | null = null,
  identityEnvReader: (pid: number) => boolean = hasPeerIdentityEnv,
  ttyReader: (pid: number) => string | null = getTty,
): { primary: number; fallbacks: number[] } | null {
  const hasEnvPid = Number.isInteger(envPid) && envPid > 1;
  let clientPid = findClientAncestor(table, startPid, clientType);
  if (!clientPid && clientType === "codex") {
    const appServer = findCodexAppServerAncestor(table, startPid);
    const visibleCwd = appServer ? (cwdReader(appServer.pid) ?? hookCwd) : hookCwd;
    const visible = findSingleVisibleCodexProcess(table, visibleCwd, {
      cwdOf: cwdReader,
      getTty: ttyReader,
      environOf: (pid) => identityEnvReader(pid) ? { CLAUDE_PEER_NAME: "1" } : {},
    });
    clientPid = visible?.pid ?? null;
  }
  if (!clientPid) {
    if (!hasEnvPid) log(`no ${CLIENT_TYPE} ancestor found`);
    return hasEnvPid ? { primary: envPid!, fallbacks: [] } : null;
  }

  const candidates = descendants(clientPid, table)
    .filter(isPeersServer)
    .filter((row) => row.pid !== process.pid);
  const cwdMatches = candidates.filter((row) => cwdReader(row.pid) === hookCwd);
  const selected = cwdMatches.length > 0 ? cwdMatches : candidates;
  if (selected.length === 1) {
    const mcpPid = selected[0]!.pid;
    const fallbacks = [mcpPid, hasEnvPid ? envPid! : null]
      .filter((pid): pid is number => Number.isInteger(pid) && pid > 1 && pid !== clientPid)
      .filter((pid, index, all) => all.indexOf(pid) === index);
    return { primary: clientPid, fallbacks };
  }
  if (selected.length > 1 && !hasEnvPid) {
    log(`multiple claude-peers MCP candidates: ${selected.map((p) => p.pid).join(",")}`);
  }
  if (hasEnvPid && envPid !== clientPid) return { primary: clientPid, fallbacks: [envPid!] };
  return { primary: clientPid, fallbacks: [] };
}

function findHookPeerPids(): { primary: number; fallbacks: number[] } | null {
  const envPid = Number(process.env.CLAUDE_PEERS_MCP_PID ?? "");
  return findHookPeerPidsFromTable(
    processTable(),
    process.ppid,
    process.cwd(),
    cwdOf,
    CLIENT_TYPE,
    Number.isInteger(envPid) && envPid > 1 ? envPid : null,
  );
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
    throw new BrokerHttpError(path, res.status, err);
  }
  return json as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorBody(error: unknown): string {
  return error instanceof BrokerHttpError ? error.brokerError : errorMessage(error);
}

export function isMissingPeerClaimError(error: unknown): boolean {
  const msg = errorBody(error);
  return /unknown target pid|no peer|peer not found/i.test(msg);
}

export function isMissingClaimEndpointError(error: unknown): boolean {
  if (error instanceof BrokerHttpError) {
    return error.path === "/claim-by-pid" && error.status === 404 && !isMissingPeerClaimError(error);
  }
  const msg = errorMessage(error);
  return /\/claim-by-pid\s+404:\s*(not found)?$/i.test(msg) || /cannot\s+post\s+\/claim-by-pid/i.test(msg);
}

export function shouldSelfRegisterAfterClaimError(error: unknown): boolean {
  return isMissingPeerClaimError(error) && !isMissingClaimEndpointError(error);
}

export async function waitForRegistrationProcess(
  proc: RegistrationProcess,
  timeoutMs = REGISTER_TIMEOUT_MS,
): Promise<{ code: number; stderr: string }> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const stderrPromise = proc.stderr && typeof proc.stderr !== "number"
    ? new Response(proc.stderr).text()
    : Promise.resolve("");
  const completed = Promise.all([proc.exited, stderrPromise]).then(([code, stderr]) => ({ code, stderr }));
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Process may have already exited.
      }
      reject(new Error(`registration timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([completed, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function registerCurrentSessionForDrain(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["bun", REGISTER_SCRIPT], {
      env: { ...process.env, CLAUDE_PEERS_CLIENT_TYPE: CLIENT_TYPE },
      stdout: "ignore",
      stderr: "pipe",
    });
    const { code, stderr } = await waitForRegistrationProcess(proc);
    if (code !== 0) {
      log(`self-registration failed with exit ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
      return false;
    }
    if (/registration failed|unexpected failure|no .* ancestor found/i.test(stderr)) {
      log(`self-registration did not complete cleanly: ${stderr.trim()}`);
      return false;
    }
    return true;
  } catch (e) {
    log(`self-registration failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function heartbeat(pid: number, status: "ok" | "error", drained = 0, error?: string): Promise<void> {
  try {
    await post("/hook-heartbeat-by-pid", {
      pid,
      caller_pid: process.pid,
      client_type: CLIENT_TYPE,
      receiver_mode: RECEIVER_MODE,
      status,
      drained,
      error,
    });
  } catch (e) {
    log(`heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function claim(pid: number, drainId: string): Promise<ClaimResponse> {
  return post("/claim-by-pid", {
    pid,
    caller_pid: process.pid,
    client_type: CLIENT_TYPE,
    receiver_mode: RECEIVER_MODE,
    drain_id: drainId,
    limit: MAX_MESSAGES,
    max_bytes: MAX_BYTES,
  });
}

export async function retryClaimAfterSelfRegistration(options: {
  claimPids: number[];
  drainId: string;
  initialPid: number;
  lastClaimError: string;
  register: () => Promise<boolean>;
  claim: ClaimFn;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{
  claimed: ClaimResponse | null;
  pid: number;
  lastClaimError: string;
  attemptedRegistration: boolean;
  fatalError?: string;
}> {
  let pid = options.initialPid;
  let lastClaimError = options.lastClaimError;
  if (!await options.register()) {
    return { claimed: null, pid, lastClaimError, attemptedRegistration: true };
  }

  await (options.sleep ?? Bun.sleep)(250);
  for (const candidatePid of options.claimPids) {
    pid = candidatePid;
    try {
      return {
        claimed: await options.claim(pid, options.drainId),
        pid,
        lastClaimError,
        attemptedRegistration: true,
      };
    } catch (e) {
      lastClaimError = errorMessage(e);
      if (!shouldSelfRegisterAfterClaimError(e)) {
        return { claimed: null, pid, lastClaimError, attemptedRegistration: true, fatalError: lastClaimError };
      }
    }
  }
  return { claimed: null, pid, lastClaimError, attemptedRegistration: true };
}

// Codex pipes the hook event JSON on stdin. Reading it is best-effort: a
// manual TTY run or an empty pipe must not hang the hook (1.5s race guard).
export async function readHookInput(): Promise<Record<string, unknown> | null> {
  if (process.stdin.isTTY) return null;
  try {
    const text = await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 1500)),
    ]);
    if (!text.trim()) return null;
    return JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    log(`hook input unreadable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function main(): Promise<void> {
  const hookInput = await readHookInput();
  if (HOOK_EVENT_NAME === "Stop") {
    // Stop-event loop guard (official Codex hooks contract): stop_hook_active
    // means this Stop already blocked once without progress — let Codex stop.
    if (hookInput?.stop_hook_active === true) {
      return;
    }
    // Fail CLOSED when the payload could not be read on a piped stdin: a
    // dropped stop_hook_active=true would otherwise re-block a turn we were
    // contractually told to release. Skipping leaves mail for the next
    // UserPromptSubmit / SessionStart drain — nothing is lost.
    if (hookInput === null && !process.stdin.isTTY) {
      log("Stop hook input unreadable — failing closed (no drain, no block)");
      return;
    }
  }

  const pids = findHookPeerPids();
  if (!pids) {
    process.exitCode = 1;
    return;
  }

  const drainId = `${RECEIVER_MODE}:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let claimed: { peer_id?: string; drain_id?: string; messages?: Message[] } | null = null;
  let pid = pids.primary;
  const claimPids = [pids.primary, ...pids.fallbacks].filter((candidate, index, all) => all.indexOf(candidate) === index);
  let lastClaimError = "";
  let sawMissingPeer = false;
  // At SessionStart the peer-register hook and MCP servers launch concurrently
  // with this drain (Codex runs same-event hooks in parallel) — retry
  // peer-not-found briefly instead of giving up on the race.
  const notFoundAttempts = HOOK_EVENT_NAME === "SessionStart" ? 5 : 1;
  for (let attempt = 0; attempt < notFoundAttempts && !claimed; attempt++) {
    if (attempt > 0) await Bun.sleep(600);
    for (const candidatePid of claimPids) {
      pid = candidatePid;
      try {
        claimed = await claim(pid, drainId);
        break;
      } catch (e) {
        const msg = errorMessage(e);
        lastClaimError = msg;
        if (shouldSelfRegisterAfterClaimError(e)) {
          sawMissingPeer = true;
          continue;
        }
        if (isMissingClaimEndpointError(e)) {
          const hint = `${msg}; broker is alive but missing prompt-hook claim support, restart claude-peers-broker`;
          log(`claim failed: ${hint}`);
          await heartbeat(pid, "error", 0, hint);
          return;
        }
        {
          log(`claim failed: ${msg}`);
          await heartbeat(pid, "error", 0, msg);
          return;
        }
      }
    }
  }
  if (!claimed && sawMissingPeer) {
    log("peer row missing during drain; attempting bounded self-registration before one retry");
    const retry = await retryClaimAfterSelfRegistration({
      claimPids,
      drainId,
      initialPid: pid,
      lastClaimError,
      register: registerCurrentSessionForDrain,
      claim,
    });
    pid = retry.pid;
    lastClaimError = retry.lastClaimError;
    claimed = retry.claimed;
    if (retry.fatalError) {
      log(`claim retry failed: ${retry.fatalError}`);
      await heartbeat(pid, "error", 0, retry.fatalError);
      return;
    }
  }
  if (!claimed) {
    log(`claim failed: ${lastClaimError}`);
    await heartbeat(pid, "error", 0, lastClaimError);
    return;
  }

  const messages = claimed.messages ?? [];
  if (messages.length === 0 || !claimed.drain_id) {
    await heartbeat(pid, "ok", 0);
    return;
  }

  const lines = messages.map(renderInboundLine);
  const context = `---\n${messages.length} pending peer message(s):\n\n${lines.join("\n\n")}`;
  // Output shape is event-dependent (official Codex hooks contract): Stop
  // ignores additionalContext / plain stdout, but supports decision:"block"
  // with a reason that is fed back to the model — turn-end delivery. All
  // other events take hookSpecificOutput.additionalContext.
  const output = HOOK_EVENT_NAME === "Stop"
    ? {
      decision: "block",
      reason: `${messages.length} peer message(s) arrived during this turn. Read and handle them before stopping:\n\n${lines.join("\n\n")}`,
    }
    : {
      hookSpecificOutput: {
        hookEventName: HOOK_EVENT_NAME,
        additionalContext: context,
      },
    };

  try {
    await Bun.write(Bun.stdout, `${JSON.stringify(output)}\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`stdout emit failed before ack: ${msg}`);
    await heartbeat(pid, "error", 0, msg);
    process.exitCode = 1;
    return;
  }

  try {
    const ack = await post<AckByPidResponse>("/ack-by-pid", {
      pid,
      caller_pid: process.pid,
      client_type: CLIENT_TYPE,
      receiver_mode: RECEIVER_MODE,
      drain_id: claimed.drain_id,
      ids: messages.map((m) => m.id),
      via: RECEIVER_MODE,
    });
    if (ack.acked !== messages.length) {
      throw new Error(`ack mismatch: expected ${messages.length}, got ${ack.acked ?? 0}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`ack failed after stdout emit: ${msg}`);
    await heartbeat(pid, "error", 0, msg);
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
