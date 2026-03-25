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

export type MessageType = "chat" | "task_complete" | "task_blocked" | "wave_advance" | "status_request" | "status_response";

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  msg_type: MessageType;
  payload: string; // JSON string
  sent_at: string; // ISO timestamp
  delivered: number; // 0 = undelivered, 1 = delivered (SQLite INTEGER)
  delivered_at: string | null;
}

export interface Session {
  session_id: string;
  peer_id: PeerId;
  cwd: string;
  git_root: string | null;
  task_summary: string;
  status: "active" | "stuck" | "completed";
  registered_at: string;
  last_tool_use: string;
}

export type WaveStatus = "pending" | "running" | "completed" | "failed";

export interface Wave {
  id: number;
  repo: string;
  phase: number;
  wave_number: number;
  status: WaveStatus;
  created_at: string;
  completed_at: string | null;
}

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "blocked";

export interface TaskAssignment {
  id: number;
  wave_id: number;
  session_id: string | null;
  task_name: string;
  files: string; // JSON array of file paths
  status: TaskStatus;
  blocked_by: number | null;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
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
  msg_type?: MessageType;
  payload?: Record<string, unknown>;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}
