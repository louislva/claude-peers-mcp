/**
 * orchestrator-helpers.ts
 *
 * Pre-dispatch helper functions for the GSD peer orchestrator.
 * Implements: peer discovery/classification, ROADMAP.md parsing,
 * Kahn's algorithm wave grouping, and conflict-based sub-wave serialization.
 *
 * Covers: ORCH-01 through ORCH-04 and ORCH-13
 */

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
 * @param roadmapContent - Raw text content of ROADMAP.md
 */
export function parseRoadmapPhases(roadmapContent: string): PhaseNode[] {
  const phases: PhaseNode[] = [];

  // Split on phase section headers. Each section starts with a heading like:
  // "## Phase 1: Foundation" or "### Phase 1.0: ..."
  // We look for lines like "## Phase N" or "### Phase N" to split on.
  const lines = roadmapContent.split("\n");

  let currentPhase: Partial<PhaseNode> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match phase section headers: "## Phase N:" or "### Phase N:"
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
        status: "pending",
        filesModified: [],
      };

      // Extract name from the header line after "Phase N:"
      const nameMatch = line.match(/^#{1,4}\s+Phase\s+\d+(?:\.\d+)?[:\s]+(.+)/i);
      if (nameMatch) {
        currentPhase.name = nameMatch[1].trim();
      }
      continue;
    }

    if (!currentPhase) continue;

    // Check for completion status: "- [x]" or "[x]" patterns in plan list entries
    // Also check for bold status entries like "**Status**: completed"
    if (/\[x\]/i.test(line)) {
      currentPhase.status = "completed";
    }

    // Parse Goal field: "**Goal**:" or "- **Goal**:"
    const goalMatch = line.match(/\*\*Goal\*\*[:\s]+(.+)/i);
    if (goalMatch && goalMatch[1].trim()) {
      currentPhase.name = goalMatch[1].trim();
    }

    // Parse Dependencies field: "**Depends on**:" or "- **Depends on**:"
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
    // Phase dir is derived from the phase number with a slug from the name
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
