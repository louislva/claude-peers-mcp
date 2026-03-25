/**
 * autonomous-peers-runtime.ts
 *
 * Standalone runtime module: Kahn's topological sort (buildExecutionWaves)
 * and the wave polling loop (waitForWaveComplete).
 * Independently unit-testable without importing orchestrator-helpers.ts.
 *
 * NOTE: brokerFetch is intentionally duplicated per established per-module
 * self-contained pattern. Do not import from other helper modules.
 */

import type {
  PeerId,
  PhaseCompletePayload,
  PhaseBlockedPayload,
  PhaseProgressPayload,
  StatusResponsePayload,
  ReclaimTaskPayload,
  Wave,
  TaskAssignment,
  PollMessagesResponse,
} from "../shared/types.ts";

// --- Configuration ---

const BROKER_PORT = process.env.CLAUDE_PEERS_PORT ?? "7899";
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

// --- Internal broker communication ---
// NOTE: brokerFetch is intentionally duplicated from executor-helpers.ts, proxy-helpers.ts,
// and orchestrator-helpers.ts. Do not import from those modules — each helper module is self-contained.

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

// --- Exported types ---

/**
 * Represents a phase from ROADMAP.md with dependency and file conflict metadata.
 */
export interface PhaseNode {
  number: number;
  name: string;
  dir: string;
  dependencies: number[];
  status: "pending" | "completed";
  filesModified: string[];
}

// --- Exported runtime functions ---

/**
 * ORCH-04: Group pending phases into execution waves using Kahn's topological sort.
 *
 * - Completed phases are filtered out (their dependencies are already satisfied)
 * - Phases whose dependencies are all completed (or have no deps) form Wave 1
 * - Subsequent waves contain phases whose pending dependencies have all been "released"
 * - Throws if a dependency cycle is detected
 *
 * @param phases - Array of PhaseNode objects (may include completed phases)
 * @returns Array of waves, each wave being an array of PhaseNode (can run in parallel)
 */
export function buildExecutionWaves(phases: PhaseNode[]): PhaseNode[][] {
  // Only schedule pending phases
  const pending = phases.filter((p) => p.status === "pending");
  const completedNumbers = new Set(
    phases.filter((p) => p.status === "completed").map((p) => p.number)
  );
  const pendingNumbers = new Set(pending.map((p) => p.number));

  // Build in-degree map: count dependencies that are ALSO pending (not yet satisfied)
  const inDegree = new Map<number, number>();
  // Build dependents map: pendingDep -> [phase numbers that depend on it]
  const dependents = new Map<number, number[]>();

  for (const phase of pending) {
    inDegree.set(phase.number, 0);
    dependents.set(phase.number, dependents.get(phase.number) ?? []);
  }

  for (const phase of pending) {
    for (const dep of phase.dependencies) {
      if (pendingNumbers.has(dep)) {
        // Dependency is also pending — must run before this phase
        inDegree.set(phase.number, (inDegree.get(phase.number) ?? 0) + 1);
        const depList = dependents.get(dep) ?? [];
        depList.push(phase.number);
        dependents.set(dep, depList);
      }
      // Completed deps are already satisfied — they don't count toward in-degree
    }
  }

  const phaseByNumber = new Map(pending.map((p) => [p.number, p]));
  const waves: PhaseNode[][] = [];
  let released = new Set<number>();

  // Seed the first wave: phases with in-degree 0
  let currentWave = pending.filter((p) => (inDegree.get(p.number) ?? 0) === 0);

  while (currentWave.length > 0) {
    waves.push(currentWave);
    const nextWaveNumbers = new Set<number>();

    for (const phase of currentWave) {
      released.add(phase.number);
      for (const dependent of dependents.get(phase.number) ?? []) {
        const newDegree = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          nextWaveNumbers.add(dependent);
        }
      }
    }

    currentWave = [...nextWaveNumbers].map((n) => phaseByNumber.get(n)!).filter(Boolean);
  }

  // Cycle detection: if any pending phases were not released, they form a cycle
  const unreleased = pending.filter((p) => !released.has(p.number));
  if (unreleased.length > 0) {
    const cyclePhaseList = unreleased.map((p) => `Phase ${p.number}`).join(", ");
    throw new Error(
      `Dependency cycle detected in ROADMAP.md: phases [${cyclePhaseList}] form a cycle`
    );
  }

  return waves;
}

