# Phase 5: Runtime Module and Tests - Research

**Researched:** 2026-03-25
**Domain:** TypeScript module extraction, Bun test integration, smoke test documentation
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
None — all implementation choices are at Claude's discretion.

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Key areas:
- Runtime module file location and name (e.g., `gsd-plugin/autonomous-peers-runtime.ts`)
- Which functions to extract vs leave in orchestrator-helpers (topological sort + wave poll are the targets)
- Whether to re-export from orchestrator-helpers for backwards compatibility
- Smoke test runbook format (markdown document with step-by-step instructions)
- Test structure for extracted runtime module

### Deferred Ideas (OUT OF SCOPE)
None
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| BRKR-04 | `/peer-availability` endpoint has integration test coverage | Five existing tests cover the endpoint (lines 588-697 in broker.test.ts). The requirement specifies three specific scenarios as success criteria that must be present: available-only, busy-only, and mixed peers. Current tests cover available-only and busy-only but the "mixed" state (at least one available AND at least one busy in the same query) is not explicitly tested — this gap must be closed. |
</phase_requirements>

---

## Summary

Phase 5 is a pure infrastructure and testing phase. No new production features are introduced. The work has three deliverables: (1) extract `buildExecutionWaves` (Kahn's algorithm) and `waitForWaveComplete` (wave polling loop) from `orchestrator-helpers.ts` into a standalone `gsd-plugin/autonomous-peers-runtime.ts` module, (2) add a broker integration test for the `/peer-availability` endpoint covering the mixed-state scenario, and (3) write a developer-facing markdown smoke test runbook for the two-session executor handshake.

The extraction is a move-and-re-export operation, not a rewrite. Both functions are already fully tested in `orchestrator-helpers.test.ts` (29 tests, all passing). The runtime module's public API surface mirrors what those tests already exercise. Backwards compatibility is maintained by re-exporting from `orchestrator-helpers.ts`, keeping all existing imports valid.

The `/peer-availability` test gap is narrow. Five tests already exist in `broker.test.ts` (lines 588-697). The missing scenario is a single query returning at least one available peer AND at least one busy peer simultaneously — the "mixed" state. One additional test closes BRKR-04.

**Primary recommendation:** Extract functions by cut-and-paste (preserving exact implementations), re-export from the original file, add one `broker.test.ts` test for mixed peer state, write the smoke test runbook.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| bun:test | Built-in (Bun 1.x) | Test runner | Project-mandated in CLAUDE.md |
| bun:sqlite | Built-in | Broker data store (indirect) | Project-mandated in CLAUDE.md |
| TypeScript | Built-in via Bun | Type checking | Project language |

No new dependencies are needed for this phase. All tooling is already installed and in use.

**Version verification:** Bun 1.3.11 is currently in use (confirmed via `bun test` output). No npm packages to add.

---

## Architecture Patterns

### Recommended Project Structure After Phase 5
```
gsd-plugin/
├── autonomous-peers-runtime.ts     # NEW: extracted Kahn's sort + wave poll loop
├── orchestrator/
│   └── orchestrator-helpers.ts     # MODIFIED: re-exports from runtime module
│   └── orchestrator-helpers.test.ts # UNCHANGED: still passes against re-exports
broker.test.ts                      # MODIFIED: +1 test for mixed peer-availability
docs/
└── smoke-test-executor-handshake.md  # NEW: two-session runbook
```

### Pattern 1: Module Extraction with Re-Export for Backwards Compatibility

**What:** Move target functions to a new module; in the original module, replace the function body with a re-export statement.

**When to use:** When extracted functions need independent testability but existing callers must not break.

**Example:**
```typescript
// gsd-plugin/autonomous-peers-runtime.ts  (NEW)
export { PhaseNode } from "./orchestrator/orchestrator-helpers.ts"; // if needed
export function buildExecutionWaves(phases: PhaseNode[]): PhaseNode[][] {
  // ... exact implementation moved here ...
}
export async function waitForWaveComplete(
  myId: PeerId,
  waveId: number,
  assignments: Map<number, PeerId>
): Promise<{ completed: PhaseCompletePayload[]; blocked: PhaseBlockedPayload[]; reclaimed: number[] }> {
  // ... exact implementation moved here ...
}

// gsd-plugin/orchestrator/orchestrator-helpers.ts  (MODIFIED)
export { buildExecutionWaves, waitForWaveComplete } from "../autonomous-peers-runtime.ts";
// existing function declarations REMOVED — exported via re-export above
```

**IMPORTANT:** `waitForWaveComplete` depends on `pollOrchestratorMessages`, `ackMessages`, `reclaimExecutorTask`, and `sendStatusRequest` from orchestrator-helpers.ts. The runtime module must either:
  - Option A: Import those helpers from orchestrator-helpers (creates a circular dependency — avoid)
  - Option B: Co-extract the helper functions `pollOrchestratorMessages`, `ackMessages`, `sendStatusRequest`, and `reclaimExecutorTask` into the runtime module as well
  - Option C: Accept a `brokerFetch`-style callback injection for testability (over-engineering for this phase)

**Recommended: Option B.** Extract the full set of runtime-needed functions into `autonomous-peers-runtime.ts`. The orchestrator-helpers module retains only the pre-dispatch and planning-phase functions (`discoverPeers`, `parseRoadmapPhases`, `checkWaveConflicts`, `dispatchWave`, `shouldDelegate`, `handleExecutorDeath`, `postWaveSync`).

The `brokerFetch` function must also be copied (duplicated) into the runtime module — this is consistent with the established per-module self-contained pattern documented in STATE.md: "brokerFetch duplicated inside orchestrator-helpers.ts (not imported cross-module) per established per-module self-contained pattern."

### Pattern 2: Self-Contained Module (brokerFetch Duplication)

**What:** Each module that calls the broker duplicates the `brokerFetch` helper locally rather than importing from a shared util module.

**Why this is the established pattern:**
> "brokerFetch duplicated inside orchestrator-helpers.ts (not imported cross-module) per established per-module self-contained pattern" — STATE.md

**Apply to runtime module:** Copy the `brokerFetch` function verbatim into `autonomous-peers-runtime.ts`. Do not import it.

### Pattern 3: Dynamic Import in Test beforeAll for Port Override

**What:** Set `process.env.CLAUDE_PEERS_PORT` before dynamically importing the module under test so the `BROKER_URL` constant captures the test port.

**Example (from orchestrator-helpers.test.ts):**
```typescript
// IMPORTANT: Set port override BEFORE dynamic import so BROKER_URL constant is set correctly.
const TEST_PORT = "17904";  // unique port for this test file
process.env.CLAUDE_PEERS_PORT = TEST_PORT;

let helpers: typeof import("../autonomous-peers-runtime.ts");

beforeAll(async () => {
  // start isolated broker on TEST_PORT ...
  helpers = await import("../autonomous-peers-runtime.ts");
});
```

**Port allocation:** Existing test ports are 17899 (broker.test.ts), 17901 (executor-helpers.test.ts), 17902 (proxy-helpers.test.ts), 17903 (orchestrator-helpers.test.ts). Use **17904** for any new test file targeting autonomous-peers-runtime.ts.

### Pattern 4: Isolated Broker Per Test File

**What:** Each test file spawns its own broker on a unique port with a unique temp DB path, and kills it in `afterAll`.

**Why:** Tests are isolated, parallelizable, and leave no state behind.

**Example template (already used in all test files):**
```typescript
const TEST_PORT = "17904";
const dbPath = `/tmp/claude-peers-runtime-test-${Date.now()}.db`;
let brokerProc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  brokerProc = Bun.spawn(["bun", "/absolute/path/to/broker.ts"], {
    env: { ...process.env, CLAUDE_PEERS_PORT: TEST_PORT, CLAUDE_PEERS_DB: dbPath },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
});

afterAll(() => {
  brokerProc?.kill();
  try { unlinkSync(dbPath); } catch {}
  delete process.env.CLAUDE_PEERS_PORT;
});
```

### Anti-Patterns to Avoid

- **Circular imports:** Do NOT have `autonomous-peers-runtime.ts` import from `orchestrator-helpers.ts`. The runtime module is meant to be independently loadable.
- **Shared brokerFetch import:** Do NOT create a `shared/broker.ts` — the codebase pattern is explicit duplication per module.
- **Test port collision:** Do NOT reuse an existing test port (17899, 17901-17903). Port collision causes flaky tests.
- **Static import of runtime module in test files:** Use dynamic import in `beforeAll` to ensure env var override is effective before the module constant is evaluated.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Test runner | Custom harness | `bun:test` (`test`, `expect`, `describe`, `beforeAll`, `afterAll`) | Project standard, built-in, zero config |
| HTTP calls in tests | `fetch` wrapper reimplementation | Copy `brokerPost` pattern from `broker.test.ts` | Simple enough inline, consistent with existing tests |
| Process management in tests | External test orchestrator | `Bun.spawn` + `proc.kill()` | Established pattern in all existing test files |
| Module import isolation | Jest module mocking | `process.env` + dynamic `import()` | Established pattern for broker port override |

**Key insight:** The entire test infrastructure pattern is already established and consistent across all 4 existing test files. The new test file (if any) must follow the same pattern exactly.

---

## Common Pitfalls

### Pitfall 1: Circular Import After Extraction

**What goes wrong:** `waitForWaveComplete` calls `pollOrchestratorMessages`, `ackMessages`, `sendStatusRequest`, and `reclaimExecutorTask`. If those stay in `orchestrator-helpers.ts` while `waitForWaveComplete` moves to `autonomous-peers-runtime.ts`, a circular import forms.

**Why it happens:** Incomplete extraction — moving the visible function without moving its private dependencies.

**How to avoid:** Extract the full cluster of runtime functions together: `pollOrchestratorMessages`, `ackMessages`, `sendStatusRequest`, `reclaimExecutorTask`, `waitForWaveComplete`, and `buildExecutionWaves` all belong in the runtime module. `brokerFetch` and `BROKER_URL`/`BROKER_PORT` constants must also be duplicated.

**Warning signs:** TypeScript compiler error referencing circular dependency, or `import` statements crossing module boundaries between `autonomous-peers-runtime.ts` and `orchestrator-helpers.ts`.

### Pitfall 2: Existing Tests Break After Extraction

**What goes wrong:** `orchestrator-helpers.test.ts` imports from `orchestrator-helpers.ts`. If the re-exports are omitted or have a different signature, 29 tests break.

**Why it happens:** Partial re-export — forgetting `PhaseNode` type export, or changing function signatures during the move.

**How to avoid:** After extraction, run `bun test gsd-plugin/orchestrator/orchestrator-helpers.test.ts` immediately. All 29 tests must pass before continuing. The re-export must include every exported identifier that existed before.

**Warning signs:** TypeScript "Module has no exported member" errors, or test failures in `orchestrator-helpers.test.ts` after the move.

### Pitfall 3: Static Import Captures Wrong Port

**What goes wrong:** If `autonomous-peers-runtime.ts` is imported with a static `import` at the top of a test file, the `BROKER_URL` constant is evaluated before `process.env.CLAUDE_PEERS_PORT` is set in `beforeAll`, so the module connects to port 7899 (the default) instead of the test broker.

**Why it happens:** Module-level constants in JavaScript/TypeScript are evaluated at import time, not at call time.

**How to avoid:** Always use dynamic `import()` inside `beforeAll` after setting the env var. This pattern is already documented in STATE.md and used in `orchestrator-helpers.test.ts`.

### Pitfall 4: Missing "Mixed" Peer State Test

**What goes wrong:** BRKR-04 requirement says "integration test coverage for `/peer-availability` covering available-only, busy-only, and mixed peer states." The current tests cover available-only and busy-only as separate tests, but no test registers both types in the same query.

**Why it matters:** The "mixed" state test proves the endpoint returns the correct structure when both categories are populated simultaneously — a different code path than all-available or all-busy.

**How to avoid:** Add a single test that registers two peers: one idle, one with a running task (via `session-heartbeat` + `wave-create` + `task-start`). Call `/peer-availability` and assert `repo_peers.available.length >= 1` AND `repo_peers.busy.length >= 1` in the same response.

### Pitfall 5: Smoke Test Runbook Is Too Abstract

**What goes wrong:** The runbook says "start an executor" without specifying exact commands, env vars, or expected output. A developer following it cannot verify the handshake without guessing.

**Why it happens:** Writing the runbook at a "design doc" level rather than "terminal paste" level.

**How to avoid:** Every step must be a concrete shell command or an exact Claude Code action. Include the expected broker output (from `bun cli.ts status` or `bun cli.ts peers`) at each verification point. Reference the specific message types: `execute_phase` → `status_response (acknowledged)` → `phase_complete`.

---

## Code Examples

Verified patterns from the existing codebase:

### Minimum Structure for autonomous-peers-runtime.ts
```typescript
// Source: extracted from gsd-plugin/orchestrator/orchestrator-helpers.ts
/**
 * autonomous-peers-runtime.ts
 *
 * Standalone runtime module: Kahn's topological sort (buildExecutionWaves)
 * and the wave polling loop (waitForWaveComplete).
 * Independently unit-testable without importing orchestrator-helpers.ts.
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

// NOTE: brokerFetch duplicated per established per-module self-contained pattern.
const BROKER_PORT = process.env.CLAUDE_PEERS_PORT ?? "7899";
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

async function brokerFetch<T>(path: string, body: unknown): Promise<T> { ... }

// Re-exported from orchestrator-helpers.ts for type sharing
export interface PhaseNode { ... }

export function buildExecutionWaves(phases: PhaseNode[]): PhaseNode[][] { ... }
export async function pollOrchestratorMessages(myId: PeerId): Promise<...> { ... }
export async function ackMessages(messageIds: number[]): Promise<void> { ... }
export async function sendStatusRequest(...): Promise<void> { ... }
export async function reclaimExecutorTask(...): Promise<void> { ... }
export async function waitForWaveComplete(...): Promise<...> { ... }
```

### Re-Export Pattern in orchestrator-helpers.ts
```typescript
// Source: established pattern, analogous to existing re-exports in orchestrator-helpers.ts
// Replace the function bodies for buildExecutionWaves and waitForWaveComplete with:
export {
  buildExecutionWaves,
  waitForWaveComplete,
  pollOrchestratorMessages,
  ackMessages,
  sendStatusRequest,
  reclaimExecutorTask,
} from "../autonomous-peers-runtime.ts";
// Also re-export PhaseNode if it moves to the runtime module:
export type { PhaseNode } from "../autonomous-peers-runtime.ts";
```

### Mixed Peer State Test for broker.test.ts
```typescript
// Source: follows pattern from existing peer-availability tests (broker.test.ts lines 620-655)
test("/peer-availability returns both available and busy peers in mixed state", async () => {
  const REPO = "/tmp/mixed-availability-test";

  // Register idle peer via /register
  const idlePeer = await brokerPost<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp/mixed-idle",
    git_root: REPO,
    tty: null,
    summary: "idle peer",
  });

  // Register busy peer via session-heartbeat + wave + task-start
  const hb = await brokerPost<{ peer_id: string }>("/session-heartbeat", {
    session_id: "mixed-busy-session",
    pid: /* a different real PID */ dummyPid ?? 1,
    cwd: "/tmp/mixed-busy",
    git_root: REPO,
    task_summary: "executing phase",
  });
  const wave = await brokerPost<{ wave_id: number; task_ids: number[] }>("/wave-create", {
    repo: REPO, phase: 88, wave_number: 1,
    tasks: [{ name: "mixed-busy-task", files: [] }],
  });
  await brokerPost("/task-start", {
    task_id: wave.task_ids[0],
    session_id: "mixed-busy-session",
  });

  const res = await brokerPost<{
    repo_peers: { available: { id: string }[]; busy: { id: string }[] }
  }>("/peer-availability", { repo: REPO });

  expect(res.repo_peers.available.length).toBeGreaterThanOrEqual(1);
  expect(res.repo_peers.busy.length).toBeGreaterThanOrEqual(1);
  expect(res.repo_peers.available.find((p) => p.id === idlePeer.id)).toBeDefined();
  expect(res.repo_peers.busy.find((p) => p.id === hb.peer_id)).toBeDefined();

  // Cleanup
  await brokerPost("/unregister", { id: idlePeer.id });
  await brokerPost("/session-end", { session_id: "mixed-busy-session" });
});
```

**Note:** `broker.test.ts` does NOT use dynamic import or a separate broker process — it shares the single `brokerProc` from `beforeAll`. This test follows that same pattern. It does NOT use `dummyPid` (that variable exists in `orchestrator-helpers.test.ts`, not in `broker.test.ts`). Use a hardcoded live PID (e.g., `1` for init) for the second peer's heartbeat, consistent with how the existing busy-peer test on line 621 uses `process.pid`.

### Smoke Test Runbook Structure (markdown document)
```markdown
# Two-Session Executor Handshake Smoke Test

Prerequisites: broker running, two Claude Code terminal sessions open in the same repo.

## Session A: Orchestrator

Step 1: Register orchestrator peer ...
Step 2: Send execute_phase message to Session B's peer ID ...
Step 3: Verify broker received phase_complete from Session B ...

## Session B: Executor

Step 1: Check messages (expect execute_phase) ...
Step 2: Acknowledge (sendAck) within 15 seconds ...
Step 3: Execute tasks and send phase_complete ...

## Verification Commands

bun cli.ts peers     # verify both peers registered
bun cli.ts status    # check wave/task state
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Functions co-located in orchestrator-helpers.ts | Extracted to autonomous-peers-runtime.ts | Phase 5 | Functions independently testable without full orchestrator context |
| No mixed-state test for /peer-availability | Explicit mixed-state integration test | Phase 5 | Closes BRKR-04, validates the query handles both categories simultaneously |

**Deprecated/outdated:**
- None — this phase does not deprecate or replace any existing patterns.

---

## Open Questions

1. **PhaseNode type location after extraction**
   - What we know: `PhaseNode` is currently exported from `orchestrator-helpers.ts`. It is referenced in `orchestrator-helpers.test.ts` via `typeof import("./orchestrator-helpers.ts").PhaseNode`.
   - What's unclear: Should `PhaseNode` move to `autonomous-peers-runtime.ts` (since `buildExecutionWaves` operates on it), or stay in `orchestrator-helpers.ts` (since `parseRoadmapPhases`, `checkWaveConflicts`, `dispatchWave` all use it)?
   - Recommendation: Move `PhaseNode` to `autonomous-peers-runtime.ts` (it is a runtime scheduling type, conceptually owned by the wave-building function). Re-export it from `orchestrator-helpers.ts` via `export type { PhaseNode }`. The test file's `typeof import` pattern continues to work because the re-export is transparent.

2. **Whether autonomous-peers-runtime.ts needs its own test file**
   - What we know: The phase success criteria say the module exports functions that are "independently unit-testable." The existing `orchestrator-helpers.test.ts` will continue to test them via re-exports.
   - What's unclear: Does "independently unit-testable" require a separate test file, or does passing through re-exports satisfy the criterion?
   - Recommendation: A minimal test file `gsd-plugin/autonomous-peers-runtime.test.ts` that imports directly from the new module (not via orchestrator-helpers) definitively proves independence. It can be thin — just a few tests that duplicate coverage from orchestrator-helpers.test.ts to prove the module works standalone. The planner should decide based on scope.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | bun:test (Bun 1.3.11) |
| Config file | none — bun test auto-discovers `*.test.ts` |
| Quick run command | `bun test broker.test.ts` |
| Full suite command | `bun test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BRKR-04 | `/peer-availability` returns correct structure for available-only state | integration | `bun test broker.test.ts` | Already exists (line 598) |
| BRKR-04 | `/peer-availability` returns correct structure for busy-only state | integration | `bun test broker.test.ts` | Already exists (line 621) |
| BRKR-04 | `/peer-availability` returns correct structure for mixed state (available + busy in same query) | integration | `bun test broker.test.ts` | Missing — Wave 0 gap |
| SC-1 | `buildExecutionWaves` importable from `autonomous-peers-runtime.ts` directly | unit | `bun test gsd-plugin/orchestrator/orchestrator-helpers.test.ts` (via re-export) | Exists — passes via re-export |
| SC-1 | `waitForWaveComplete` importable from `autonomous-peers-runtime.ts` directly | unit | `bun test gsd-plugin/orchestrator/orchestrator-helpers.test.ts` (via re-export) | Exists — passes via re-export |
| SC-3 | Smoke test runbook documents execute_phase → ack → phase_complete handshake | manual | manual walkthrough | Missing — Wave 0 gap |

### Sampling Rate
- **Per task commit:** `bun test broker.test.ts` (broker-side) and `bun test gsd-plugin/orchestrator/orchestrator-helpers.test.ts` (orchestrator-side)
- **Per wave merge:** `bun test` (full suite — all test files)
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] Mixed-state test case added to `broker.test.ts` — covers BRKR-04 third scenario
- [ ] `docs/smoke-test-executor-handshake.md` (or equivalent path) — runbook for SC-3

