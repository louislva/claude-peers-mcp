/**
 * orchestrator-helpers.ts
 *
 * Pre-dispatch and runtime helper functions for the GSD peer orchestrator.
 * Implements: peer discovery/classification, ROADMAP.md parsing,
 * Kahn's algorithm wave grouping, conflict-based sub-wave serialization,
 * wave dispatch, monitoring, recovery, and post-wave sync.
 *
 * Covers: ORCH-01 through ORCH-13
 */

import { join } from "node:path";
import type {
  PeerId,
  AvailablePeer,
  PeerAvailabilityResponse,
  ExecutePhasePayload,
  Wave,
  TaskAssignment,
  TaskStatus,
  PhaseCompletePayload,
  PhaseBlockedPayload,
  PhaseProgressPayload,
  StatusResponsePayload,
  ReclaimTaskPayload,
  DiscussChoicePayload,
  DiscussAnswerPayload,
  Message,
  PollMessagesResponse,
} from "../../shared/types.ts";
export { sendDiscussChoice, waitForAnswer } from "../proxy/proxy-helpers.ts";

// --- Configuration ---

const BROKER_PORT = process.env.CLAUDE_PEERS_PORT ?? "7899";
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

// --- Internal broker communication ---
// NOTE: brokerFetch is intentionally duplicated from executor-helpers.ts and proxy-helpers.ts.
// Do not import from those modules — each helper module is self-contained.

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

// --- Exported orchestrator pre-dispatch functions ---

/**
 * ORCH-01 / ORCH-02: Discover available peers and classify them into proxy and executors.
 *
 * Calls /peer-availability, merges repo + machine available peers, and classifies:
 * - proxy: at most one peer whose summary contains "decision proxy" (case-insensitive)
 * - executors: all other available peers
 *
 * @param myId - The orchestrator's peer ID (excluded from results)
 * @param gitRoot - The orchestrator's git root for same-repo peer discovery
 */
export async function discoverPeers(
  myId: PeerId,
  gitRoot: string
): Promise<{ proxy: AvailablePeer | null; executors: AvailablePeer[] }> {
  const result = await brokerFetch<PeerAvailabilityResponse>("/peer-availability", {
    repo: gitRoot,
    exclude_id: myId,
  });

  const candidates = [
    ...result.repo_peers.available,
    ...result.machine_peers.available,
  ];

  // Deduplicate by ID (a peer may appear in both repo_peers and machine_peers)
  const seen = new Set<PeerId>();
  const unique: AvailablePeer[] = [];
  for (const candidate of candidates) {
    if (!seen.has(candidate.id)) {
      seen.add(candidate.id);
      unique.push(candidate);
    }
  }

  // ORCH-02: Classify proxy by case-insensitive "decision proxy" substring in summary
  let proxy: AvailablePeer | null = null;
  const executors: AvailablePeer[] = [];

  for (const candidate of unique) {
    if (proxy === null && candidate.summary.toLowerCase().includes("decision proxy")) {
      proxy = candidate;
    } else {
      executors.push(candidate);
    }
  }

  return { proxy, executors };
}

/**
 * ORCH-03: Parse ROADMAP.md content into an array of PhaseNode objects.
 *
 * Extracts: phase number, goal (name), status (completed/pending), dependencies,
 * and phase directory. Handles both "Phase N:" and section headers.
 *
 * Name priority: **Goal** field (if present) > section header title
 * Status: determined by `[x]` markers in either the overview list OR the detail sections
 *
 * @param roadmapContent - Raw text content of ROADMAP.md
 */
