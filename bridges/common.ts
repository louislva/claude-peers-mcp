/**
 * Shared building blocks for gsd-comms-mcp bridges.
 *
 * A "bridge" is a long-running daemon that registers as a stable peer with
 * the broker (via /register external_id) and shuttles messages between the
 * broker and an external system (Telegram, webhooks, IRC, ...).
 *
 * BrokerClient — typed wrapper over the broker's JSON HTTP API.
 * BridgeRunner — lifecycle manager: register on start, poll + ack loop,
 *                heartbeat, graceful unregister on SIGINT/SIGTERM.
 *
 * Telegram is the first concrete consumer; future bridges should be able
 * to drive this module without modifying it.
 */

import type {
  Message,
  Peer,
  PollMessagesResponse,
  ListPeersRequest,
  RegisterResponse,
} from "../shared/types.ts";

// ---------------------------------------------------------------------------
// BrokerClient
// ---------------------------------------------------------------------------

const DEFAULT_BROKER_URL =
  process.env.CLAUDE_PEERS_BROKER_URL ??
  `http://127.0.0.1:${process.env.CLAUDE_PEERS_PORT ?? "7899"}`;

export interface BrokerClientOptions {
  brokerUrl?: string;
}

export class BrokerError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string
  ) {
    super(`[broker ${path}] ${status}: ${message}`);
    this.name = "BrokerError";
  }
}

export class BrokerClient {
  readonly brokerUrl: string;

  constructor(opts: BrokerClientOptions = {}) {
    this.brokerUrl = opts.brokerUrl ?? DEFAULT_BROKER_URL;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.brokerUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const j = (await res.json()) as { error?: string };
        if (j?.error) msg = j.error;
      } catch {
        // body was not JSON; fall back to statusText
      }
      throw new BrokerError(res.status, path, msg);
    }
    return res.json() as Promise<T>;
  }

  async health(): Promise<{ status: string; peers: number }> {
    const res = await fetch(`${this.brokerUrl}/health`);
    if (!res.ok) {
      throw new BrokerError(res.status, "/health", res.statusText);
    }
    return res.json() as Promise<{ status: string; peers: number }>;
  }

  async register(input: {
    externalId: string;
    summary: string;
    pid?: number;
    cwd?: string;
    gitRoot?: string | null;
    tty?: string | null;
  }): Promise<RegisterResponse> {
    return this.post<RegisterResponse>("/register", {
      pid: input.pid ?? process.pid,
      cwd: input.cwd ?? process.cwd(),
      git_root: input.gitRoot ?? null,
      tty: input.tty ?? null,
      summary: input.summary,
      external_id: input.externalId,
    });
  }

  async unregister(id: string): Promise<void> {
    await this.post<{ ok: boolean }>("/unregister", { id });
  }

  async heartbeat(id: string): Promise<void> {
    await this.post<{ ok: boolean }>("/heartbeat", { id });
  }

  async setSummary(id: string, summary: string): Promise<void> {
    await this.post<{ ok: boolean }>("/set-summary", { id, summary });
  }

  async sendMessage(input: {
    fromId: string;
    toId: string;
    text: string;
    msgType?: string;
    payload?: Record<string, unknown>;
  }): Promise<{ ok: boolean; error?: string }> {
    return this.post<{ ok: boolean; error?: string }>("/send-message", {
      from_id: input.fromId,
      to_id: input.toId,
      text: input.text,
      msg_type: input.msgType,
      payload: input.payload,
    });
  }

  async pollMessages(id: string): Promise<Message[]> {
    const r = await this.post<PollMessagesResponse>("/poll-messages", { id });
    return r.messages;
  }

  async ackMessages(messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) return;
    await this.post<{ ok: boolean }>("/ack-message", { message_ids: messageIds });
  }

  async listPeers(input: {
    scope: ListPeersRequest["scope"];
    cwd?: string;
    gitRoot?: string | null;
    excludeId?: string;
  }): Promise<Peer[]> {
    return this.post<Peer[]>("/list-peers", {
      scope: input.scope,
      cwd: input.cwd ?? process.cwd(),
      git_root: input.gitRoot ?? null,
      exclude_id: input.excludeId,
    });
  }
}

// ---------------------------------------------------------------------------
// BridgeRunner
// ---------------------------------------------------------------------------

export type LogLevel = "info" | "warn" | "error";
export type LogFn = (level: LogLevel, msg: string, extra?: unknown) => void;

