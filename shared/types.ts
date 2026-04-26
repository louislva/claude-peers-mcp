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
  group_name: string | null; // non-null if this message originated from a group send
}

// --- Group / multicast types ---

export interface Group {
  name: string;
  description: string;
  created_at: string; // ISO timestamp
}

export interface GroupMember {
  group_name: string;
  member_cwd: string;
  active_peer_id: PeerId | null; // current session's peer ID, null if offline
  joined_at: string; // ISO timestamp
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
}

export interface PollMessagesResponse {
  messages: Message[];
}

// --- Group broker API types ---

export interface CreateGroupRequest {
  name: string;
  description?: string;
}

export interface JoinGroupRequest {
  group_name: string;
  peer_id: PeerId;
  member_cwd: string;
}

export interface LeaveGroupRequest {
  group_name: string;
  member_cwd: string;
}

export interface ListGroupsRequest {
  member_cwd?: string; // if provided, only return groups this CWD belongs to
}

export interface SendGroupMessageRequest {
  from_id: PeerId;
  group_name: string;
  text: string;
}