export function parseRoadmapPhases(roadmapContent: string): PhaseNode[] {
  const phases: PhaseNode[] = [];
  const lines = roadmapContent.split("\n");

  // Pre-scan: collect phase numbers marked complete in overview lists like:
  //   "- [x] **Phase 1: Foundation** - ..."
  //   "- [x] **Phase 1:** ..."
  const completedFromOverview = new Set<number>();
  for (const line of lines) {
    if (/\[x\]/i.test(line)) {
      const phaseNumMatch = line.match(/Phase\s+(\d+)/i);
      if (phaseNumMatch) {
        completedFromOverview.add(parseInt(phaseNumMatch[1], 10));
      }
    }
  }

  let currentPhase: Partial<PhaseNode> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match phase SECTION headers (## or ### level): "### Phase N:" or "### Phase N.N:"
    // Distinguish from inline overview bullets by requiring a heading marker (#)
    const phaseHeaderMatch = line.match(/^#{1,4}\s+Phase\s+(\d+(?:\.\d+)?)[:\s]/i);
    if (phaseHeaderMatch) {
      // Save previous phase if exists
      if (currentPhase && currentPhase.number !== undefined) {
        phases.push(finalizePhaseNode(currentPhase));
      }

      const phaseNum = parseInt(phaseHeaderMatch[1], 10);
      currentPhase = {
        number: phaseNum,
        name: "",
        dir: "",
        dependencies: [],
        // A phase is completed if [x] was found anywhere (overview or detail)
        status: completedFromOverview.has(phaseNum) ? "completed" : "pending",
        filesModified: [],
      };

      // Extract name from the header line after "Phase N:" as initial name
      const nameMatch = line.match(/^#{1,4}\s+Phase\s+\d+(?:\.\d+)?[:\s]+(.+)/i);
      if (nameMatch) {
        currentPhase.name = nameMatch[1].trim();
      }
      continue;
    }

    if (!currentPhase) continue;

    // Check for completion status within a detail section: "- [x]" pattern
    if (/\[x\]/i.test(line)) {
      currentPhase.status = "completed";
    }

    // Parse Goal field: "**Goal**:" — takes priority over header name
    const goalMatch = line.match(/\*\*Goal\*\*[:\s]+(.+)/i);
    if (goalMatch && goalMatch[1].trim()) {
      currentPhase.name = goalMatch[1].trim();
    }

    // Parse Dependencies field: "**Depends on**:" or "**Depends on**:"
    const depsMatch = line.match(/\*\*Depends?\s+on\*\*[:\s]+(.+)/i);
    if (depsMatch) {
      const depsText = depsMatch[1].trim();
      if (!/nothing|none|-$/i.test(depsText)) {
        // Extract all phase numbers mentioned (e.g., "Phase 1", "Phase 2, Phase 3")
        const phaseRefs = depsText.matchAll(/Phase\s+(\d+)/gi);
        for (const ref of phaseRefs) {
          const depNum = parseInt(ref[1], 10);
          if (!currentPhase.dependencies!.includes(depNum)) {
            currentPhase.dependencies!.push(depNum);
          }
        }
      }
    }

    // Parse directory hint from plan list entries (e.g., "01-01-PLAN.md" in a phase section)
    const planDirMatch = line.match(/(\d{2}-[\w-]+)\/\d{2}-\d{2}-PLAN\.md/i);
    if (planDirMatch && !currentPhase.dir) {
      currentPhase.dir = planDirMatch[1];
    }

    // Alternative: dir from heading anchor or directory listing pattern
    if (!currentPhase.dir) {
      const dirMatch = line.match(/`?(\d{2}-[\w-]+)`?\s*(?:—|-|:)/);
      if (dirMatch && /^\d{2}-/.test(dirMatch[1])) {
        currentPhase.dir = dirMatch[1];
      }
    }
  }

  // Save final phase
  if (currentPhase && currentPhase.number !== undefined) {
    phases.push(finalizePhaseNode(currentPhase));
  }

  return phases;
}

/** Ensure all required fields have defaults before pushing to the result array */
function finalizePhaseNode(partial: Partial<PhaseNode>): PhaseNode {
  return {
    number: partial.number!,
    name: partial.name || `Phase ${partial.number}`,
    dir: partial.dir || String(partial.number!).padStart(2, "0"),
    dependencies: partial.dependencies || [],
    status: partial.status || "pending",
    filesModified: partial.filesModified || [],
  };
}

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
 * ORCH-13: Check for file-overlap conflicts within a wave and split into sub-waves.
 *
 * Uses a LOCAL file-overlap matrix (planning-time, not runtime).
 * Does NOT call broker /conflict-check — that endpoint is for runtime conflicts with
 * RUNNING tasks. This function handles STATIC conflicts between co-scheduled phases.
 *
 * Algorithm: greedy graph coloring
 * - Sort phases by number of conflicts (descending)
 * - Assign each phase to the first sub-wave with no conflicting phase
 * - Create a new sub-wave if no existing sub-wave is conflict-free
 *
 * @param wavePhases - Phases in a single wave (would run in parallel)
 * @param _gitRoot - Git root (reserved for future use; not used in static conflict check)
 * @returns Array of sub-waves, each conflict-free internally
 */
export async function checkWaveConflicts(
  wavePhases: PhaseNode[],
  _gitRoot: string
): Promise<PhaseNode[][]> {
  if (wavePhases.length <= 1) {
    return [wavePhases];
  }

  // Build conflict adjacency: conflicts[i] = set of indices j where phase i and j share files
  const n = wavePhases.length;
  const conflicts: Set<number>[] = Array.from({ length: n }, () => new Set<number>());

  for (let i = 0; i < n; i++) {
    const filesI = new Set(wavePhases[i].filesModified);
    for (let j = i + 1; j < n; j++) {
      const hasOverlap = wavePhases[j].filesModified.some((f) => filesI.has(f));
      if (hasOverlap) {
        conflicts[i].add(j);
        conflicts[j].add(i);
      }
    }
  }

  // Check if any conflicts exist at all
  const hasConflicts = conflicts.some((s) => s.size > 0);
  if (!hasConflicts) {
    return [wavePhases];
  }

  // Greedy coloring: sort by conflict count descending for better packing
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => conflicts[b].size - conflicts[a].size
  );

  // subWaveAssignments[k] = set of phase indices in sub-wave k
  const subWaveAssignments: Set<number>[] = [];

  for (const idx of order) {
    // Find the first sub-wave where this phase has no conflict with existing members
    let placed = false;
    for (const subWave of subWaveAssignments) {
      const hasConflictWithSubWave = [...subWave].some((existing) =>
        conflicts[idx].has(existing)
      );
      if (!hasConflictWithSubWave) {
        subWave.add(idx);
        placed = true;
        break;
      }
    }
    if (!placed) {
      subWaveAssignments.push(new Set([idx]));
    }
  }

  // Convert assignment sets back to PhaseNode arrays, preserving original order within each sub-wave
  return subWaveAssignments.map((subWave) =>
    [...subWave]
      .sort((a, b) => a - b) // preserve original wave order
      .map((idx) => wavePhases[idx])
  );
}

// --- Orchestrator runtime helper functions (ORCH-05 through ORCH-12) ---

/** Internal helper: zero-pad a phase number to 2 digits */
function padPhase(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * ORCH-05: Create a broker wave and dispatch execute_phase messages to available executors.
 *
 * - Calls /wave-create to register the wave and task assignments atomically
 * - Checks /wave-status after creation — only dispatches tasks in "pending" state (idempotent on retry)
 * - For each pending task: sends execute_phase message to an available executor
 * - Does NOT call /task-start — the executor owns that state transition
 * - Phases without an available executor are returned in localPhases for local execution
 *
 * @param myId - Orchestrator peer ID
 * @param gitRoot - Git root directory (used for plan paths and broker repo field)
 * @param waveNumber - The wave number (for broker wave tracking)
 * @param phases - Phases to dispatch in this wave
 * @param executors - Available executors (consumed in order; may be fewer than phases)
 * @returns { waveId, assignments (taskId -> executorId), localPhases }
 */
export async function dispatchWave(
  myId: PeerId,
  gitRoot: string,
  waveNumber: number,
  phases: PhaseNode[],
  executors: AvailablePeer[]
): Promise<{ waveId: number; assignments: Map<number, PeerId>; localPhases: PhaseNode[] }> {
  // Create the wave and task assignments atomically in the broker
  const waveCreateResult = await brokerFetch<{ wave_id: number; task_ids: number[] }>(
    "/wave-create",
    {
      repo: gitRoot,
      phase: waveNumber,
      wave_number: waveNumber,
      tasks: phases.map((p) => ({
        name: `phase-${p.number}`,
        files: p.filesModified,
      })),
    }
  );

  const waveId = waveCreateResult.wave_id;
  const taskIds = waveCreateResult.task_ids;

  // Fetch current wave status to check for already-running tasks (idempotency on retry)
  const waveStatus = await brokerFetch<{ wave: Wave; tasks: TaskAssignment[] }>(
    "/wave-status",
    { wave_id: waveId }
  );

  // Build taskId -> task mapping for status lookup
  const taskStatusMap = new Map<number, TaskStatus>();
  for (const t of waveStatus.tasks) {
    taskStatusMap.set(t.id, t.status);
  }

  const assignments = new Map<number, PeerId>();
  const localPhases: PhaseNode[] = [];
  const availableExecutors = [...executors]; // copy to avoid mutating caller's array

  // Match phases to task IDs by position (wave-create returns task_ids in order)
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const taskId = taskIds[i];
    if (taskId === undefined) {
      localPhases.push(phase);
      continue;
    }

    // Only dispatch tasks in "pending" state
    const taskStatus = taskStatusMap.get(taskId);
    if (taskStatus !== "pending" && taskStatus !== undefined) {
      // Already running or completed — skip
      continue;
    }

    if (availableExecutors.length > 0) {
      const executor = availableExecutors.shift()!;
      const planPath = `.planning/phases/${phase.dir}/${padPhase(phase.number)}-PLAN.md`;
      const executePayload: ExecutePhasePayload = {
        phase_number: phase.number,
        plan_path: planPath,
        flags: "--no-transition --auto",
        wave_id: waveId,
        task_id: taskId,
        orchestrator_id: myId,
      };
      await brokerFetch("/send-message", {
        from_id: myId,
        to_id: executor.id,
        text: `Execute phase ${phase.number}`,
        msg_type: "execute_phase",
        payload: executePayload,
      });
      assignments.set(taskId, executor.id);
    } else {
      localPhases.push(phase);
    }
  }

  return { waveId, assignments, localPhases };
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
 * ORCH-11: Determine whether a phase should be delegated to an executor peer.
 *
 * Returns false (execute locally) when:
 * - No executors are available
 * - Phase has fewer than 3 files modified (small phase, delegation overhead not worthwhile)
 * - Any of the phase's files overlap with currently-running tasks (conflict risk)
 * - The phase has a human-action checkpoint (cannot be fully autonomous)
 *
 * @param phase - The PhaseNode to evaluate
 * @param availableExecutorCount - Number of idle executors available
 * @param runningFiles - Files currently being modified by running tasks
 * @param hasHumanCheckpoint - Whether the phase's plan has a human-action checkpoint
 */
export function shouldDelegate(
  phase: PhaseNode,
  availableExecutorCount: number,
  runningFiles: string[],
  hasHumanCheckpoint: boolean
): boolean {
  if (availableExecutorCount === 0) return false;
  if (phase.filesModified.length < 3) return false;
  const runningSet = new Set(runningFiles);
  if (phase.filesModified.some((f) => runningSet.has(f))) return false;
  if (hasHumanCheckpoint) return false;
  return true;
}