export interface BridgeRunnerOptions {
  client: BrokerClient;
  /** Stable bridge id (e.g. "telegram"). Must match ^[a-z0-9][a-z0-9_-]*$. */
  externalId: string;
  /** Short human-readable summary shown in /list-peers. */
  summary: string;
  /**
   * Called for every inbound broker message addressed to this bridge.
   * Resolve to ACK; throw to re-deliver on the next poll.
   */
  onMessage: (msg: Message) => Promise<void> | void;
  /** Default 2000ms. */
  pollIntervalMs?: number;
  /** Default 15000ms. */
  heartbeatIntervalMs?: number;
  /** Override default stderr logger. */
  log?: LogFn;
  /** cwd reported to broker (defaults to process.cwd()). */
  cwd?: string;
  /** gitRoot reported to broker (defaults to null — bridges aren't repo-scoped). */
  gitRoot?: string | null;
}

export class BridgeRunner {
  private peerId: string | null = null;
  private stopped = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private signalHandlersInstalled = false;

  private readonly client: BrokerClient;
  private readonly externalId: string;
  private readonly summary: string;
  private readonly onMessage: BridgeRunnerOptions["onMessage"];
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly logFn: LogFn;
  private readonly cwd: string;
  private readonly gitRoot: string | null;

  constructor(opts: BridgeRunnerOptions) {
    this.client = opts.client;
    this.externalId = opts.externalId;
    this.summary = opts.summary;
    this.onMessage = opts.onMessage;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 15_000;
    this.cwd = opts.cwd ?? process.cwd();
    this.gitRoot = opts.gitRoot ?? null;
    this.logFn =
      opts.log ??
      ((level, msg, extra) => {
        const tag = `[bridge:${this.externalId}]`;
        const line =
          extra === undefined
            ? `${tag} ${msg}`
            : `${tag} ${msg} ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
        // Keep stdout clean for bridges that print structured output.
        console.error(level === "info" ? line : `${level.toUpperCase()} ${line}`);
      });
  }

  get id(): string | null {
    return this.peerId;
  }

  /**
   * Register with the broker, start the poll + heartbeat loops, install
   * signal handlers. Returns the broker peer id (will equal externalId on
   * success).
   */
  async start(): Promise<string> {
    const reg = await this.client.register({
      externalId: this.externalId,
      summary: this.summary,
      cwd: this.cwd,
      gitRoot: this.gitRoot,
    });
    this.peerId = reg.id;
    this.logFn("info", `registered as peer "${reg.id}"`);
    this.installSignalHandlers();
    this.scheduleHeartbeat();
    this.schedulePoll();
    return reg.id;
  }

  /**
   * Send a message from this bridge peer to another peer.
   * Throws if start() has not yet completed.
   */
  async send(input: {
    toId: string;
    text: string;
    msgType?: string;
    payload?: Record<string, unknown>;
  }): Promise<{ ok: boolean; error?: string }> {
    if (!this.peerId) {
      throw new Error("BridgeRunner.send() called before start() completed");
    }
    return this.client.sendMessage({
      fromId: this.peerId,
      toId: input.toId,
      text: input.text,
      msgType: input.msgType,
      payload: input.payload,
    });
  }

  /**
   * Stop the loops and unregister from the broker. Idempotent.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.peerId) {
      try {
        await this.client.unregister(this.peerId);
        this.logFn("info", `unregistered peer "${this.peerId}"`);
      } catch (e) {
        this.logFn("warn", `unregister failed: ${formatErr(e)}`);
      }
    }
  }

  private scheduleHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (this.stopped || !this.peerId) return;
      this.client.heartbeat(this.peerId).catch((e) =>
        this.logFn("warn", `heartbeat failed: ${formatErr(e)}`)
      );
    }, this.heartbeatIntervalMs);
  }

  private schedulePoll() {
    const tick = async () => {
      if (this.stopped || !this.peerId) return;
      try {
        const messages = await this.client.pollMessages(this.peerId);
        const acked: number[] = [];
        for (const msg of messages) {
          try {
            await this.onMessage(msg);
            acked.push(msg.id);
          } catch (e) {
            this.logFn(
              "error",
              `onMessage failed for message ${msg.id}; will retry: ${formatErr(e)}`
            );
            // Skip ack so the broker re-delivers next poll.
          }
        }
        if (acked.length > 0) {
          await this.client.ackMessages(acked);
        }
      } catch (e) {
        this.logFn("warn", `poll failed: ${formatErr(e)}`);
      } finally {
        if (!this.stopped) {
          this.pollTimer = setTimeout(tick, this.pollIntervalMs);
        }
      }
    };
    this.pollTimer = setTimeout(tick, 0);
  }

  private installSignalHandlers() {
    if (this.signalHandlersInstalled) return;
    this.signalHandlersInstalled = true;
    const handle = (signal: string) => {
      this.logFn("info", `received ${signal}, shutting down...`);
      this.stop()
        .catch((e) => this.logFn("warn", `stop() failed: ${formatErr(e)}`))
        .finally(() => process.exit(0));
    };
    process.once("SIGINT", () => handle("SIGINT"));
    process.once("SIGTERM", () => handle("SIGTERM"));
  }
}

function formatErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
