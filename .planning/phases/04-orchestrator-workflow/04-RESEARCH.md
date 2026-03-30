# Phase 4: Orchestrator Workflow - Research

**Researched:** 2026-03-25
**Domain:** Distributed workflow orchestration — peer discovery, dependency graph analysis, wave dispatch, monitoring, failure recovery
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
None — all implementation choices are at Claude's discretion.

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Key areas:
- Workflow file structure (single orchestrator-helpers.ts + skill/command document, or modular)
- How Kahn's algorithm and wave grouping are implemented (inline vs extracted function)
- Wave dispatch pattern (parallel spawn with Promise.all vs sequential with parallelization flag)
- Polling mechanism for wave status (setInterval, recursive setTimeout, or loop with sleep)
- How orchestrator identifies proxy vs executors from peer summary content
- State machine implementation (explicit states vs implicit flow)
- How sequential fallback is triggered and whether it reuses existing `/gsd:autonomous` skill
- Test structure for orchestrator protocol flows
- Whether orchestrator helpers are a single file or split into discovery/dispatch/monitoring modules

### Deferred Ideas (OUT OF SCOPE)
None
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| ORCH-01 | Orchestrator discovers available peers via `/peer-availability` on startup | `handlePeerAvailability` in broker.ts is fully implemented; returns `PeerAvailabilityResponse` with `repo_peers` and `machine_peers` grouped by availability |
| ORCH-02 | Orchestrator classifies peers into decision_proxy (at most one) and executors by summary content | Proxy summary is exact string "Decision proxy -- answering discuss-phase choices for autonomous runs"; case-insensitive substring match on "decision proxy" |
| ORCH-03 | Orchestrator builds dependency graph from ROADMAP.md phases with cycle detection (Kahn's algorithm) | ROADMAP.md format may not have explicit deps; design doc describes both explicit parsing and LLM inference; Kahn's algorithm is well-defined |
| ORCH-04 | Orchestrator groups independent phases into execution waves based on dependency graph | Wave 1 = no-dep phases, Wave N = phases depending only on completed waves; broker `/wave-create` is idempotent |
| ORCH-05 | Orchestrator plans all phases in a wave sequentially (orchestrator-only), then dispatches execution in parallel to peers | Sequential planning (fast, LLM only), parallel execution via send_message to each executor |
| ORCH-06 | Orchestrator delegates discuss-phase choices to decision proxy instead of prompting user | `sendDiscussChoice` and `waitForAnswer` in proxy-helpers.ts are ready for orchestrator import |
| ORCH-07 | Orchestrator monitors wave progress via `/wave-status` polling every 10 seconds | `handleWaveStatus` returns wave + all tasks; polling loop with 10s sleep is the pattern |
| ORCH-08 | Orchestrator reclaims tasks from unresponsive executors (no progress for 120s, no status_response within 30s) | Send `status_request`, wait 30s; if no `status_response`, call `/task-blocked` then send `reclaim_task` |
| ORCH-09 | Orchestrator handles executor death by checking git for partial work and reassigning | Check git log for commits from dead executor's last_commit SHA; assess completeness; reassign or complete locally |
| ORCH-10 | Orchestrator performs post-wave sync (git pull, re-read ROADMAP.md, update STATE.md, refresh peer list) | `git pull` after wave completion; re-run roadmap analyze to catch dynamic phases |
| ORCH-11 | Orchestrator applies delegation decision logic (delegate vs execute locally based on phase size, dependencies, checkpoint types, file conflicts) | Delegate when: peer available, no deps on in-flight phases, no file conflicts, no human_action checkpoints, >=3 tasks in plan |
| ORCH-12 | Orchestrator falls back to standard sequential autonomous if no peers are available | If `repo_peers.available` and `machine_peers.available` are both empty after classification, fall through to standard sequential GSD autonomous workflow |
| ORCH-13 | Orchestrator serializes conflicting phases into synthetic sub-waves when conflict-check detects file overlap | Call `/conflict-check` before dispatch; if conflicts detected, split into synthetic sub-waves (e.g., wave 2, wave 2.1) |
</phase_requirements>

---

## Summary

Phase 4 implements `gsd-plugin/orchestrator/orchestrator-helpers.ts` and `gsd-plugin/agents/gsd-orchestrator.md` (plus a GSD workflow document at `gsd-plugin/workflows/autonomous-peers.md`). These three artifacts complete the three-peer collaboration architecture: executor (Phase 2), proxy (Phase 3), and orchestrator (Phase 4).

The orchestrator is the most complex peer role. Its core loop is: (1) discover and classify peers, (2) parse ROADMAP.md and build a dependency graph via Kahn's algorithm, (3) for each execution wave — plan all phases sequentially, dispatch execution to available peers in parallel, monitor via `/wave-status` polling, handle executor failure or unresponsiveness, run post-wave sync, then advance to the next wave. If no peers are found, the orchestrator delegates entirely to the existing sequential autonomous workflow.

All supporting infrastructure is already in place: types are defined in `shared/types.ts`, broker endpoints (`/peer-availability`, `/wave-create`, `/wave-status`, `/task-start`, `/task-complete`, `/task-blocked`, `/conflict-check`, `/send-message`, `/poll-messages`) are implemented and tested, and the proxy communication helpers (`sendDiscussChoice`, `waitForAnswer`) are importable from `proxy-helpers.ts`. Phase 4 is purely assembly.

**Primary recommendation:** Follow the same three-file pattern used for executor and proxy: one helpers `.ts` file containing all broker/git/polling functions, one agent `.md` document with the orchestrator's state machine and decision logic, and one GSD workflow `.md` document (`/gsd:autonomous-peers`). Tests follow the isolated-broker pattern established in `executor-helpers.test.ts`.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `bun:sqlite` | built-in | Broker communication (via HTTP to the running broker) | Project standard; broker already uses it |
| `fetch` | built-in | All broker HTTP calls via `brokerFetch<T>` helper | Established pattern in executor-helpers.ts and proxy-helpers.ts |
| `Bun.spawn` | built-in | git operations (pull, push, log, rev-parse) | Project standard per CLAUDE.md |
| `bun:test` | built-in | Integration tests with isolated broker on unique port | Same framework as executor-helpers.test.ts (17901) and proxy-helpers.test.ts |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:path` (join) | built-in | Path construction for ROADMAP.md, plan files | Same as executor-helpers.ts |
| `proxy-helpers.ts` | local | `sendDiscussChoice`, `waitForAnswer`, `ackMessages` | Re-use directly — orchestrator imports these for proxy communication |
| `executor-helpers.ts` | local | `brokerFetch` pattern reference | Do NOT import executor helpers directly; duplicate `brokerFetch` or extract to shared module |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Polling loop with `setTimeout` sleep | `setInterval` | Polling loop is simpler to reason about with async/await and avoids overlapping intervals if broker is slow |
| Single `orchestrator-helpers.ts` | Split into `orchestrator-discovery.ts`, `orchestrator-dispatch.ts`, `orchestrator-monitor.ts` | Single file matches executor-helpers.ts and proxy-helpers.ts precedent; split only if file exceeds ~500 lines |
| Inline Kahn's algorithm | External graph library | No external dep needed; topological sort on 5-20 phases is trivial |

**Installation:** No new packages required. All dependencies are built-in to Bun or already in the repo.

---

## Architecture Patterns

### Recommended Project Structure

```
gsd-plugin/
├── orchestrator/
│   ├── orchestrator-helpers.ts       # All broker/git/graph functions
│   └── orchestrator-helpers.test.ts  # Integration tests (isolated broker)
├── agents/
│   └── gsd-orchestrator.md           # Orchestrator agent document
└── workflows/
    └── autonomous-peers.md           # /gsd:autonomous-peers workflow document
```

The `workflows/` directory is new — it holds the GSD workflow document that users invoke via `/gsd:autonomous-peers`. This is analogous to the GSD `workflows/autonomous.md` that exists in the GSD installation at `/home/joshuaduffill/.claude/get-shit-done/workflows/autonomous.md`.

### Pattern 1: brokerFetch (Established Pattern)

**What:** Single generic function wrapping all broker HTTP POST calls.
**When to use:** Every broker endpoint call in orchestrator-helpers.ts.

```typescript
// Source: gsd-plugin/executor/executor-helpers.ts (lines 27-38)
const BROKER_PORT = process.env.CLAUDE_PEERS_PORT ?? "7899";
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

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
```

### Pattern 2: Peer Discovery and Classification

**What:** Call `/peer-availability`, separate peers into proxy (by summary content) and executors (all others).
**When to use:** On orchestrator startup, and again after each wave (ORCH-10 peer list refresh).

```typescript
// Source: design-peer-autonomous.md + shared/types.ts
async function discoverPeers(myId: PeerId, gitRoot: string): Promise<{
  proxy: AvailablePeer | null;
  executors: AvailablePeer[];
}> {
  const result = await brokerFetch<PeerAvailabilityResponse>("/peer-availability", {
    repo: gitRoot,
    exclude_id: myId,
  });

  // Prefer repo peers; fall back to machine peers
  const candidates = [
    ...result.repo_peers.available,
    ...result.machine_peers.available,
  ];

  // ORCH-02: identify proxy by summary substring (case-insensitive)
  const proxyIndex = candidates.findIndex(p =>
    p.summary.toLowerCase().includes("decision proxy")
  );
  const proxy = proxyIndex >= 0 ? candidates[proxyIndex] : null;
  const executors = candidates.filter((_, i) => i !== proxyIndex);

  return { proxy, executors };
}
```

**KEY DETAIL:** The exact proxy summary string from the proxy agent doc is:
`"Decision proxy -- answering discuss-phase choices for autonomous runs"`
(note: double dash `--`, not em dash). The orchestrator matches on the substring `"decision proxy"` case-insensitively.

### Pattern 3: Kahn's Algorithm for Wave Grouping

**What:** Topological sort on a phase dependency graph; produces ordered execution waves.
**When to use:** Once after reading ROADMAP.md in `dependency_analysis` step.

```typescript
// Source: design-peer-autonomous-orchestrator.md + Kahn's algorithm (standard CS)
interface PhaseNode {
  number: number;
  name: string;
  dependencies: number[]; // phase numbers this phase depends on
}

function buildExecutionWaves(phases: PhaseNode[]): PhaseNode[][] {
  // Kahn's algorithm: BFS topological sort
  const inDegree = new Map<number, number>();
  const dependents = new Map<number, number[]>(); // num -> [phases that depend on it]

  for (const phase of phases) {
    if (!inDegree.has(phase.number)) inDegree.set(phase.number, 0);
    for (const dep of phase.dependencies) {
      inDegree.set(phase.number, (inDegree.get(phase.number) ?? 0) + 1);
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(phase.number);
    }
  }

  const waves: PhaseNode[][] = [];
  let queue = phases.filter(p => (inDegree.get(p.number) ?? 0) === 0);

  while (queue.length > 0) {
    waves.push(queue);
    const nextQueue: PhaseNode[] = [];
    for (const phase of queue) {
      for (const dependent of (dependents.get(phase.number) ?? [])) {
        const newDegree = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          nextQueue.push(phases.find(p => p.number === dependent)!);
        }
      }
    }
    queue = nextQueue;
  }

  // Cycle detection: if any phases remain with inDegree > 0, there's a cycle
  const processed = waves.flat().length;
  if (processed < phases.length) {
    throw new Error(`Dependency cycle detected in ROADMAP.md`);
  }

  return waves;
}
```

**ROADMAP.md format concern (from STATE.md blockers):** ROADMAP.md may not have explicit dependency declarations. Resolution: parse for explicit "depends on phase N" language in phase descriptions first; fall back to LLM inference for implicit dependencies (DB schema before API before frontend). Kahn's algorithm runs on the resulting graph regardless of how edges were inferred.

### Pattern 4: Wave Dispatch Loop

**What:** Create broker wave, send `execute_phase` to each executor in parallel, then poll `/wave-status`.
**When to use:** For each execution wave, after all phases in the wave are planned.

```typescript
// Source: design-peer-autonomous-orchestrator.md (Modified Step: Parallel Phase Loop)