*(Existing test infrastructure covers all other phase requirements. No framework install needed.)*

---

## Sources

### Primary (HIGH confidence)
- `gsd-plugin/orchestrator/orchestrator-helpers.ts` — Source of functions to extract; complete implementation verified by code reading
- `gsd-plugin/orchestrator/orchestrator-helpers.test.ts` — 29 passing tests; test patterns, port allocation, dynamic import pattern
- `broker.test.ts` — 30 passing tests; existing peer-availability test coverage (lines 586-697)
- `.planning/STATE.md` — brokerFetch duplication decision, phase 4 orchestrator decisions, per-module self-contained pattern
- `.planning/phases/05-runtime-module-and-tests/05-CONTEXT.md` — Phase boundary and constraints

### Secondary (MEDIUM confidence)
- `gsd-plugin/executor/executor-helpers.ts` — Confirmed brokerFetch duplication pattern used across modules
- `gsd-plugin/agents/gsd-executor.md` — Executor lifecycle for smoke test runbook content

### Tertiary (LOW confidence)
- None

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all tooling already in use and verified
- Architecture: HIGH — extraction patterns observed directly in existing code; per-module duplication explicitly documented in STATE.md
- Pitfalls: HIGH — circular import and re-export issues are structural and detectable from code topology; dynamic import issue is documented in existing test files

**Research date:** 2026-03-25
**Valid until:** 2026-04-25 (stable codebase; no fast-moving external dependencies)
