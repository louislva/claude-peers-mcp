/**
 * claude-peers client SDK
 *
 * Framework-agnostic client for the claude-peers broker.
 * Works with any Node.js/Bun agent: OpenClaw, LangChain, CrewAI, or plain scripts.
 *
 * Usage:
 *   import { PeersClient } from './client.ts';
 *
 *   const peers = new PeersClient({
 *     brokerUrl: 'http://broker:7899',
 *     token: 'your-auth-token',
 *     hostname: 'my-machine',
 *     summary: 'Research agent working on market analysis',
 *   });
 *
 *   await peers.register({ cwd: '/workspace', gitRoot: null });
 *   const others = await peers.listPeers('network');
 *   const repomates = await peers.listPeers('repo', { gitRoot: '/path/to/repo' });
 *   await peers.sendMessage(others[0].id, 'Hey, what are you working on?');
 *   const messages = await peers.pollMessages();
 *
 *   // Auto-heartbeat keeps your registration alive
 *   peers.startHeartbeat();
 *
 *   // Auto-poll checks for messages on an interval and calls your handler
 *   peers.startPolling((msg) => {
 *     console.log(`Message from ${msg.from_id}: ${msg.text}`);
 *   });
 *
 *   // Clean up on exit
 *   peers.shutdown();
 */

import * as os from "node:os";

// --- Types ---

export interface Peer {
  id: string;
  pid: number;
  hostname: string;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string;
  last_seen: string;
}

export interface Message {
  id: number;
  from_id: string;
  to_id: string;
  text: string;
  sent_at: string;
  delivered: boolean;
}

export interface PeersClientOptions {
  /** Broker URL (e.g., http://localhost:7899 or http://broker.cluster:7899) */
  brokerUrl: string;
  /** Auth token (required if broker has CLAUDE_PEERS_TOKEN set) */
  token?: string;
  /** Hostname for this peer (defaults to os.hostname()) */
  hostname?: string;
  /** Summary of what this agent is doing (visible to other peers) */
  summary?: string;
  /** Heartbeat interval in ms (default: 15000) */
  heartbeatIntervalMs?: number;
  /** Poll interval in ms (default: 2000) */
  pollIntervalMs?: number;
}

export interface RegisterOptions {
  /** Working directory */
  cwd: string;
  /** Git root directory (null if not in a git repo) */
  gitRoot?: string | null;
  /** TTY (null for non-interactive agents) */
  tty?: string | null;
  /** PID (defaults to process.pid) */
  pid?: number;
}

// --- Client ---

export class PeersClient {
  private brokerUrl: string;
  private token: string;
  private hostname: string;
  private summary: string;
  private heartbeatMs: number;
  private pollMs: number;

  private peerId: string | null = null;
  private lastRegisterOpts: RegisterOptions | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: PeersClientOptions) {
    this.brokerUrl = options.brokerUrl.replace(/\/$/, "");
    this.token = options.token ?? "";
    this.hostname = options.hostname ?? os.hostname();
    this.summary = options.summary ?? "";
    this.heartbeatMs = options.heartbeatIntervalMs ?? 15_000;
    this.pollMs = options.pollIntervalMs ?? 2_000;
  }

  // --- Core API ---

  /**
   * Register this agent as a peer. Must be called before any other method.
   * Returns the assigned peer ID.
   */
  async register(opts: RegisterOptions): Promise<string> {
    this.lastRegisterOpts = opts;
    const res = await this.post<{ id: string }>("/register", {
      pid: opts.pid ?? process.pid,
      hostname: this.hostname,
      cwd: opts.cwd,
      git_root: opts.gitRoot ?? null,
      tty: opts.tty ?? null,
      summary: this.summary,
    });
    this.peerId = res.id;
    return res.id;
  }

  /**
   * List peers. Scope controls what you see:
   *   - 'machine' — same hostname only
   *   - 'directory' — same working directory (pass cwd in options)
   *   - 'repo' — same git repository (pass gitRoot in options)
   *   - 'network' — all peers across all machines
   */
  async listPeers(
    scope: "machine" | "directory" | "repo" | "network" = "network",
    options?: { cwd?: string; gitRoot?: string | null },
  ): Promise<Peer[]> {
    return this.post<Peer[]>("/list-peers", {
      scope,
      hostname: this.hostname,
      cwd: options?.cwd ?? "/",
      git_root: options?.gitRoot ?? null,
      exclude_id: this.peerId,
    });
  }

  /** Send a message to another peer by ID. */
  async sendMessage(toId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    this.requireRegistered();
    return this.post("/send-message", {
      from_id: this.peerId,
      to_id: toId,
      text,
    });
  }

  /** Poll for new messages. Returns and marks them as delivered. */
  async pollMessages(): Promise<Message[]> {
    this.requireRegistered();
    const res = await this.post<{ messages: Message[] }>("/poll-messages", {
      id: this.peerId,
    });
    return res.messages;
  }

  /** Update your summary (visible to other peers). */
  async setSummary(summary: string): Promise<void> {
    this.requireRegistered();
    this.summary = summary;
    await this.post("/set-summary", { id: this.peerId, summary });
  }

  /** Send a heartbeat to keep your registration alive. Auto-re-registers if the broker lost the peer. */
  async heartbeat(): Promise<void> {
    this.requireRegistered();
    const res = await this.post<{ found: boolean }>("/heartbeat", { id: this.peerId });
    if (!res.found && this.lastRegisterOpts) {
      await this.register(this.lastRegisterOpts);
    }
  }

  /** Unregister from the broker. */
  async unregister(): Promise<void> {
    if (!this.peerId) return;
    await this.post("/unregister", { id: this.peerId }).catch(() => {});
    this.peerId = null;
  }

  /** Check if the broker is reachable. */
  async isAlive(): Promise<boolean> {
    try {
      const res = await fetch(`${this.brokerUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // --- Auto-heartbeat ---

  /** Start automatic heartbeat (keeps registration alive). */
  startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch(() => {});
    }, this.heartbeatMs);
  }

  /** Stop automatic heartbeat. */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // --- Auto-poll ---

  /**
   * Start polling for messages. Calls the handler for each new message.
   * This runs in the background — messages arrive asynchronously.
   */
  startPolling(handler: (msg: Message) => void | Promise<void>): void {
    this.stopPolling();
    this.pollTimer = setInterval(async () => {
      try {
        const messages = await this.pollMessages();
        for (const msg of messages) {
          try {
            await handler(msg);
          } catch {
            // Don't let handler errors crash the poll loop
          }
        }
      } catch {
        // Broker might be down temporarily
      }
    }, this.pollMs);
  }

  /** Stop polling for messages. */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // --- Lifecycle ---

  /** Clean shutdown: stop timers, unregister from broker. */
  async shutdown(): Promise<void> {
    this.stopHeartbeat();
    this.stopPolling();
    await this.unregister();
  }

  /** Get the current peer ID (null if not registered). */
  get id(): string | null {
    return this.peerId;
  }

  /**
   * Reconnect with a known peer ID (e.g., after broker restart).
   * Skips registration — use when you already have a valid ID.
   */
  reconnect(id: string): void {
    this.peerId = id;
  }

  // --- Internals ---

  private requireRegistered(): void {
    if (!this.peerId) {
      throw new Error("Not registered. Call register() first.");
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    const res = await fetch(`${this.brokerUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Broker error (${path}): ${res.status} ${err}`);
    }
    return res.json() as Promise<T>;
  }
}