// Step 1: Create broker wave
const { wave_id, task_ids } = await brokerFetch<{ wave_id: number; task_ids: number[] }>(
  "/wave-create",
  {
    repo: gitRoot,
    phase: waveNumber,
    wave_number: waveNumber,
    tasks: phases.map(p => ({
      name: `phase-${p.number}`,
      files: p.expectedFiles, // from plan frontmatter
    })),
  }
);

// Step 2: Dispatch each phase to an executor (or execute locally)
for (let i = 0; i < phases.length; i++) {
  const phase = phases[i];
  const taskId = task_ids[i];

  if (executors.length > 0) {
    const executor = executors.shift()!;
    await brokerFetch("/task-start", { task_id: taskId, session_id: executor.id });
    await brokerFetch("/send-message", {
      from_id: myId,
      to_id: executor.id,
      text: `Execute phase ${phase.number}`,
      msg_type: "execute_phase",
      payload: {
        phase_number: phase.number,
        plan_path: `.planning/phases/${phase.dir}/PLAN.md`,
        flags: "--no-transition --auto",
        wave_id,
        task_id: taskId,
        orchestrator_id: myId,
      } satisfies ExecutePhasePayload,
    });
  } else {
    // Execute locally — no Skill() in helpers; handled in agent doc
  }
}
```

### Pattern 5: Wave Status Polling Loop

**What:** Poll `/wave-status` every 10 seconds; handle task state transitions.
**When to use:** After dispatching all phases in a wave.

```typescript
// Source: design-peer-autonomous-orchestrator.md + shared/types.ts

