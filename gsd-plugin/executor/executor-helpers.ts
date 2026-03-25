/**
 * executor-helpers.ts
 *
 * All executor protocol functions for the GSD peer executor agent lifecycle.
 * Implements: ACK, setup (git pull, plan read, conflict check), progress reporting,
 * completion, blocked reporting, status response, reclaim handling, push jitter,
 * and the no-transition guard.
 */

import { join } from "node:path";
import type {
  PeerId,
  PhaseCompletePayload,
  PhaseBlockedPayload,
  PhaseProgressPayload,
  StatusResponsePayload,
  ReclaimTaskPayload,
} from "../../shared/types.ts";

// --- Configuration ---

const BROKER_PORT = process.env.CLAUDE_PEERS_PORT ?? "7899";
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

// --- Internal broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

// --- Helper: read stdout from a spawned process ---

async function readProcessOutput(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
  if (!proc.stdout) return "";
  const reader = proc.stdout.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks)).trim();
}

// --- Exported executor protocol functions ---

/**
 * EXEC-01: ACK an execute_phase message by sending status_response with status "acknowledged"
 */
export async function sendAck(
  myId: PeerId,
  orchestratorId: PeerId,
  taskId: number,
  phaseNumber: number
): Promise<void> {
  const payload: StatusResponsePayload = {
    task_id: taskId,
    status: "acknowledged",
    tasks_completed: 0,
    tasks_total: 0,
    current_task: "setup",
    last_activity: new Date().toISOString(),
  };
  await brokerFetch("/send-message", {
    from_id: myId,
    to_id: orchestratorId,
    text: `Received phase ${phaseNumber}, starting setup`,
    msg_type: "status_response",
    payload,
  });
}

/**
 * EXEC-02 (part 1): Run git pull --rebase and report git_conflict on failure
 */
export async function gitPullRebase(
  cwd: string,
  branch: string
): Promise<{ ok: boolean; error?: string }> {
  const proc = Bun.spawn(["git", "pull", "--rebase", "origin", branch], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode === 0) {
    return { ok: true };
  }
  const error = await readProcessOutput(proc);
  return { ok: false, error };
}

/**
 * EXEC-02 (part 2): Read a plan file and validate its path starts with .planning/phases/
 */
export async function readPlanFile(
  planPath: string,
  cwd: string
): Promise<{ ok: boolean; content?: string; error?: string }> {
  if (!planPath.startsWith(".planning/phases/")) {
    return {
      ok: false,
      error: "Invalid plan path: must start with .planning/phases/",
    };
  }
  const fullPath = join(cwd, planPath);
  const file = Bun.file(fullPath);
  const exists = await file.exists();
  if (!exists) {
    return { ok: false, error: `Plan file not found: ${planPath}` };
  }
  const content = await file.text();
  return { ok: true, content };
}

/**
 * EXEC-02 (part 3): Call /conflict-check and report file_conflict on overlap
 */
export async function checkConflicts(
  waveId: number,
  files: string[]
): Promise<{
  ok: boolean;
  conflicts?: Array<{ task_id: number; task_name: string; conflicting_files: string[] }>;
}> {
  const result = await brokerFetch<{
    conflicts: Array<{ task_id: number; task_name: string; conflicting_files: string[] }>;
  }>("/conflict-check", { wave_id: waveId, files });
  if (result.conflicts.length === 0) {
    return { ok: true };
  }
  return { ok: false, conflicts: result.conflicts };
}

/**
 * EXEC-03: Send phase_progress with tasks_completed, tasks_total, last_commit
 */
export async function sendProgress(
  myId: PeerId,
  orchestratorId: PeerId,
  payload: PhaseProgressPayload
): Promise<void> {
  await brokerFetch("/send-message", {
    from_id: myId,
    to_id: orchestratorId,
    text: `Task ${payload.tasks_completed}/${payload.tasks_total} complete`,
    msg_type: "phase_progress",
    payload,
  });
}

/**
 * EXEC-04: Send phase_complete with verification, commits, files_modified
 */
export async function sendPhaseComplete(
  myId: PeerId,
  orchestratorId: PeerId,
  payload: PhaseCompletePayload
): Promise<void> {
  await brokerFetch("/send-message", {
    from_id: myId,
    to_id: orchestratorId,
    text: `Phase ${payload.phase_number} complete`,
    msg_type: "phase_complete",
    payload,
  });
}

/**
 * EXEC-05: Send phase_blocked with one of seven BlockedReason categories
 */
