// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;
export type ClientType = "claude" | "codex" | "unknown";
export type ReceiverMode = "claude-channel" | "codex-hook" | "manual-drain" | "unknown";

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  // Single-primitive identity for worktree-aware peer discovery. From
  // `git rev-parse --absolute-git-dir`: returns /repo/.git from main repo OR
  // /repo/.git/worktrees/<name> from a worktree. Broker derives
  // repo_common_root (for scope=repo clustering) and worktree_path lazily.
  // Null when cwd is not in a git repo. Migration adds this column;
  // pre-migration rows have NULL and fall back to git_root for scope matching.
  absolute_git_dir: string | null;
  tty: string | null;
  // Operator-facing seat label. This is stable for humans and is NOT deduped.
  name: string | null;
  // Broker-unique runtime label. May be suffixed when duplicate instances exist.
  resolved_name: string | null;
  tmux_session: string | null;
  tmux_window_index: string | null;
  tmux_window_name: string | null;
  tmux_pane_id: string | null;
  client_type?: ClientType;
  receiver_mode?: ReceiverMode;
  last_hook_seen_at: string | null;
  last_drain_at: string | null;
  last_drain_error: string | null;
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
  // From `git rev-parse --absolute-git-dir` — see Peer.absolute_git_dir.
  // Optional for back-compat with older servers that don't send it; broker
  // stores NULL and falls back to git_root for scope=repo matching.
  absolute_git_dir?: string | null;
  tty: string | null;
  // Operator-facing seat label. This is stable for humans and is NOT deduped.
  name: string | null;
  tmux_session: string | null;
  tmux_window_index: string | null;
  tmux_window_name: string | null;
  tmux_pane_id?: string | null;
  client_type?: ClientType;
  receiver_mode?: ReceiverMode;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
  // S2: per-peer auth token returned at registration. Required as
  // X-Peer-Token header on every subsequent broker call.
  token: string;
  // Operator-facing seat label. This remains the requested name.
  name: string | null;
  // Broker-unique runtime label after dedup. Debug/transport metadata only;
  // human-facing surfaces should prefer `name`.
  resolved_name: string | null;
  client_type: ClientType;
  receiver_mode: ReceiverMode;
}

export interface HeartbeatRequest {
  id: PeerId;
  client_type?: ClientType;
  receiver_mode?: ReceiverMode;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface SetNameRequest {
  id: PeerId;
  // Empty string clears the name.
  name: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  // Optional: caller's `git rev-parse --absolute-git-dir`. When present AND
  // scope=repo, broker derives repo_common_root from this primitive and
  // matches against other peers' derived value (worktree-aware clustering).
  // Falls back to git_root equality when absent.
  absolute_git_dir?: string | null;
  exclude_id?: PeerId;
  // Default false: collapse duplicate/superseded instances and return the
  // active peer per operator seat. True exposes diagnostic raw rows.
  include_inactive?: boolean;
  // R6.2: when true, restrict results to peers with a non-null tmux_session
  // (operator-facing seats). Default false (no filter) — many legitimate
  // operator sessions run bare claude outside tmux (Konsole, VSCode, IDE).
  has_tmux?: boolean;
  // R3: case-insensitive substring match on peer.name. Mirrors the
  // BroadcastRequest.name_like semantics (broker.ts:739-749) — escapes SQL
  // LIKE metachars, requires length >= 2, rejects bare wildcards.
  name_like?: string | null;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface SendMessageResponse {
  ok: boolean;
  id?: number;
  error?: string;
  target?: {
    id: PeerId;
    client_type: ClientType;
    receiver_mode: ReceiverMode;
    last_hook_seen_at: string | null;
    last_drain_error: string | null;
    last_seen: string | null;
  };
}

// /broadcast-message — fanout send by scope. At least one filter is required
// to avoid unbounded global broadcast. Filters AND together.
export interface BroadcastRequest {
  from_id: PeerId;
  text: string;
  tmux_session?: string | null;
  git_root?: string | null;
  name_like?: string | null;     // case-insensitive substring on peer name
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

export interface AckMessagesRequest {
  // Renamed from `peer_id` to `id` for consistency with sibling request types
  // (HeartbeatRequest, SetSummaryRequest, PollMessagesRequest all use `id`).
  id: PeerId;
  // Non-empty list of message IDs to acknowledge as delivered to this peer.
  ids: number[];
  // Delivery-path label forwarded to the broker latency log ("piggyback" via
  // tool-response drain, or "check_messages" via explicit poll). Optional for
  // backward compat with older servers; broker logs "unknown" when absent.
  via?: string;
}

export interface ClaimByPidRequest {
  pid: number;
  caller_pid: number;
  drain_id?: string;
  limit?: number;
  max_bytes?: number;
}

export interface ClaimByPidResponse {
  ok: boolean;
  error?: string;
  status?: number;
  peer_id?: string;
  drain_id?: string;
  messages?: Message[];
}

export interface AckByPidRequest {
  pid: number;
  caller_pid: number;
  drain_id: string;
  ids: number[];
  via?: string;
}

export interface HookHeartbeatByPidRequest {
  pid: number;
  caller_pid: number;
  status?: "ok" | "error";
  drained?: number;
  error?: string;
}
