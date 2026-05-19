// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
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

export interface PollMessagesRequest {
  id: PeerId;
  /**
   * Set to true by MCP server clients that implement /ack-messages. When
   * true, the broker uses the new at-least-once delivery semantics:
   * messages stay delivered=0 until explicitly acked, with a per-message
   * polled_at lease that allows retry on push failure. When omitted (old
   * clients), the broker falls back to legacy at-most-once: messages are
   * marked delivered=1 immediately on poll, with the original silent-loss
   * risk on push failure — but no duplicate-storm during a rollout where
   * old MCP server subprocesses outlive a broker upgrade.
   */
  ack_supported?: boolean;
  /**
   * Passive observer mode used by bridge sidecars. When true with
   * read_only=true, the broker returns messages across peers instead of only
   * messages addressed to id.
   */
  subscribe_all?: boolean;
  /**
   * Read-only polls never mark messages delivered and never claim the shared
   * polled_at lease. This lets observers mirror traffic without stealing it
   * from the actual recipient.
   */
  read_only?: boolean;
}

export interface PollMessagesResponse {
  messages: Message[];
}

export interface AckMessagesRequest {
  id: PeerId;
  message_ids: number[];
}