async function waitForWaveComplete(
  waveId: number,
  taskProgressTimestamps: Map<number, number>, // taskId -> last progress time
  assignedExecutors: Map<number, PeerId>,       // taskId -> executorId
): Promise<void> {
  while (true) {
    await new Promise(r => setTimeout(r, 10_000)); // ORCH-07: poll every 10s

    const { wave, tasks } = await brokerFetch<{ wave: Wave; tasks: TaskAssignment[] }>(
      "/wave-status", { wave_id: waveId }
    );

    if (wave.status === "completed" || wave.status === "failed") break;

    const now = Date.now();
    for (const task of tasks) {
      if (task.status !== "running") continue;

      const lastProgress = taskProgressTimestamps.get(task.id) ?? now;
      const silentMs = now - lastProgress;

      // ORCH-08: no progress for 120s -> send status_request
      if (silentMs > 120_000) {
        const executorId = assignedExecutors.get(task.id);
        if (executorId) {
          await sendStatusRequest(myId, executorId, task.id);
          // Wait 30s for status_response before reclaiming
          // (polling loop handles this on next iteration via timestamp tracking)
        }
      }
    }
  }
}
```

### Pattern 6: Message Polling for Orchestrator

**What:** Poll `/poll-messages` to receive `phase_complete`, `phase_blocked`, `phase_progress`, `status_response` from executors.
**When to use:** During wave monitoring, interleaved with `/wave-status` polling.

The orchestrator must ACK messages it processes. Unlike the proxy (which does not ACK on poll), the orchestrator should ACK `phase_complete`, `phase_blocked`, and `status_response` after handling them to prevent re-processing.

### Anti-Patterns to Avoid

- **Do not import executor-helpers.ts into orchestrator-helpers.ts.** The `brokerFetch` function is private to each helper module (uses BROKER_PORT env var at module-load time). Duplicate the `brokerFetch` implementation in orchestrator-helpers.ts, or extract to a shared `broker-client.ts` if code duplication becomes a concern.
- **Do not skip the conflict-check before dispatch (ORCH-13).** Even if Kahn's algorithm says phases are independent, two phases may both modify `package.json`. Always call `/conflict-check` before assigning a task to an executor.
- **Do not call `/task-start` after the executor starts.** The orchestrator calls `/task-start` BEFORE sending the `execute_phase` message. The executor calls `callTaskStart` again inside its setup phase — but that's a no-op since the status is already "running".
- **Correction from design doc:** Re-reading the executor agent doc (Section 2d): the executor calls `callTaskStart(taskId, sessionId)` during setup. The orchestrator should NOT call `/task-start` before sending the message; the executor owns that transition. Send `execute_phase` first; executor calls `/task-start` during setup.
- **Do not block wave execution on one dead peer.** Always continue the pipeline. Reclaim, reassign, and move on.
- **Do not run GSD planning from within orchestrator-helpers.ts.** Planning steps (`discuss-phase`, `plan-phase`) are run by the orchestrator agent directly via GSD Skill() invocations. The helpers module handles only protocol communication.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Topological sort | Custom DFS cycle detector | Kahn's algorithm (inline, ~30 lines) | Kahn's produces wave groups naturally; DFS requires separate wave-grouping pass |
| Broker HTTP client | Fetch wrapper per endpoint | `brokerFetch<T>` pattern from executor-helpers.ts | Identical implementation; copy the 12-line function |
| Proxy communication | Custom `discuss_choice` sender | `sendDiscussChoice` + `waitForAnswer` from proxy-helpers.ts | Already implemented, tested, handles ACK cleanup of stale messages |
| Git log parsing | Custom regex | `git log --oneline --since` or `git log <sha>..HEAD` with `Bun.spawn` | Standard git CLI handles SHA ranges and time filters reliably |
| Message ACK tracking | Custom Set | Broker's `/ack-message` endpoint | At-least-once delivery is handled by the broker; orchestrator just needs to ACK after processing |
| Wave completion detection | Counting completed tasks manually | `/wave-status` `wave.status === "completed"` | `taskCompleteTxn` auto-completes the wave when all tasks terminal |

**Key insight:** This phase is almost entirely assembly of existing pieces. The two genuinely new algorithms are Kahn's topological sort (standard, well-defined, ~30 lines) and the executor liveness/reclaim logic (protocol-driven, described precisely in the design doc). Everything else is wiring existing broker endpoints and helper functions.

---

## Common Pitfalls

### Pitfall 1: ROADMAP.md Dependency Format Is Uncertain

**What goes wrong:** The parser assumes explicit "depends on phase N" syntax in ROADMAP.md, but GSD-generated roadmaps may not include this. The parser silently treats all phases as independent (no edges), resulting in a single wave that tries to run all phases in parallel — potentially creating conflicts.

**Why it happens:** GSD's `roadmap analyze` command produces a JSON representation of phases but may not encode dependency edges. The ROADMAP.md text format is free-form.

**How to avoid:** Implement a two-pass dependency parser: (1) parse for explicit dependency keywords ("depends on", "requires phase", "after phase N"); (2) if no explicit deps found, use LLM inference to infer from phase names and goals. Always run Kahn's algorithm afterward regardless of inference method. The cycle detection in Kahn's catches any LLM inference errors.

**Warning signs:** Wave 1 contains more than 2-3 phases for a typical 5-phase milestone.

### Pitfall 2: Executor task_start Ownership Conflict

**What goes wrong:** Orchestrator calls `/task-start` before sending `execute_phase`, then executor also calls `callTaskStart` during setup. Second call returns error `"Task already running"` but executor ignores it — silent failure that may leave a race condition if two executors are dispatched.

**Why it happens:** Design doc and executor agent doc have slightly different descriptions of who calls `/task-start` first.

**How to avoid:** The executor agent doc (Step 2d) is authoritative: the executor calls `callTaskStart(taskId, sessionId)` during SETUP. The orchestrator should NOT call `/task-start` before dispatching. The orchestrator only calls `/task-blocked` or `/task-complete` — it does NOT call `/task-start`. The orchestrator creates the wave and tasks via `/wave-create` (which sets them to "pending"), then lets each executor claim their task via `/task-start`.

**Warning signs:** Tasks that appear stuck in "pending" state even though an executor was dispatched.

### Pitfall 3: Stale Phase Progress Timestamps

**What goes wrong:** Orchestrator tracks last progress time per task. A `phase_progress` message arrives but the orchestrator's polling loop hasn't updated the timestamp map before the 120s no-progress check fires. Executor is incorrectly declared unresponsive.

**Why it happens:** The orchestrator runs two concurrent activities: polling `/wave-status` and polling `/poll-messages`. If these are sequential (one loop, alternate between the two), a `phase_progress` message may sit unread for up to 10s while the status check fires.

**How to avoid:** Always drain the message queue (poll until empty) before checking progress timestamps. The progress timestamp should be updated immediately on receiving `phase_progress`. Do not start the 120s clock for a task until it transitions to "running" status in `/wave-status`.

**Warning signs:** Premature reclaims followed by executor sending `status_response` immediately after.

### Pitfall 4: Wave Create Idempotency on Retry

**What goes wrong:** Orchestrator crashes mid-wave. On restart, it calls `/wave-create` again for the same wave number. The broker returns the existing wave (idempotent by design), but the task IDs returned correspond to the original tasks — some may already be "completed" or "running".

**Why it happens:** `/wave-create` is idempotent: if a wave with the same (repo, phase, wave_number) tuple exists, it returns the existing wave_id and task_ids without modification.

**How to avoid:** After `/wave-create`, call `/wave-status` to check task states. Dispatch only tasks in "pending" or "blocked" state. Skip tasks already "running" or "completed".

**Warning signs:** Tasks report "already running" on task-start, or wave never completes because already-running tasks are re-dispatched.

### Pitfall 5: Conflict-Check Serialization Creates Deadlock

**What goes wrong:** Two phases each have `package.json` in their file lists. Conflict-check flags them. Orchestrator creates synthetic sub-wave for the second phase. But the second phase was ALSO in the conflict check for a third phase. The ordering becomes `wave-N -> wave-N.1 -> wave-N.2`, blocking everything.

**Why it happens:** Greedy conflict resolution: each conflict creates a new sub-wave, but sub-wave conflicts aren't re-evaluated.

**How to avoid:** Collect all conflicts before creating sub-waves. Sort phases by conflict count (most conflicts first → latest sub-wave). Build the sub-wave ordering as a single pass, not iteratively.

**Warning signs:** More sub-waves than expected; execution becomes fully sequential despite having multiple executors.

---

## Code Examples

Verified patterns from existing codebase and design documents:

### Calling /peer-availability

```typescript
// Source: broker.ts handlePeerAvailability (lines 709-765) + shared/types.ts
const result = await brokerFetch<PeerAvailabilityResponse>("/peer-availability", {
  repo: gitRoot,        // git_root of the orchestrator's repo
  exclude_id: myId,    // exclude self
});
// result.repo_peers.available — same-repo peers, no running tasks
// result.repo_peers.busy      — same-repo peers with active tasks
// result.machine_peers.*      — machine-wide, different repo
```

### Calling /wave-create

```typescript
// Source: broker.ts waveCreateTxn (lines 603-625)
// WaveCreateRequest shape (inferred from handler):
const { wave_id, task_ids } = await brokerFetch<{ wave_id: number; task_ids: number[] }>(
  "/wave-create",
  {
    repo: gitRoot,
    phase: waveNumber,
    wave_number: waveNumber,
    tasks: [
      { name: "phase-3", files: ["src/api/routes.ts", "src/api/index.ts"] },
      { name: "phase-4", files: ["src/cli/index.ts"] },
    ],
  }
);
```

### Calling /wave-status

```typescript
// Source: broker.ts handleWaveStatus (lines 631-636) + shared/types.ts
const { wave, tasks } = await brokerFetch<{ wave: Wave; tasks: TaskAssignment[] }>(
  "/wave-status",
  { wave_id: waveId }
);
// wave.status: "pending" | "running" | "completed" | "failed"
// tasks[i].status: "pending" | "running" | "completed" | "failed" | "blocked"
```

### Sending status_request to executor

```typescript
// Source: shared/types.ts StatusRequestPayload
import type { StatusRequestPayload } from "../../shared/types.ts";

