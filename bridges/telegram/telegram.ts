#!/usr/bin/env bun
/**
 * Telegram ↔ gsd-comms bridge daemon.
 *
 * Long-running process. Registers with the broker as the stable peer
 * `telegram` (via /register external_id), long-polls Telegram for incoming
 * commands, and forwards outbound messages from other peers to Telegram.
 *
 * Run:
 *   bun bridges/telegram/telegram.ts          # start the daemon
 *   bun bridges/telegram/telegram.ts --help   # print usage
 *
 * Credentials live OUTSIDE the repo at:
 *   $XDG_CONFIG_HOME/gsd-comms/telegram/telegram.env
 *   (fallback: ~/.config/gsd-comms/telegram/telegram.env)
 *
 * State (offset, active target) lives at the same directory in state.json.
 *
 * See bridges/common.ts for the BrokerClient + BridgeRunner abstractions —
 * a future bridge can be modelled on this file.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  BridgeRunner,
  BrokerClient,
  BrokerError,
} from "../common.ts";
import type { Message, Peer } from "../../shared/types.ts";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp(): void {
  process.stdout.write(`Usage: bun bridges/telegram/telegram.ts [--help]

Long-running daemon that bridges Telegram ↔ the gsd-comms broker. It
registers as the stable peer "telegram" so Claude sessions can address it
via send_message(to_id="telegram", ...). Telegram messages from the owner
chat are forwarded to a chosen Claude peer.

Telegram commands (must come from the configured TELEGRAM_CHAT_ID):
  /say <text>             send <text> to the active Claude target
  /say @<peer-id> <text>  send <text> to a specific peer
  /peers                  list active Claude peers
  /target @<peer-id>      set the default /say target
  /target                 show the current active target
  /help                   show this message

Credentials (required):
  Read from $XDG_CONFIG_HOME/gsd-comms/telegram/telegram.env
  (fallback: ~/.config/gsd-comms/telegram/telegram.env). It is a plain
  KEY=value file with two variables:
    - TELEGRAM_BOT_TOKEN   the bot token from @BotFather
    - TELEGRAM_CHAT_ID     your Telegram user id (from any "raw" bot)

State:
  Offset and active target are persisted (atomic tmp+rename) at
  $XDG_CONFIG_HOME/gsd-comms/telegram/state.json.

Setup:
  1. Create a bot via @BotFather and copy its token.
  2. Send any message to your bot from Telegram so a private chat exists.
  3. mkdir -p ~/.config/gsd-comms/telegram && chmod 700 ~/.config/gsd-comms/telegram
  4. Write the two variables above into telegram.env (chmod 600).
  5. bun bridges/telegram/telegram.ts
`);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Config / state paths
// ---------------------------------------------------------------------------

const CONFIG_HOME =
  process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
    ? process.env.XDG_CONFIG_HOME
    : path.join(homedir(), ".config");
const CONFIG_DIR = path.join(CONFIG_HOME, "gsd-comms", "telegram");
const ENV_PATH = path.join(CONFIG_DIR, "telegram.env");
const STATE_PATH = path.join(CONFIG_DIR, "state.json");
// Repo-local fallback for development convenience. Gitignored at three
// levels (root .gitignore, secrets/.gitignore, pre-commit hook).
const REPO_FALLBACK_ENV = path.join(import.meta.dir, "secrets", "telegram.env");

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function parseEnvFile(filePath: string): Record<string, string> {
  const text = readFileSync(filePath, "utf8");
  const env: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return env;
}

function loadCreds(): { token: string; chatId: string } {
  let envPath: string | null = null;
  if (existsSync(ENV_PATH)) envPath = ENV_PATH;
  else if (existsSync(REPO_FALLBACK_ENV)) envPath = REPO_FALLBACK_ENV;

  if (!envPath) {
    process.stderr.write(
      `[bridge:telegram] missing credentials at ${ENV_PATH}\n` +
        `Create the file (chmod 600) with TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID,\n` +
        `or run with --help for full setup instructions.\n`
    );
    process.exit(2);
  }

  const env = parseEnvFile(envPath);
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    process.stderr.write(
      `[bridge:telegram] ${envPath} missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID\n`
    );
    process.exit(2);
  }
  return { token, chatId };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface BridgeState {
  telegram_offset: number;
  active_target: string | null;
  last_seen_peers: string[];
  registered_at: string;
}

function defaultState(): BridgeState {
  return {
    telegram_offset: 0,
    active_target: null,
    last_seen_peers: [],
    registered_at: new Date().toISOString(),
  };
}

function loadState(): BridgeState {
  if (!existsSync(STATE_PATH)) return defaultState();
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<BridgeState>;
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

function saveState(state: BridgeState): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, STATE_PATH);
}

// ---------------------------------------------------------------------------
// Telegram client (thin wrapper)
// ---------------------------------------------------------------------------

const TELEGRAM_API = "https://api.telegram.org";
const MAX_TELEGRAM_TEXT = 4000; // hard limit is 4096; leave room for the footer
const TRUNCATE_FOOTER = "\n\n... [truncated]";

interface TelegramResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  from?: { id: number; is_bot?: boolean; username?: string };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

class TelegramClient {
  constructor(private readonly token: string) {}

  private async call<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    init: RequestInit = {}
  ): Promise<TelegramResponse<T>> {
    const url = `${TELEGRAM_API}/bot${this.token}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      ...init,
    });
    return (await res.json()) as TelegramResponse<T>;
  }

  async getMe(): Promise<TelegramResponse<{ username: string; first_name: string }>> {
    return this.call("getMe", {});
  }

  /** Long-poll for updates. timeout is in seconds (Telegram API). */
  async getUpdates(
    offset: number,
    timeoutSec: number,
    signal?: AbortSignal
  ): Promise<TelegramResponse<TelegramUpdate[]>> {
    return this.call(
      "getUpdates",
      {
        offset,
        timeout: timeoutSec,
        allowed_updates: ["message"],
      },
      { signal }
    );
  }

  async sendMessage(chatId: string, text: string): Promise<TelegramResponse<TelegramMessage>> {
    const trimmed =
      text.length <= MAX_TELEGRAM_TEXT ? text : text.slice(0, MAX_TELEGRAM_TEXT) + TRUNCATE_FOOTER;
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text: trimmed,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatBrokerMessage(msg: Message, fromPeer?: Peer): string {
  const subtitle =
    fromPeer?.summary?.trim() ||
    fromPeer?.cwd ||
    msg.from_id;
  return (
    `<b>${escapeHtml(msg.from_id)}</b> · ${escapeHtml(subtitle)}\n\n` +
    escapeHtml(msg.text)
  );
}

// ---------------------------------------------------------------------------
// Fuzzy peer lookup (handles lookalike chars typed on mobile)
// ---------------------------------------------------------------------------

/** Normalize a peer ID for fuzzy comparison: 0→o, 1→l, i→l */
function normalizeId(id: string): string {
  return id.toLowerCase().replace(/0/g, "o").replace(/[1i]/g, "l");
}

function findPeer(peers: Peer[], mention: string): Peer | null {
  const exact = peers.find((p) => p.id === mention);
  if (exact) return exact;
  const norm = normalizeId(mention);
  return peers.find((p) => normalizeId(p.id) === norm) ?? null;
}

// ---------------------------------------------------------------------------
// Default target heuristic
// ---------------------------------------------------------------------------

function pickDefaultTarget(peers: Peer[], bridgePeerId: string): Peer | null {
  const candidates = peers.filter((p) => p.id !== bridgePeerId);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
  return candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// Command parser
// ---------------------------------------------------------------------------

interface ParsedCommand {
  cmd: string;
  /** First word after the command if it looked like @peer-id, else null. */
  targetMention: string | null;
  /** Remaining argument text (after the command and optional @peer-id). */
  arg: string;
}

const PEER_MENTION_RE = /^@([a-z0-9][a-z0-9_-]*)$/i;

function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  // Strip @botname suffix on the command itself: "/say@gsd_comms_bot args"
  const firstSpace = trimmed.search(/\s/);
  const head = firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace);
  const tail = firstSpace < 0 ? "" : trimmed.slice(firstSpace + 1).trimStart();
  const cmd = head.split("@")[0]!.toLowerCase();

  // Optional first @peer-id token in the argument area.
  let targetMention: string | null = null;
  let arg = tail;
  if (tail.startsWith("@")) {
    const space = tail.search(/\s/);
    const candidate = space < 0 ? tail : tail.slice(0, space);
    const m = candidate.match(PEER_MENTION_RE);
    if (m) {
      targetMention = m[1]!;
      arg = space < 0 ? "" : tail.slice(space + 1).trimStart();
    }
  }

  return { cmd, targetMention, arg };
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

const BRIDGE_EXTERNAL_ID = "telegram";
const BRIDGE_SUMMARY = "Telegram bridge";

const HELP_TEXT = `<b>Telegram ↔ Claude commands</b>

<code>/say &lt;text&gt;</code> — send to the active Claude target
<code>/say @&lt;peer-id&gt; &lt;text&gt;</code> — send to a specific peer
<code>/peers</code> — list active Claude peers (numbered, ★ = active target)
<code>/target @&lt;peer-id&gt;</code> — set the default /say target
<code>/target &lt;number&gt;</code> — set target by /peers index (e.g. /target 2)
<code>/target</code> — show the current active target
<code>/ping</code> — test end-to-end delivery to the active target
<code>/help</code> — this message`;

async function main(): Promise<void> {
  const { token, chatId } = loadCreds();
  const tg = new TelegramClient(token);

  // Sanity-check the bot token before doing anything else.
  const me = await tg.getMe();
  if (!me.ok || !me.result) {
    process.stderr.write(
      `[bridge:telegram] getMe failed: ${me.description ?? JSON.stringify(me)}\n` +
        `Check that TELEGRAM_BOT_TOKEN is correct (~/.config/gsd-comms/telegram/telegram.env).\n`
    );
    process.exit(2);
  }
  console.error(
    `[bridge:telegram] authenticated as @${me.result.username} (${me.result.first_name})`
  );

  const broker = new BrokerClient();

  // Sanity-check broker reachability so the user sees a clear error if
  // the broker isn't running before we try to register.
  try {
    await broker.health();
  } catch (e) {
    process.stderr.write(
      `[bridge:telegram] broker not reachable at ${broker.brokerUrl}: ${
        e instanceof Error ? e.message : String(e)
      }\n` +
        `Start it with: bun broker.ts\n`
    );
    process.exit(2);
  }

  const state = loadState();
  state.registered_at = new Date().toISOString();
  saveState(state);

  const runner = new BridgeRunner({
    client: broker,
    externalId: BRIDGE_EXTERNAL_ID,
    summary: BRIDGE_SUMMARY,
    onMessage: async (msg) => {
      // Look up the sender for a friendlier formatted reply (best-effort).
      let from: Peer | undefined;
      try {
        const peers = await broker.listPeers({ scope: "machine" });
        from = peers.find((p) => p.id === msg.from_id);
      } catch {
        // Non-fatal; format with bare from_id.
      }
      const formatted = formatBrokerMessage(msg, from);
      const res = await tg.sendMessage(chatId, formatted);
      if (!res.ok) {
        throw new Error(
          `Telegram sendMessage failed (${res.error_code ?? "?"}): ${res.description ?? "unknown"}`
        );
      }
    },
  });

  try {
    await runner.start();
  } catch (e) {
    if (e instanceof BrokerError && e.status === 409) {
      process.stderr.write(
        `[bridge:telegram] another bridge is already registered as "${BRIDGE_EXTERNAL_ID}".\n` +
          `Stop the other instance (or call /unregister with that id) before retrying.\n`
      );
      process.exit(2);
    }
    throw e;
  }

  // Telegram poll loop ----------------------------------------------------

  let stopping = false;
  let inflightAbort: AbortController | null = null;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`[bridge:telegram] received ${signal}, stopping Telegram loop`);
    inflightAbort?.abort();
    // BridgeRunner installs its own signal handlers and will unregister;
    // we just need to drop out of the long-poll.
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  while (!stopping) {
    inflightAbort = new AbortController();
    let res: TelegramResponse<TelegramUpdate[]>;
    try {
      res = await tg.getUpdates(state.telegram_offset, 30, inflightAbort.signal);
    } catch (e) {
      if (stopping) break;
      console.error(
        `[bridge:telegram] getUpdates error: ${e instanceof Error ? e.message : String(e)}`
      );
      // Back off briefly before retrying so we don't busy-loop on persistent errors.
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    } finally {
      inflightAbort = null;
    }

    if (!res.ok) {
      console.error(
        `[bridge:telegram] getUpdates returned ok=false: ${res.description ?? JSON.stringify(res)}`
      );
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }

    for (const upd of res.result ?? []) {
      if (upd.update_id >= state.telegram_offset) {
        state.telegram_offset = upd.update_id + 1;
      }
      const msg = upd.message;
      if (!msg) continue;
      const incomingChat = String(msg.chat?.id ?? "");
      const text = msg.text ?? "";
      if (incomingChat !== chatId) {
        console.error(
          `[bridge:telegram] ignoring message from foreign chat_id ${incomingChat}`
        );
        continue;
      }
      if (!text) continue;

      try {
        const reply = await handleCommand(text, runner, broker, state, tg, chatId);
        if (reply !== null) {
          await tg.sendMessage(chatId, reply);
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error(`[bridge:telegram] dispatch error: ${errMsg}`);
        await tg.sendMessage(chatId, `⚠️ command error: ${escapeHtml(errMsg)}`);
      }
    }

    saveState(state);
  }

  await runner.stop();
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

async function handleCommand(
  text: string,
  runner: BridgeRunner,
  broker: BrokerClient,
  state: BridgeState,
  _tg: TelegramClient,
  _chatId: string
): Promise<string | null> {
  const parsed = parseCommand(text);
  if (!parsed) return null; // ignore non-commands (no reply)

  const peers = await broker.listPeers({ scope: "machine" });
  state.last_seen_peers = peers.map((p) => p.id);

  switch (parsed.cmd) {
    case "/help":
    case "/start":
      return HELP_TEXT;

    case "/peers":
      return formatPeerList(peers, runner.id ?? BRIDGE_EXTERNAL_ID, state.active_target);

    case "/target":
      return handleTarget(parsed, peers, runner.id ?? BRIDGE_EXTERNAL_ID, state);

    case "/say":
      return await handleSay(parsed, peers, runner, state);

    case "/ping":
      return await handlePing(peers, runner, state);

    default:
      return `Unknown command: ${escapeHtml(parsed.cmd)}\nTry /help`;
  }
}

function formatPeerList(peers: Peer[], bridgePeerId: string, activeTarget: string | null): string {
  const others = peers.filter((p) => p.id !== bridgePeerId);
  if (others.length === 0) {
    return "(no other Claude peers registered)";
  }
  const lines = others.map((p, i) => {
    const summary = p.summary?.trim() || p.cwd || "(no summary)";
    const tty = p.tty ? ` [${p.tty}]` : "";
    const star = p.id === activeTarget ? " ★" : "";
    return `${i + 1}. <code>${escapeHtml(p.id)}</code>${tty}${star}\n   ${escapeHtml(summary)}`;
  });
  return `<b>Active peers</b>\n${lines.join("\n")}`;
}

function handleTarget(
  parsed: ParsedCommand,
  peers: Peer[],
  bridgePeerId: string,
  state: BridgeState
): string {
  // Accept peer ID with or without leading @, or a 1-based index from /peers
  const mention = parsed.targetMention ?? (parsed.arg.trim() || null);
  if (!mention) {
    if (state.active_target) {
      const peer = peers.find((p) => p.id === state.active_target);
      const summary = peer?.summary?.trim() || peer?.cwd || "";
      return `Active target: <code>${escapeHtml(state.active_target)}</code>${summary ? `\n${escapeHtml(summary)}` : ""}`;
    }
    const fallback = pickDefaultTarget(peers, bridgePeerId);
    return fallback
      ? `No explicit target set. Default would be <code>${escapeHtml(fallback.id)}</code> (most recently active).`
      : `No active target set, and no other Claude peers are currently registered.`;
  }

  // Numeric index (e.g. /target 2)
  const others = peers.filter((p) => p.id !== bridgePeerId);
  const idx = /^\d+$/.test(mention) ? parseInt(mention, 10) - 1 : -1;
  let found: Peer | null = null;
  if (idx >= 0 && idx < others.length) {
    found = others[idx]!;
  } else {
    found = findPeer(peers, mention);
  }

  if (!found) {
    return `Peer <code>${escapeHtml(mention)}</code> is not registered. Use /peers to list active peers.`;
  }
  state.active_target = found.id;
  saveState(state);
  const summary = found.summary?.trim() || found.cwd || "";
  return `Active target set to <code>${escapeHtml(found.id)}</code>${summary ? `\n${escapeHtml(summary)}` : ""}`;
}

async function handleSay(
  parsed: ParsedCommand,
  peers: Peer[],
  runner: BridgeRunner,
  state: BridgeState
): Promise<string> {
  if (!parsed.arg.trim()) {
    return "Usage: /say [@peer-id] &lt;text&gt;";
  }

  const bridgeId = runner.id ?? BRIDGE_EXTERNAL_ID;
  let target: Peer | null = null;

  if (parsed.targetMention) {
    target = findPeer(peers, parsed.targetMention);
    if (!target) {
      return `Peer <code>${escapeHtml(parsed.targetMention)}</code> is not registered. Use /peers to list active peers.`;
    }
  } else if (state.active_target) {
    const cached = peers.find((p) => p.id === state.active_target);
    if (cached) {
      target = cached;
    } else {
      // Cached target gone; fall through to most-recent heuristic.
      state.active_target = null;
    }
  }

  if (!target) {
    target = pickDefaultTarget(peers, bridgeId);
    if (!target) {
      return "No Claude peers are currently registered.";
    }
    state.active_target = target.id;
    saveState(state);
  }

  const result = await runner.send({ toId: target.id, text: parsed.arg });
  if (!result.ok) {
    return `⚠️ send failed: ${escapeHtml(result.error ?? "unknown error")}`;
  }
  const summary = target.summary?.trim() || target.cwd || "";
  return `→ <code>${escapeHtml(target.id)}</code>${summary ? `\n${escapeHtml(summary)}` : ""}`;
}

async function handlePing(
  peers: Peer[],
  runner: BridgeRunner,
  state: BridgeState
): Promise<string> {
  const bridgeId = runner.id ?? BRIDGE_EXTERNAL_ID;
  const target = state.active_target
    ? (peers.find((p) => p.id === state.active_target) ?? null)
    : pickDefaultTarget(peers, bridgeId);

  if (!target) {
    return "No active target for /ping. Set one with /target @peer-id first.";
  }

  const t0 = Date.now();
  const sent = await runner.send({
    toId: target.id,
    text: "🏓 ping from Telegram — reply with send_message to confirm delivery",
    msgType: "ping",
  });
  if (!sent.ok) {
    return `⚠️ ping failed: ${escapeHtml(sent.error ?? "unknown")}`;
  }
  const ms = Date.now() - t0;
  const summary = target.summary?.trim() || target.cwd || "";
  return (
    `🏓 ping → <code>${escapeHtml(target.id)}</code> (broker accepted in ${ms}ms)` +
    (summary ? `\n${escapeHtml(summary)}` : "") +
    `\nA reply from Claude will appear here when the channel push surfaces.`
  );
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error(
    `[bridge:telegram] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`
  );
  process.exit(1);
});
