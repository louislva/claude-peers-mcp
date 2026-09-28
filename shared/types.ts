// Unique ID for each peer instance (generated on registration)
export type PeerId = string;

// Which AI coding agent is behind this peer
export type ClientType = "claude-code" | "codex" | "cli";

// --- Transport configuration ---

export const DEFAULT_SOCKET_PATH =
  process.env.CLAUDE_PEERS_SOCKET ?? `${process.env.HOME}/.claude/run/claude-peers.sock`;

// How the broker wakes an idle or busy agent when a message arrives.
// claude_inbox: Claude Code's per-session socket; codex_queue: `codex queue --thread`.
export type WakeTransport = "claude_inbox" | "codex_queue";

// queued: handed to the harness; failed: definitely not delivered; ambiguous: unknown
// (timeout after submitting); coalesced: a wake for the current unread batch is outstanding.
export type WakeStatus = "queued" | "failed" | "ambiguous" | "coalesced" | "none";

// Public peer shape: wake address and secret never leave the broker.
export interface Peer {
  id: PeerId;
  pid: number;
  agent_pid: number | null;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  client_type: ClientType;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
  wake_transport: WakeTransport | null;
  last_wake_status: WakeStatus | null;
  last_wake_at: string | null; // ISO timestamp
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean; // true once the recipient acknowledged it
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  agent_pid?: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  client_type?: ClientType;
  summary: string;
  wake_transport?: WakeTransport;
  wake_address?: string;
  wake_secret?: string;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface SendMessageResponse {
  ok: boolean;
  error?: string;
  wake?: { transport: WakeTransport | null; status: WakeStatus };
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

export interface AckMessagesRequest {
  id: PeerId;
  message_ids: number[];
}

export interface AckMessagesResponse {
  acked: number;
}

export interface SetWakeRequest {
  agent_pid: number;
  transport: WakeTransport;
  address: string;
}

export interface SetWakeResponse {
  ok: boolean;
  updated?: number;
  error?: string;
}

export interface UnreadSummaryRequest {
  agent_pid: number;
}

export interface UnreadSummaryResponse {
  count: number;
  senders: PeerId[];
  peer_ids: PeerId[];
}