async function sendStatusRequest(
  myId: PeerId,
  executorId: PeerId,
  taskId: number
): Promise<void> {
  const payload: StatusRequestPayload = { task_id: taskId };
  await brokerFetch("/send-message", {
    from_id: myId,
    to_id: executorId,
    text: `Status check for task ${taskId}`,
    msg_type: "status_request",
    payload,
  });
}
```

### Sending reclaim_task to executor

```typescript
// Source: shared/types.ts ReclaimTaskPayload
import type { ReclaimTaskPayload } from "../../shared/types.ts";

async function sendReclaimTask(
  myId: PeerId,
  executorId: PeerId,
  taskId: number,
  waveId: number,
  reason: string
): Promise<void> {
  const payload: ReclaimTaskPayload = { task_id: taskId, wave_id: waveId, reason };
  await brokerFetch("/send-message", {
    from_id: myId,
    to_id: executorId,
    text: `Reclaiming task ${taskId}: ${reason}`,
    msg_type: "reclaim_task",
    payload,
  });
  // Also mark task blocked in broker so wave-status reflects it
  await brokerFetch("/task-blocked", { task_id: taskId, reason });
}
```

### Using proxy helpers from orchestrator

```typescript
// Source: gsd-plugin/proxy/proxy-helpers.ts — both functions are exported for orchestrator use
import { sendDiscussChoice, waitForAnswer } from "../../proxy/proxy-helpers.ts";