export async function sendPhaseBlocked(
  myId: PeerId,
  orchestratorId: PeerId,
  payload: PhaseBlockedPayload
): Promise<void> {
  await brokerFetch("/send-message", {
    from_id: myId,
    to_id: orchestratorId,
    text: `Phase ${payload.phase_number} blocked: ${payload.reason}`,
    msg_type: "phase_blocked",
    payload,
  });
}

/**
 * EXEC-06: Respond to status_request with current execution state
 */
export async function sendStatusResponse(
  myId: PeerId,
  orchestratorId: PeerId,
  payload: StatusResponsePayload
): Promise<void> {
  await brokerFetch("/send-message", {
    from_id: myId,
    to_id: orchestratorId,
    text: `Status: ${payload.status}`,
    msg_type: "status_response",
    payload,
  });
}

/**
 * EXEC-08: Push to git with random 0-3s jitter to avoid simultaneous push conflicts.
 * On rejection, performs a rebase and retries once more with jitter.
 */
export async function gitPushWithJitter(
  cwd: string,
  branch: string
): Promise<{ ok: boolean; error?: string }> {
  // First jitter
  const jitterMs = Math.random() * 3000;
  await new Promise((r) => setTimeout(r, jitterMs));

  // First push attempt
  const proc1 = Bun.spawn(["git", "push", "origin", branch], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode1 = await proc1.exited;
  if (exitCode1 === 0) {
    return { ok: true };
  }

  // Push failed — try rebase
  const rebaseProc = Bun.spawn(["git", "pull", "--rebase", "origin", branch], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const rebaseExit = await rebaseProc.exited;
  if (rebaseExit !== 0) {
    return { ok: false, error: "Rebase failed after push rejection" };
  }

  // Second jitter before retry
  const jitterMs2 = Math.random() * 3000;
  await new Promise((r) => setTimeout(r, jitterMs2));

  // Retry push
  const proc2 = Bun.spawn(["git", "push", "origin", branch], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode2 = await proc2.exited;
  if (exitCode2 === 0) {
    return { ok: true };
  }
  const error = await readProcessOutput(proc2);
  return { ok: false, error };
}

/**
 * EXEC-07: Handle reclaim_task — commit WIP, push, and return to idle
 */
export async function handleReclaim(
  myId: PeerId,
  orchestratorId: PeerId,
  payload: ReclaimTaskPayload,
  cwd: string,
  branch: string,
  tasksCompleted: number,
  tasksTotal: number
): Promise<void> {
  // Stage all changes
  const addProc = Bun.spawn(["git", "add", "-A"], { cwd });
  await addProc.exited;

  // WIP commit
  const commitProc = Bun.spawn(
    [
      "git",
      "commit",
      "-m",
      `WIP: reclaimed by orchestrator -- ${payload.reason}`,
      "--allow-empty",
    ],
    { cwd }
  );
  await commitProc.exited;

  // Push with jitter (best effort — ignore result)
  await gitPushWithJitter(cwd, branch).catch(() => undefined);

  // Get HEAD SHA
  const shaProc = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd,
    stdout: "pipe",
  });
  await shaProc.exited;
  const _sha = await readProcessOutput(shaProc);

  // Send reclaimed status response
  const statusPayload: StatusResponsePayload = {
    task_id: payload.task_id,
    status: "reclaimed",
    tasks_completed: tasksCompleted,
    tasks_total: tasksTotal,
    current_task: "reclaimed",
    last_activity: new Date().toISOString(),
  };
  await sendStatusResponse(myId, orchestratorId, statusPayload);
}

/**
 * EXEC-09: Skip writes to ROADMAP.md and STATE.md when --no-transition flag is set
 */
export function shouldSkipWrite(filePath: string, flags: string): boolean {
  if (!flags.includes("--no-transition")) {
    return false;
  }
  return filePath.endsWith("ROADMAP.md") || filePath.endsWith("STATE.md");
}

/**
 * Call /task-start to assign this session to a task
 */
export async function callTaskStart(
  taskId: number,
  sessionId: string
): Promise<void> {
  await brokerFetch("/task-start", { task_id: taskId, session_id: sessionId });
}

/**
 * Call /task-complete to mark a task done (auto-completes wave if all done)
 */
export async function callTaskComplete(
  taskId: number
): Promise<{ ok: boolean; wave_completed: boolean }> {
  return brokerFetch<{ ok: boolean; wave_completed: boolean }>("/task-complete", {
    task_id: taskId,
  });
}

/**
 * Call /task-blocked to mark a task blocked with a reason
 */
export async function callTaskBlocked(
  taskId: number,
  reason: string
): Promise<void> {
  await brokerFetch("/task-blocked", { task_id: taskId, reason });
}
