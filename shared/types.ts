// --- Identity primitives (v0.3) ---

// Display name for a peer, mutable via set_id, unique per (peer_id, group_id).
export type PeerId = string;

// UUID v4 routing token, immutable for the lifetime of a peer row.
// Used as primary key, foreign key in messages, key in wsPool, key in peer_sessions.
export type InstanceToken = string;

// 32-hex-char identifier derived from sha256(group_secret).slice(0, 32),
// or the literal sentinel 'default' when no secret is configured.
export type GroupId = string;

// --- Domain entities ---

export interface Peer {
  instance_token: InstanceToken;
  peer_id: PeerId;
  group_id: GroupId;
  pid: number; // PID of the bun server.ts process (always local to the broker host)
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
  host: string; // Client hostname (from handshake)
  client_pid: number; // Client-side PID (Claude Code)
  project_key: string | null; // Normalized git remote URL
  status: PeerStatus;
  last_activity_at: string | null; // ISO timestamp of last message sent or received
  activity_status: ActivityStatus;  // computed by broker, not stored
}

export type PeerStatus = "active" | "dormant";
export type ActivityStatus = "active" | "sleep" | "closed";

export interface Message {
  id: number;
  from_token: InstanceToken;
  to_token: InstanceToken;
  group_id: GroupId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

// Broker-internal row representations (used by SQL queries, not the public API).

export interface GroupRow {
  group_id: GroupId;
  secret_hash: string | null; // NULL for the 'default' group (no auth)
  name: string | null;
  created_at: string;
}

export interface PeerSessionRow {
  session_key: string; // sha256(host || \0 || cwd || \0 || group_id)
  instance_token: InstanceToken;
  group_id: GroupId;
  host: string;
  cwd: string;
  last_active_at: string;
}

// --- Handshake (client.ts -> server.ts via stdin first line) ---

export interface ClientMeta {
  host: string;
  client_pid: number;
  cwd: string;
  git_root: string | null;
  git_branch: string | null;
  recent_files: string[];
  project_key: string | null;
  tty: string | null;

  // v0.3: group identity, computed client-side (secret never leaves the PC).
  group_id: GroupId;
  group_secret_hash: string | null; // sha256(secret) full hex, or null for 'default'

  // v0.3: name -> group_id mapping so server.ts can invert for whoami / list_groups
  // without seeing the user's secrets. Keys are user config group names.
  groups_map: Record<string, GroupId>;
}

// --- Broker API: requests ---

export interface RegisterRequest {
  pid: number; // pid of the bun server.ts process (local to broker)
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  host: string;
  client_pid: number;
  project_key: string | null;
  group_id: GroupId;
  group_secret_hash: string | null;
}

export interface RegisterResponse {
  peer_id: PeerId;
  instance_token: InstanceToken;
}

export interface HeartbeatRequest {
  instance_token: InstanceToken;
}

export interface SetSummaryRequest {
  instance_token: InstanceToken;
  summary: string;
}

export interface DisconnectRequest {
  instance_token: InstanceToken;
}

export interface UnregisterRequest {
  instance_token: InstanceToken;
}

export interface SetIdRequest {
  instance_token: InstanceToken;
  new_peer_id: PeerId;
}

export interface SetIdResponse {
  peer_id: PeerId;
  previous: PeerId;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's identity. group_id is resolved server-side from instance_token.
  instance_token: InstanceToken;
  cwd: string;
  git_root: string | null;
  project_key?: string | null;
}

export interface SendMessageRequest {
  from_token: InstanceToken;
  to_peer_id: PeerId; // resolved against the sender's group_id by the broker
  text: string;
}

export interface SendMessageResponse {
  ok: boolean;
  error?: string;
}

export interface PollMessagesRequest {
  instance_token: InstanceToken;
}

export interface PollMessagesResponse {
  messages: Message[];
}

// --- Broker API: groups and identity introspection ---

export interface GroupStatsRow {
  group_id: GroupId;
  active_peers: number;
}

export interface GroupStatsResponse {
  groups: GroupStatsRow[];
}

export interface WhoamiResponse {
  peer_id: PeerId;
  host: string;
  client_pid: number;
  cwd: string;
  git_root: string | null;
  project_key: string | null;
  group_name: string;
  summary: string;
  registered_at: string;
  ws_connected: boolean;
}

export interface ListGroupsEntry {
  name: string;
  active_peers: number;
}

export interface ListGroupsResponse {
  current: string;
  available: ListGroupsEntry[];
}

// --- WebSocket frames (loopback ws://127.0.0.1:<port>/ws) ---

export interface WsAuthFrame {
  type: "auth";
  instance_token: InstanceToken;
}

export interface WsMessageFrame {
  type: "message";
  id: number;
  from_peer_id: PeerId;
  from_summary: string;
  from_host: string;
  from_cwd: string;
  text: string;
  sent_at: string;
}

export type WsFrame = WsAuthFrame | WsMessageFrame;