// ORCH-06: route discuss-phase choice to proxy
await sendDiscussChoice(myId, proxyPeer.id, {
  phase_number: phaseNumber,
  phase_goal: phaseGoal,
  question: "Use REST or GraphQL for this API phase?",
  options: ["REST — simpler, fewer deps", "GraphQL — more flexible"],
  recommended: "REST — simpler, fewer deps",
  context: "Phase 3 builds the external API; Phase 5 frontend consumes it",
  prior_decisions: previousDecisions,
});

const answer = await waitForAnswer(myId, phaseNumber, 60_000); // PRXY-05: 60s timeout
const chosen = answer?.chosen ?? recommendedDefault; // PRXY-05: fallback to default
```

### Test pattern: isolated broker + dynamic import

```typescript
// Source: gsd-plugin/executor/executor-helpers.test.ts (lines 17-60)
// IMPORTANT: set env BEFORE any import of the helpers module
const TEST_BROKER_PORT = 17902; // unique port per test file
process.env.CLAUDE_PEERS_PORT = String(TEST_BROKER_PORT);

import { test, expect, describe, beforeAll, afterAll } from "bun:test";

const dbPath = `/tmp/claude-peers-orch-test-${Date.now()}.db`;
let brokerProc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  process.env.CLAUDE_PEERS_PORT = String(TEST_BROKER_PORT);
  process.env.CLAUDE_PEERS_DB = dbPath;
  brokerProc = Bun.spawn(["bun", "broker.ts"], {
    env: { ...process.env, CLAUDE_PEERS_PORT: String(TEST_BROKER_PORT), CLAUDE_PEERS_DB: dbPath },
    stdout: "pipe",
  });
  await new Promise(r => setTimeout(r, 500)); // wait for broker startup
  // Dynamic import so env override takes effect before module-level BROKER_URL is evaluated
  const mod = await import("./orchestrator-helpers.ts");
  // assign exported functions...
});

