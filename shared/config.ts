/**
 * Centralized configuration loader.
 *
 * Resolution order: env var > settings file > default.
 *
 * Settings file location:
 *   - Linux/macOS: $XDG_CONFIG_HOME/claude-peers/config.json
 *                  (default: ~/.config/claude-peers/config.json)
 *   - Windows:     %APPDATA%\claude-peers\config.json
 *
 * Settings file is JSON, all keys optional. See README for full schema.
 */

import { join, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type { GroupId } from "./types.ts";

export type SummaryProvider = "auto" | "anthropic" | "openai-compat" | "none";

export interface Config {
  /** Broker HTTP port. */
  port: number;
  /** SQLite DB path (broker side). */
  db: string;
  /** SSH target for client.ts: "user@host[:port]". */
  remote: string | null;
  /** Path to server.ts on the remote host. */
  remote_server_path: string;
  /** Extra SSH options (passed as raw argv to ssh). */
  ssh_opts: string[];
  /** Auto-summary provider selection. "auto" resolves at call time. */
  summary_provider: SummaryProvider;
  /** Override base URL for openai-compat (e.g. LiteLLM/Ollama proxy). */
  summary_base_url: string | null;
  /** Override API key for the summary provider. */
  summary_api_key: string | null;
  /** Model name passed to the summary provider. */
  summary_model: string;
  /** v0.3 -- map of logical group name -> group secret. Empty means no groups configured. */
  groups: Record<string, string>;
  /** v0.3 -- default group name to use when no project file overrides. null means fall through to env then 'default' sentinel. */
  default_group: string | null;
  /** HTTP mode: direct broker URL (e.g. "http://my-server:7899"). Overrides loopback. */
  broker_url: string | null;
  /** HTTP mode: Bearer token required by the broker. Sent on all HTTP and WS-upgrade requests. */
  broker_token: string | null;
  /** Broker bind host. null = "127.0.0.1" (loopback only). Set "0.0.0.0" for public access. */
  bind_host: string | null;
}

interface FileConfig {
  port?: number;
  db?: string;
  remote?: string;
  remote_server_path?: string;
  ssh_opts?: string[];
  summary_provider?: SummaryProvider;
  summary_base_url?: string;
  summary_api_key?: string;
  summary_model?: string;
  // Backward-compat alias for summary_model when provider is anthropic.
  anthropic_model?: string;
  groups?: Record<string, string>;
  default_group?: string;
  broker_url?: string;
  broker_token?: string;
  bind_host?: string;
}

const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

function settingsFilePath(): string {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    if (appdata) {
      return join(appdata, "claude-peers", "config.json");
    }
    return join(homedir(), "AppData", "Roaming", "claude-peers", "config.json");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    return join(xdg, "claude-peers", "config.json");
  }
  return join(homedir(), ".config", "claude-peers", "config.json");
}

async function readFileConfig(): Promise<FileConfig> {
  const path = settingsFilePath();
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return {};
    }
    const data = (await file.json()) as FileConfig;
    return data ?? {};
  } catch {
    return {};
  }
}

function defaultDbPath(): string {
  if (process.platform === "linux" || process.platform === "darwin") {
    return process.env.CLAUDE_PEERS_DB ?? "/var/lib/claude-peers/peers.db";
  }
  return join(homedir(), ".claude-peers.db");
}

function parseSshOpts(value: string | undefined): string[] | null {
  if (!value) return null;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseProvider(value: string | undefined): SummaryProvider | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v === "auto" || v === "anthropic" || v === "openai-compat" || v === "none") {
    return v;
  }
  return null;
}

/**
 * Load configuration. Tolerant of missing file. Always returns a complete Config.
 */