/**
 * ORCH-07: Poll the orchestrator's message queue and categorize messages by type.
 *
 * Does NOT ACK messages — caller decides when to ACK after processing.
 * This mirrors the proxy pollForChoices pattern.
 *
 * @param myId - Orchestrator peer ID
 */
export async function pollOrchestratorMessages(myId: PeerId): Promise<{
  progresses: Array<{ msgId: number; payload: PhaseProgressPayload }>;
  completions: Array<{ msgId: number; payload: PhaseCompletePayload }>;
  blocks: Array<{ msgId: number; payload: PhaseBlockedPayload }>;
  statusResponses: Array<{ msgId: number; payload: StatusResponsePayload }>;
}> {
  const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

  const progresses: Array<{ msgId: number; payload: PhaseProgressPayload }> = [];
  const completions: Array<{ msgId: number; payload: PhaseCompletePayload }> = [];
  const blocks: Array<{ msgId: number; payload: PhaseBlockedPayload }> = [];
  const statusResponses: Array<{ msgId: number; payload: StatusResponsePayload }> = [];

  for (const msg of result.messages) {
    switch (msg.msg_type) {
      case "phase_progress":
        progresses.push({ msgId: msg.id, payload: JSON.parse(msg.payload) as PhaseProgressPayload });
        break;
      case "phase_complete":
        completions.push({ msgId: msg.id, payload: JSON.parse(msg.payload) as PhaseCompletePayload });
        break;
      case "phase_blocked":
        blocks.push({ msgId: msg.id, payload: JSON.parse(msg.payload) as PhaseBlockedPayload });
        break;
      case "status_response":
        statusResponses.push({ msgId: msg.id, payload: JSON.parse(msg.payload) as StatusResponsePayload });
        break;
    }
  }

  return { progresses, completions, blocks, statusResponses };
}

/**
 * ACK a list of message IDs as delivered.
 * Skips the broker call if the list is empty.
 *
 * @param messageIds - IDs to mark delivered
 */
export async function ackMessages(messageIds: number[]): Promise<void> {
  if (messageIds.length === 0) return;
  await brokerFetch("/ack-message", { message_ids: messageIds });
}

/**
 * ORCH-08: Send a status_request message to an executor.
 * Used when no progress has been seen for 120s (stale executor detection).
 *
 * @param myId - Orchestrator peer ID
 * @param executorId - The potentially-stale executor's peer ID
 * @param taskId - The task the executor is assigned to
 */
export async function sendStatusRequest(
  myId: PeerId,
  executorId: PeerId,
  taskId: number
): Promise<void> {
  await brokerFetch("/send-message", {
    from_id: myId,
    to_id: executorId,
    text: "Status check",
    msg_type: "status_request",
    payload: { task_id: taskId } satisfies { task_id: number },
  });
}

/**
 * ORCH-08: Reclaim a task from an unresponsive executor.
 * Sends reclaim_task message AND marks the task as blocked in the broker.
 *
 * @param myId - Orchestrator peer ID
 * @param executorId - The unresponsive executor's peer ID
 * @param taskId - The task to reclaim
 * @param waveId - The wave the task belongs to
 * @param reason - Human-readable reason for reclaim
 */
export async function reclaimExecutorTask(
  myId: PeerId,
  executorId: PeerId,
  taskId: number,
  waveId: number,
  reason: string
): Promise<void> {
  await brokerFetch("/send-message", {
    from_id: myId,
    to_id: executorId,
    text: "Reclaiming task",
    msg_type: "reclaim_task",
    payload: { task_id: taskId, wave_id: waveId, reason } satisfies ReclaimTaskPayload,
  });
  await brokerFetch("/task-blocked", { task_id: taskId, error: reason });
}