afterAll(async () => {
  brokerProc.kill();
  try { unlinkSync(dbPath); } catch {}
});
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Sequential per-phase autonomous (single session) | Parallel wave-based execution (multi-peer) | Phase 4 (this phase) | N phases in parallel instead of serial |
| User prompted for discuss-phase choices | Decision proxy peer answers autonomously | Phase 3 complete | Fully unattended autonomous runs |
| Executor push at end of phase | Push after each task commit | Phase 2 design | Conflict detection happens early, not on merge |

**Deprecated/outdated:**
- `/gsd:autonomous` sequential loop: Still valid for single-session use. The orchestrator falls back to it when no peers are available (ORCH-12). Do not replace or modify it.

---

## Open Questions

1. **ROADMAP.md dependency format**
   - What we know: GSD-generated ROADMAP.md is free-form markdown; `roadmap analyze` returns phase names/goals/status but not explicit dep edges
   - What's unclear: Whether any ROADMAP.md in the wild includes explicit "depends on" language, or whether all dependencies must be LLM-inferred
   - Recommendation: Implement explicit parsing first (regexp for "depends on phase N", "requires phase N", "after phase N"); add LLM inference as fallback; test against this project's own ROADMAP.md

2. **Who calls /task-start**
   - What we know: executor agent doc Step 2d says executor calls `callTaskStart`; design doc says orchestrator calls `/task-start` before sending `execute_phase`
   - What's unclear: Which is the authoritative spec; double-calling is harmless (second call returns error but executor ignores it)
   - Recommendation: Let the executor own `/task-start` (as the agent doc specifies). Orchestrator only calls `/wave-create` to create tasks in "pending" state. Document this explicitly in orchestrator-helpers.ts.