export async function loadConfig(): Promise<Config> {
  const fileCfg = await readFileConfig();

  const port = parseInt(
    process.env.CLAUDE_PEERS_PORT ?? String(fileCfg.port ?? 7899),
    10
  );

  const db = process.env.CLAUDE_PEERS_DB ?? fileCfg.db ?? defaultDbPath();

  const remote = process.env.CLAUDE_PEERS_REMOTE ?? fileCfg.remote ?? null;

  const remote_server_path =
    process.env.CLAUDE_PEERS_REMOTE_SERVER_PATH ??
    fileCfg.remote_server_path ??
    "/srv/claude-peers/server.ts";

  const ssh_opts =
    parseSshOpts(process.env.CLAUDE_PEERS_SSH_OPTS) ??
    fileCfg.ssh_opts ??
    [];

  const summary_provider: SummaryProvider =
    parseProvider(process.env.CLAUDE_PEERS_SUMMARY_PROVIDER) ??
    fileCfg.summary_provider ??
    "auto";

  const summary_base_url =
    process.env.CLAUDE_PEERS_SUMMARY_BASE_URL ??
    fileCfg.summary_base_url ??
    null;

  const summary_api_key =
    process.env.CLAUDE_PEERS_SUMMARY_API_KEY ??
    fileCfg.summary_api_key ??
    null;

  // Backward-compat: CLAUDE_PEERS_ANTHROPIC_MODEL and `anthropic_model` key.
  const summary_model =
    process.env.CLAUDE_PEERS_SUMMARY_MODEL ??
    process.env.CLAUDE_PEERS_ANTHROPIC_MODEL ??
    fileCfg.summary_model ??
    fileCfg.anthropic_model ??
    DEFAULT_ANTHROPIC_MODEL;

  const groups: Record<string, string> = fileCfg.groups ?? {};
  const default_group = fileCfg.default_group ?? null;
  const broker_url = process.env.CLAUDE_PEERS_BROKER_URL ?? fileCfg.broker_url ?? null;
  const broker_token = process.env.CLAUDE_PEERS_BROKER_TOKEN ?? fileCfg.broker_token ?? null;
  const bind_host = process.env.CLAUDE_PEERS_BIND_HOST ?? fileCfg.bind_host ?? null;

  return {
    port,
    db,
    remote,
    remote_server_path,
    ssh_opts,
    summary_provider,
    summary_base_url,
    summary_api_key,
    summary_model,
    groups,
    default_group,
    broker_url,
    broker_token,
    bind_host,
  };
}

/**
 * Resolve the effective provider, taking "auto" into account.
 *
 * Auto-detection priority:
 *   1. summary_base_url defined  -> openai-compat
 *   2. summary_api_key OR ANTHROPIC_API_KEY defined -> anthropic
 *   3. otherwise -> none (heuristic only)
 */