/**
 * ORCH-07: Wait for all tasks in a wave to complete, monitoring for stale executors.
 *
 * Poll loop (10s interval):
 * 1. Drain message queue FIRST (phase_progress, phase_complete, phase_blocked, status_response)
 * 2. ACK all processed messages immediately
 * 3. Check /wave-status — exit loop if wave.status is "completed" or "failed"
 * 4. For each running task with no progress for 120s:
 *    - Send status_request (first time)
 *    - If status_request was sent 30s ago with no response: reclaim the task
 *
 * @param myId - Orchestrator peer ID
 * @param waveId - The wave to monitor
 * @param assignments - Map of taskId -> executorId (for reclaim targeting)
 * @returns { completed, blocked, reclaimed }
 */
export async function waitForWaveComplete(
  myId: PeerId,
  waveId: number,
  assignments: Map<number, PeerId>
): Promise<{ completed: PhaseCompletePayload[]; blocked: PhaseBlockedPayload[]; reclaimed: number[] }> {
  const POLL_INTERVAL_MS = 10_000;
  const STALE_THRESHOLD_MS = 120_000;
  const RECLAIM_WINDOW_MS = 30_000;

  const progressTimestamps = new Map<number, number>(); // taskId -> last progress epoch ms
  const statusRequestSent = new Map<number, number>(); // taskId -> when status_request was sent
  const completed: PhaseCompletePayload[] = [];
  const blocked: PhaseBlockedPayload[] = [];
  const reclaimed: number[] = [];

  // Initialize all assigned tasks with current timestamp
  const now = Date.now();
  for (const taskId of assignments.keys()) {
    progressTimestamps.set(taskId, now);
  }

  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    // 1. Drain message queue FIRST (per pitfall 3 — drain before checking timestamps)
    const msgs = await pollOrchestratorMessages(myId);
    const toAck: number[] = [];

    for (const { msgId, payload } of msgs.progresses) {
      progressTimestamps.set(payload.task_id, Date.now());
      toAck.push(msgId);
    }
    for (const { msgId, payload } of msgs.completions) {
      completed.push(payload);
      toAck.push(msgId);
    }
    for (const { msgId, payload } of msgs.blocks) {
      blocked.push(payload);
      toAck.push(msgId);
    }
    for (const { msgId, payload } of msgs.statusResponses) {
      statusRequestSent.delete(payload.task_id);
      progressTimestamps.set(payload.task_id, Date.now());
      toAck.push(msgId);
    }

    // ACK all processed messages
    await ackMessages(toAck);

    // 2. Check wave-level status
    const waveStatusResult = await brokerFetch<{ wave: Wave; tasks: TaskAssignment[] }>(
      "/wave-status",
      { wave_id: waveId }
    );
    const { wave, tasks } = waveStatusResult;

    if (wave.status === "completed" || wave.status === "failed") {
      break;
    }

    // 3. Stale executor detection — check running tasks only
    const currentTime = Date.now();
    for (const task of tasks) {
      if (task.status !== "running") continue;
      const taskId = task.id;
      const executorId = assignments.get(taskId);
      if (!executorId) continue;

      const lastProgress = progressTimestamps.get(taskId) ?? currentTime;
      const timeSinceProgress = currentTime - lastProgress;

      if (timeSinceProgress > STALE_THRESHOLD_MS) {
        const sentTime = statusRequestSent.get(taskId);
        if (sentTime !== undefined && currentTime - sentTime > RECLAIM_WINDOW_MS) {
          // Status request sent, no response within 30s — reclaim
          await reclaimExecutorTask(myId, executorId, taskId, waveId, "no response to status_request");
          reclaimed.push(taskId);
          statusRequestSent.delete(taskId);
          progressTimestamps.delete(taskId);
        } else if (sentTime === undefined) {
          // First time seeing stale — send status request
          await sendStatusRequest(myId, executorId, taskId);
          statusRequestSent.set(taskId, currentTime);
        }
        // else: waiting for response, do nothing
      }
    }
  }

  return { completed, blocked, reclaimed };
}