3. **GSD workflow invocation from orchestrator agent**
   - What we know: `gsd:autonomous` skill at `/home/joshuaduffill/.claude/get-shit-done/workflows/autonomous.md` handles sequential execution; `gsd:plan-phase` and `gsd:execute-phase` are the sub-skill invocations
   - What's unclear: Whether the orchestrator agent can call `Skill("gsd:plan-phase", args)` directly (like the sequential autonomous does) or whether it must use a different invocation pattern
   - Recommendation: The orchestrator agent doc should follow the same `Skill()` invocation pattern as the existing `autonomous.md` workflow (lines 152-155), which uses `Skill(skill="gsd:plan-phase", args="${PHASE_NUM}")`. This is already proven to work.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | bun:test (built-in) |
| Config file | none — `bun test` auto-discovers `*.test.ts` |
| Quick run command | `bun test gsd-plugin/orchestrator/orchestrator-helpers.test.ts` |
| Full suite command | `bun test` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ORCH-01 | `discoverPeers` calls `/peer-availability` with correct repo + exclude_id | unit/integration | `bun test gsd-plugin/orchestrator/orchestrator-helpers.test.ts` | Wave 0 |
| ORCH-02 | Proxy classified by "decision proxy" substring in summary | unit | `bun test gsd-plugin/orchestrator/orchestrator-helpers.test.ts` | Wave 0 |
| ORCH-03 | `buildExecutionWaves` produces correct wave grouping; cycle detection throws | unit | `bun test gsd-plugin/orchestrator/orchestrator-helpers.test.ts` | Wave 0 |
| ORCH-04 | Wave grouping places all no-dep phases in wave 0 | unit | `bun test gsd-plugin/orchestrator/orchestrator-helpers.test.ts` | Wave 0 |
| ORCH-05 | `sendExecutePhase` sends correct payload; task is in pending state first | integration | `bun test gsd-plugin/orchestrator/orchestrator-helpers.test.ts` | Wave 0 |
| ORCH-06 | `sendDiscussChoice` + `waitForAnswer` route correctly (via proxy-helpers.ts) | integration | `bun test gsd-plugin/orchestrator/orchestrator-helpers.test.ts` | Wave 0 |
| ORCH-07 | `pollWaveStatus` returns task states; wave "completed" after all tasks done | integration | `bun test gsd-plugin/orchestrator/orchestrator-helpers.test.ts` | Wave 0 |
| ORCH-08 | `sendStatusRequest` sent after 120s silence; `sendReclaimTask` called after 30s timeout | unit (time-stubbed) | `bun test gsd-plugin/orchestrator/orchestrator-helpers.test.ts` | Wave 0 |
| ORCH-09 | Git log check after executor death; task reset to pending on no-partial-work path | integration | `bun test gsd-plugin/orchestrator/orchestrator-helpers.test.ts` | Wave 0 |
| ORCH-10 | Post-wave sync calls git pull, re-reads ROADMAP.md, refreshes peer list | integration | `bun test gsd-plugin/orchestrator/orchestrator-helpers.test.ts` | Wave 0 |
| ORCH-11 | Delegation decision: `<3 tasks` → execute locally; `human_action` checkpoint → execute locally | unit | `bun test gsd-plugin/orchestrator/orchestrator-helpers.test.ts` | Wave 0 |
| ORCH-12 | Empty peer list → returns `{ mode: "sequential" }` without error | unit | `bun test gsd-plugin/orchestrator/orchestrator-helpers.test.ts` | Wave 0 |
| ORCH-13 | Conflicting phases in same wave → split into synthetic sub-waves | unit | `bun test gsd-plugin/orchestrator/orchestrator-helpers.test.ts` | Wave 0 |