export function resolveProvider(config: Config): Exclude<SummaryProvider, "auto"> {
  if (config.summary_provider !== "auto") return config.summary_provider;
  if (config.summary_base_url) return "openai-compat";
  if (config.summary_api_key || process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "none";
}

/**
 * Build the broker URL from the resolved config.
 * If broker_url is set, use it directly (HTTP mode). Otherwise, loopback.
 */
export function brokerUrl(config: Config): string {
  if (config.broker_url) return config.broker_url;
  return `http://127.0.0.1:${config.port}`;
}

// --- v0.3: group resolution ---

const PROJECT_FILE = ".claude-peers.json";
const PROJECT_LOCAL_FILE = ".claude-peers.local.json";

/**
 * Read a project file (.claude-peers.json or .local.json) and return the validated `group` field.
 * Returns null if the file doesn't exist, is malformed, or has no `group` field.
 * Logs a warning on stderr if the file contains unknown fields (rejects them but keeps `group`).
 */
function readProjectFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      console.error(`[claude-peers] ${path}: expected JSON object, ignoring`);
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const allowedKeys = new Set(["group"]);
    for (const key of Object.keys(obj)) {
      if (!allowedKeys.has(key)) {
        console.error(`[claude-peers] ${path}: unknown field '${key}' (only 'group' is allowed), ignoring`);
      }
    }
    const group = obj.group;
    if (typeof group !== "string" || group.length === 0) return null;
    return group;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[claude-peers] failed to read ${path}: ${msg}`);
    return null;
  }
}

/**
 * Walk upwards from `start` to find a file named `filename`, stopping at the boundary
 * (`gitRoot` parent if provided, otherwise filesystem root). Returns the path or null.
 */
function findUpwards(start: string, filename: string, gitRoot: string | null): string | null {
  let current = start;
  let prev: string | null = null;
  const stopAt = gitRoot ? dirname(gitRoot) : null;
  while (current !== prev) {
    const candidate = join(current, filename);
    if (existsSync(candidate)) return candidate;
    if (stopAt !== null && current === gitRoot) {
      // Walked up to git_root; check it then stop.
      return null;
    }
    prev = current;
    current = dirname(current);
    // dirname of root returns the same path, terminating the loop.
    if (stopAt !== null && current === stopAt) {
      // Don't walk above git_root's parent.
      return null;
    }
  }
  return null;
}

/**
 * Resolve the effective group name for a given cwd.
 * Order (first wins):
 *   1. .claude-peers.local.json (walking up to git_root)
 *   2. .claude-peers.json       (walking up to git_root)
 *   3. user config `default_group`
 *   4. env var CLAUDE_PEERS_GROUP
 *   5. sentinel 'default'
 */
export function resolveGroupName(
  cwd: string,
  gitRoot: string | null,
  userConfig: Pick<Config, "default_group">
): string {
  const localFile = findUpwards(cwd, PROJECT_LOCAL_FILE, gitRoot);
  if (localFile) {
    const name = readProjectFile(localFile);
    if (name) return name;
  }
  const projectFile = findUpwards(cwd, PROJECT_FILE, gitRoot);
  if (projectFile) {
    const name = readProjectFile(projectFile);
    if (name) return name;
  }
  if (userConfig.default_group) return userConfig.default_group;
  const envGroup = process.env.CLAUDE_PEERS_GROUP;
  if (envGroup && envGroup.length > 0) return envGroup;
  return "default";
}

/**
 * Look up a group secret by name in the user config. Returns null if the name
 * is the literal sentinel 'default', or if the name is not defined in the dictionary.
 * Logs a warning on stderr in the latter case so the user understands the fallback.
 */
export function resolveGroupSecret(
  name: string,
  userConfig: Pick<Config, "groups">
): string | null {
  if (name === "default") return null;
  const secret = userConfig.groups[name];
  if (typeof secret === "string" && secret.length > 0) return secret;
  console.error(
    `[claude-peers] group '${name}' resolved but no secret defined in user config; falling back to 'default'`
  );
  return null;
}

/**
 * Compute the group_id from a secret. The 'default' sentinel returns 'default'.
 * Otherwise: sha256(secret) hex, truncated to 32 chars (matches the spec section 4.5).
 */
export function computeGroupId(secret: string | null): GroupId {
  if (secret === null) return "default";
  return createHash("sha256").update(secret, "utf-8").digest("hex").slice(0, 32);
}

/**
 * Compute the full sha256 hex of a secret, used by the broker for TOFU validation.
 * null secret -> null (the 'default' group has secret_hash NULL in SQL).
 */
export function computeGroupSecretHash(secret: string | null): string | null {
  if (secret === null) return null;
  return createHash("sha256").update(secret, "utf-8").digest("hex");
}

/**
 * One-shot helper: resolve the group from cwd/gitRoot and produce all artefacts
 * needed for the handshake.
 */
export function resolveGroup(
  cwd: string,
  gitRoot: string | null,
  userConfig: Pick<Config, "groups" | "default_group">
): { name: string; group_id: GroupId; group_secret_hash: string | null; groups_map: Record<string, GroupId> } {
  const name = resolveGroupName(cwd, gitRoot, userConfig);
  const secret = resolveGroupSecret(name, userConfig);
  const group_id = computeGroupId(secret);
  const group_secret_hash = computeGroupSecretHash(secret);

  // Build the public name -> group_id map (no secrets) for server.ts inversion.
  const groups_map: Record<string, GroupId> = { default: "default" };
  for (const [n, s] of Object.entries(userConfig.groups)) {
    groups_map[n] = computeGroupId(s);
  }

  return { name, group_id, group_secret_hash, groups_map };
}
