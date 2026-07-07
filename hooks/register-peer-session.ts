#!/usr/bin/env bun
import { closeSync, existsSync, openSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { isClientProcess as sharedIsClientProcess, isCodexAppServerProcess, type ProcessInfo } from "../shared/client.ts";
import {
  brokerIdentityPaneTarget as sharedBrokerIdentityPaneTarget,
  publishBrokerIdentityToTmux as sharedPublishBrokerIdentityToTmux,
  registrationTmuxPaneId as sharedRegistrationTmuxPaneId,
  type TmuxMirrorResult,
} from "../shared/tmux-identity.ts";
import type { ClientType, ReceiverMode, RegisterResponse } from "../shared/types.ts";
import { composeTmuxFromEnv, parsePsTree, parseTmuxPanes, type TmuxPaneInfo } from "../shared/tmux.ts";
import { findSingleVisibleCodexProcess } from "../shared/visible-codex.ts";

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const BROKER_SCRIPT = new URL("../broker.ts", import.meta.url).pathname;
const BROKER_LOG = `${process.env.HOME}/.claude-peers-broker.log`;
const BROKER_LOG_MAX_BYTES = 10 * 1024 * 1024;
const BROKER_SYSTEMD_UNIT_PATH = `${process.env.HOME}/.config/systemd/user/claude-peers-broker.service`;
const SYSTEMD_START_TIMEOUT_SECONDS = "3";
const CLIENT_TYPE: Extract<ClientType, "codex" | "gemini"> =
  process.env.CLAUDE_PEERS_CLIENT_TYPE === "gemini" ? "gemini" : "codex";
const RECEIVER_MODE: Extract<ReceiverMode, "codex-hook" | "gemini-hook"> =
  CLIENT_TYPE === "gemini" ? "gemini-hook" : "codex-hook";

interface RegisterMetadata {
  pid: number;
  cwd: string;
  git_root: string | null;
  absolute_git_dir: string | null;
  tty: string | null;
  name: string;
  tmux: TmuxPaneInfo | null;
  identity_env: Record<string, string | undefined>;
}

function log(msg: string): void {
  console.error(`[claude-peers ${CLIENT_TYPE}-register] ${msg}`);
}

function processTable(): Map<number, ProcessInfo> {
  const table = new Map<number, ProcessInfo>();
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

export function findClientPidFromTable(
  table: Map<number, ProcessInfo>,
  startPid = process.ppid,
  clientType: Extract<ClientType, "codex" | "gemini"> = CLIENT_TYPE,
): number | null {
  let current = startPid;
  for (let i = 0; i < 30; i++) {
    const row = table.get(current);
    if (!row) return null;
    if (sharedIsClientProcess(row, clientType)) {
      if (clientType === "codex" && isCodexAppServerProcess(row)) return null;
      return row.pid;
    }
    if (row.ppid <= 1 || row.ppid === row.pid) return null;
    current = row.ppid;
  }
  return null;
}

function cwdOf(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

async function gitValue(cwd: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    return await proc.exited === 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

async function getGitRoot(cwd: string): Promise<string | null> {
  return gitValue(cwd, ["rev-parse", "--show-toplevel"]);
}

async function getAbsoluteGitDir(cwd: string): Promise<string | null> {
  const bare = await gitValue(cwd, ["rev-parse", "--is-bare-repository"]);
  if (bare === "true") return null;
  return gitValue(cwd, ["rev-parse", "--absolute-git-dir"]);
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

function environOf(pid: number): Record<string, string | undefined> {
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

function findCodexAppServerAncestor(startPid: number, table: Map<number, ProcessInfo>): ProcessInfo | null {
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


function detectTmuxPane(pid: number, env: Record<string, string | undefined> = process.env): TmuxPaneInfo | null {
  try {
    const listProc = Bun.spawnSync([
      "tmux",
      "list-panes",
      "-a",
      "-F",
      "#{pane_pid}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_id}",
    ]);
    if (listProc.exitCode !== 0) return composeTmuxFromEnv(env);
    const paneMap = parseTmuxPanes(new TextDecoder().decode(listProc.stdout));
    const psProc = Bun.spawnSync(["ps", "-eo", "pid,ppid"]);
    if (psProc.exitCode !== 0) return composeTmuxFromEnv(env);
    const ppidMap = parsePsTree(new TextDecoder().decode(psProc.stdout));

    let current = pid;
    for (let i = 0; i < 30; i++) {
      const pane = paneMap.get(current);
      if (pane) return pane;
      const parent = ppidMap.get(current);
      if (parent === undefined || parent <= 1 || parent === current) break;
      current = parent;
    }
  } catch {
    // Fall through to env hints.
  }
  return composeTmuxFromEnv(env);
}

export function registrationTmuxPaneId(tmuxInfo: TmuxPaneInfo | null, env: Record<string, string | undefined> = process.env): string | null {
  return sharedRegistrationTmuxPaneId(tmuxInfo, env);
}

export function brokerIdentityPaneTarget(tmuxInfo: TmuxPaneInfo | null, env: Record<string, string | undefined> = process.env): string | null {
  return sharedBrokerIdentityPaneTarget(tmuxInfo, env);
}

export function publishBrokerIdentityToTmux(identity: {
  id: string;
  name: string | null;
  resolved_name: string | null;
  client_type: ClientType;
  receiver_mode: ReceiverMode;
}, tmuxInfo: TmuxPaneInfo | null, env: Record<string, string | undefined> = process.env): TmuxMirrorResult {
  const result = sharedPublishBrokerIdentityToTmux(identity, tmuxInfo, {
    env,
    writeOperatorLabel: false,
  });
  if (!result.target) return result;
  const displayLabel = identity.name || identity.resolved_name || identity.id;
  const ok = result.failedOptions.length === 0;
  const failed = ok ? "" : ` failed_options=${result.failedOptions.join(",")}`;
  log(`tmux broker identity ${ok ? "mirrored" : "partially failed"} from hook: @peer_id=${identity.id} @peer_label=${displayLabel} (target=${result.target})${failed}`);
  return result;
}

function peerName(clientType: Extract<ClientType, "codex" | "gemini">, pid: number, tmux: TmuxPaneInfo | null, env: Record<string, string | undefined>): string {
  const envName = env.CLAUDE_PEER_NAME?.trim();
  if (envName) return envName;
  if (tmux?.session && tmux.pane_index) return `${tmux.session}.${tmux.pane_index}`;
  if (tmux?.session && tmux.window_index) return `${tmux.session}.${tmux.window_index}`;
  return `${clientType}-${pid}`;
}

async function metadata(): Promise<RegisterMetadata | null> {
  const table = processTable();
  let identityEnv: Record<string, string | undefined> = process.env;
  let pid = findClientPidFromTable(table);
  if (!pid && CLIENT_TYPE === "codex") {
    const appServer = findCodexAppServerAncestor(process.ppid, table);
    const visibleCwdHint = appServer ? (cwdOf(appServer.pid) ?? process.cwd()) : process.cwd();
    const visible = findSingleVisibleCodexProcess(table, visibleCwdHint, { getTty, cwdOf, environOf });
    if (visible) {
      pid = visible.pid;
      identityEnv = visible.env;
      log(`app-server hook identity resolved via visible TTY pid=${pid} cwd=${visibleCwdHint}`);
    }
  }
  if (!pid) {
    log(`no ${CLIENT_TYPE} ancestor found`);
    return null;
  }
  const cwd = cwdOf(pid) ?? process.cwd();
  const tmux = detectTmuxPane(pid, identityEnv);
  return {
    pid,
    cwd,
    git_root: await getGitRoot(cwd),
    absolute_git_dir: await getAbsoluteGitDir(cwd),
    tty: getTty(pid),
    name: peerName(CLIENT_TYPE, pid, tmux, identityEnv),
    tmux,
    identity_env: identityEnv,
  };
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

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

function rotateBrokerLogIfLarge(): void {
  try {
    if (!existsSync(BROKER_LOG)) return;
    if (statSync(BROKER_LOG).size <= BROKER_LOG_MAX_BYTES) return;
    Bun.spawnSync(["mv", "-f", BROKER_LOG, `${BROKER_LOG}.old`]);
  } catch (e) {
    log(`log rotation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function startBrokerViaSystemd(): boolean {
  if (!existsSync(BROKER_SYSTEMD_UNIT_PATH)) return false;
  try {
    const proc = Bun.spawnSync(["timeout", SYSTEMD_START_TIMEOUT_SECONDS, "systemctl", "--user", "start", "claude-peers-broker.service"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) return true;
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    log(`systemd broker start failed; falling back to direct spawn${stderr ? `: ${stderr}` : ""}`);
  } catch (e) {
    log(`systemd broker start failed; falling back to direct spawn: ${e instanceof Error ? e.message : String(e)}`);
  }
  return false;
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) return;
  if (startBrokerViaSystemd()) {
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (await isBrokerAlive()) return;
    }
    log("systemd broker start did not become healthy; falling back to direct spawn");
  }
  rotateBrokerLogIfLarge();
  const logFd = openSync(BROKER_LOG, "a");
  try {
    const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
      stdio: ["ignore", "ignore", logFd],
    });
    proc.unref();
  } finally {
    closeSync(logFd);
  }
  for (let i = 0; i < 15; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await isBrokerAlive()) return;
  }
}

async function main(): Promise<void> {
  const meta = await metadata();
  if (!meta) {
    process.exitCode = 1;
    return;
  }

  try {
    await ensureBroker();
    const reg = await post<RegisterResponse>("/register", {
      pid: meta.pid,
      cwd: meta.cwd,
      git_root: meta.git_root,
      absolute_git_dir: meta.absolute_git_dir,
      tty: meta.tty,
      name: meta.name,
      tmux_session: meta.tmux?.session ?? null,
      tmux_window_index: meta.tmux?.window_index ?? null,
      tmux_window_name: meta.tmux?.window_name ?? null,
      tmux_pane_id: registrationTmuxPaneId(meta.tmux, meta.identity_env),
      client_type: CLIENT_TYPE,
      receiver_mode: RECEIVER_MODE,
      preserve_token: true,
      summary: "",
    });
    publishBrokerIdentityToTmux(reg, meta.tmux, meta.identity_env);
    await post("/hook-heartbeat-by-pid", {
      pid: meta.pid,
      caller_pid: process.pid,
      client_type: CLIENT_TYPE,
      receiver_mode: RECEIVER_MODE,
      status: "ok",
      drained: 0,
    });
    publishBrokerIdentityToTmux({
      ...reg,
      client_type: CLIENT_TYPE,
      receiver_mode: RECEIVER_MODE,
    }, meta.tmux, meta.identity_env);
  } catch (e) {
    process.exitCode = 1;
    log(`registration failed: ${e instanceof Error ? e.message : String(e)}`);
  }

}

if (import.meta.main) {
  main().catch(async (e) => {
    log(`unexpected failure: ${e instanceof Error ? e.message : String(e)}`);
  });
}