### Sampling Rate

- **Per task commit:** `bun test gsd-plugin/orchestrator/orchestrator-helpers.test.ts`
- **Per wave merge:** `bun test`
- **Phase gate:** Full suite (`bun test`) green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `gsd-plugin/orchestrator/orchestrator-helpers.test.ts` — covers ORCH-01 through ORCH-13
- [ ] `gsd-plugin/orchestrator/orchestrator-helpers.ts` — the implementation module (obviously)
- [ ] `gsd-plugin/agents/gsd-orchestrator.md` — orchestrator agent document
- [ ] `gsd-plugin/workflows/autonomous-peers.md` — `/gsd:autonomous-peers` workflow document

---

## Sources

### Primary (HIGH confidence)

- `design-peer-autonomous-orchestrator.md` — Full orchestrator design with state machine, peer classification, wave dispatch loop, executor death handling, delegation logic
- `design-peer-autonomous.md` — Full combined design document; Parts 1-7 covering orchestrator, executor, shared decisions, broker changes, error recovery matrix
- `shared/types.ts` — All payload interfaces: `ExecutePhasePayload`, `PhaseCompletePayload`, `PhaseBlockedPayload`, `PhaseProgressPayload`, `StatusRequestPayload`, `StatusResponsePayload`, `ReclaimTaskPayload`, `DiscussChoicePayload`, `DiscussAnswerPayload`, `PeerAvailabilityRequest`, `PeerAvailabilityResponse`
- `broker.ts` lines 603-765 — `handleWaveCreate`, `handleWaveStatus`, `handleTaskStart`, `handleTaskComplete`, `handleTaskBlocked`, `handlePeerAvailability` implementations
- `gsd-plugin/executor/executor-helpers.ts` — `brokerFetch` pattern, all executor helper functions
- `gsd-plugin/proxy/proxy-helpers.ts` — `sendDiscussChoice`, `waitForAnswer`, `ackMessages` (re-usable by orchestrator)
- `gsd-plugin/agents/gsd-executor.md` — Executor agent doc (model for orchestrator agent doc structure; clarifies `/task-start` ownership)
- `gsd-plugin/agents/gsd-proxy.md` — Proxy agent doc (proxy summary string, state machine)
- `gsd-plugin/executor/executor-helpers.test.ts` — Test pattern (isolated broker, dynamic import, unique port)
- `.planning/STATE.md` — Known blockers: ROADMAP.md dep format uncertainty, branch strategy decision

### Secondary (MEDIUM confidence)

- Kahn's algorithm — Standard computer science; well-known BFS topological sort; no external source needed for correctness

### Tertiary (LOW confidence)

- None

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries are built-in to Bun; broker endpoints are implemented and verified in broker.ts
- Architecture: HIGH — design documents are fully specified; code patterns match exactly the executor/proxy precedent
- Pitfalls: HIGH for pitfalls 1-4 (derived from reading actual code); MEDIUM for pitfall 5 (conflict serialization logic not yet implemented, edge case reasoning)

**Research date:** 2026-03-25
**Valid until:** 2026-04-25 (stable — no external dependencies; all internals)
