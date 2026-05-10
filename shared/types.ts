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

export type MessageType =
  | "chat" | "task_complete" | "task_blocked" | "wave_advance" | "status_request" | "status_response"
  | "execute_phase" | "phase_complete" | "phase_blocked" | "phase_progress"
  | "reclaim_task" | "discuss_choice" | "discuss_answer";

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

// BRKR-02: TaskStatus already includes "failed" (see above).
// broker.ts taskCompleteTxn (line ~665) counts failed tasks as terminal:
//   "WHERE wave_id = ? AND status NOT IN ('completed', 'failed')"
// This means a failed task does NOT block wave completion.
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
  // Optional stable id requested by the caller (e.g. external bridges
  // like "telegram"). Must match ^[a-z0-9][a-z0-9_-]*$. Returns 409 if a
  // peer with this id is already registered to a different live PID.
  external_id?: string;
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

export interface ListMessagesRequest {
  limit?: number; // default 50, max 200
}

export interface ListWavesResponse {
  waves: Array<Wave & { task_count: number; tasks_completed: number; tasks_running: number }>;
}

// --- Autonomous peer coordination types ---

export type BlockedReason = "git_conflict" | "file_conflict" | "plan_not_found" | "test_failure" | "dependency_missing" | "permission_denied" | "unknown";

export interface ExecutePhasePayload {
  phase_number: number;
  plan_path: string;
  flags: string;
  wave_id: number;
  task_id: number;
  orchestrator_id: PeerId;
  context_summary?: string;
}

export interface PhaseCompletePayload {
  task_id: number;
  wave_id: number;
  phase_number: number;
  verification: {
    passed: boolean;
    criteria_met: number;
    criteria_total: number;
    gaps: string[];
  };
  commits: string[];
  files_modified: string[];
}

export interface PhaseBlockedPayload {
  task_id: number;
  wave_id: number;
  phase_number: number;
  reason: BlockedReason;
  detail: string;
  tasks_completed: number;
  tasks_total: number;
  recoverable: boolean;
}

export interface PhaseProgressPayload {
  task_id: number;
  wave_id: number;
  phase_number: number;
  tasks_completed: number;
  tasks_total: number;
  last_commit: string;
  current_task: string;
}

export interface StatusRequestPayload {
  task_id: number;
}

export interface StatusResponsePayload {
  task_id: number;
  status: "acknowledged" | "executing" | "completing" | "idle" | "reclaimed";
  tasks_completed: number;
  tasks_total: number;
  current_task: string;
  last_activity: string;
}

export interface ReclaimTaskPayload {
  task_id: number;
  wave_id: number;
  reason: string;
}

export interface DiscussChoicePayload {
  phase_number: number;
  phase_goal: string;
  question: string;
  options: string[];
  recommended: string;
  context: string;
  prior_decisions?: Array<{ phase: number; question: string; chosen: string }>;
}

export interface DiscussAnswerPayload {
  phase_number: number;
  chosen: string;
  reasoning: string;
}

export interface AutonomousPayloadMap {
  execute_phase: ExecutePhasePayload;
  phase_complete: PhaseCompletePayload;
  phase_blocked: PhaseBlockedPayload;
  phase_progress: PhaseProgressPayload;
  status_request: StatusRequestPayload;
  status_response: StatusResponsePayload;
  reclaim_task: ReclaimTaskPayload;
  discuss_choice: DiscussChoicePayload;
  discuss_answer: DiscussAnswerPayload;
}

export type AutonomousMessageType = keyof AutonomousPayloadMap;

export interface AvailablePeer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  summary: string;
  idle_since: string; // ISO timestamp — last_seen or task completion time
}

export interface BusyPeer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  summary: string;
  current_task: string; // task_name from task_assignments
  task_started_at: string; // ISO timestamp
}

export interface PeerAvailabilityRequest {
  repo: string; // git_root for same-repo filtering
  exclude_id?: PeerId; // exclude the requesting peer
}

export interface PeerAvailabilityResponse {
  repo_peers: {
    available: AvailablePeer[];
    busy: BusyPeer[];
  };
  machine_peers: {
    available: AvailablePeer[];
    busy: BusyPeer[];
  };
}
