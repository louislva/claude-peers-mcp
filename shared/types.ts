// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;
export type ClientType = "claude" | "codex" | "gemini" | "unknown";
export type ReceiverMode = "claude-channel" | "codex-hook" | "gemini-hook" | "manual-drain" | "unknown";

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
  // Hook-only metadata refreshes do not retain the returned token. When true,
  // an existing same-PID row keeps its current token instead of rotating it.
  preserve_token?: boolean;
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

export interface HeartbeatResponse {
  ok: true;
  client_type: ClientType;
  receiver_mode: ReceiverMode;
  // Set true when a NEWER process has registered for this peer's exact tmux seat
  // (same session + pane_id + name, different pid) — i.e. this server has been
  // superseded (its session was `--resume`d / replaced, but this old MCP server
  // kept running). The receiving server must exit cleanly so the seat resolves to
  // a single live registration. One-shot: the broker clears the flag after sending.
  superseded?: true;
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

export interface PeerSelector {
  id?: PeerId;
  // Operator-facing stable seat label, e.g. infra.4. Ambiguous if multiple
  // live peers share it; callers should then choose a returned resolved_name,
  // seat_key, or tmux pane selector.
  name?: string;
  // Broker-unique runtime label, e.g. infra.4#2.
  resolved_name?: string;
  // Human-visible tmux pane coordinate, e.g. "infra:1.2" or "infra 1.2".
  // The MCP server resolves this to tmux_session + tmux_pane_id before it
  // calls the broker; the broker intentionally stores only the stable pane id.
  tmux_target?: string;
  tmux_session?: string;
  tmux_pane_id?: string;
  seat_key?: string;
}

export type PeerResolveErrorCode =
  | "INVALID_SELECTOR"
  | "PEER_NOT_FOUND"
  | "STALE_PEER_ID"
  | "PEER_NOT_LIVE"
  | "AMBIGUOUS_TARGET";

export interface PeerTarget {
  id: PeerId;
  name: string | null;
  resolved_name: string | null;
  seat_key: string;
  cwd: string;
  git_root: string | null;
  tmux_session: string | null;
  tmux_window_index: string | null;
  tmux_window_name: string | null;
  tmux_pane_id: string | null;
  client_type: ClientType;
  receiver_mode: ReceiverMode;
  last_hook_seen_at: string | null;
  last_drain_at: string | null;
  last_drain_error: string | null;
  last_seen: string | null;
}

export interface SendMessageResponse {
  ok: boolean;
  id?: number;
  code?: PeerResolveErrorCode;
  error?: string;
  target?: PeerTarget;
  candidates?: PeerTarget[];
}

export interface SendToPeerRequest {
  from_id: PeerId;
  selector: PeerSelector;
  text: string;
}

export type SendToPeerResponse = SendMessageResponse;

export interface TmuxPaneSnapshot {
  ok: boolean;
  peer_id: PeerId;
  target?: string;
  line_count?: number;
  byte_count?: number;
  truncated?: boolean;
  text?: string;
  error?: string;
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
  client_type?: ClientType;
  receiver_mode?: ReceiverMode;
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
  client_type?: ClientType;
  receiver_mode?: ReceiverMode;
  drain_id: string;
  ids: number[];
  via?: string;
}

export interface HookHeartbeatByPidRequest {
  pid: number;
  caller_pid: number;
  client_type?: ClientType;
  receiver_mode?: ReceiverMode;
  status?: "ok" | "error";
  drained?: number;
  error?: string;
}
