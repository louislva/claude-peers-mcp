# Technology Stack

**Project:** gsd-comms-mcp — Peer-aware autonomous orchestration milestone
**Researched:** 2026-03-25
**Confidence:** HIGH (all findings verified against existing codebase, Bun docs, design doc)

---

## Summary Verdict

**Zero new dependencies required.** Every capability needed for peer-aware autonomous orchestration is already provided by the existing stack: Bun 1.3.x, bun:sqlite, @modelcontextprotocol/sdk, and the existing broker HTTP API. The new milestone is pure TypeScript logic on top of what already exists.

---

## Existing Stack (Validated, Do Not Re-Research)

| Technology | Version | Role |
|------------|---------|------|
| Bun | 1.3.11 | Runtime, shell execution, HTTP client |
| TypeScript | ^5 | Type safety across all modules |
| bun:sqlite | built-in | All state — peers, messages, sessions, waves, tasks |
| @modelcontextprotocol/sdk | ^1.27.1 | MCP stdio server, channel push protocol |
| Bun.serve() | built-in | Broker HTTP daemon |
| Bun.$`` | built-in | Git command execution |

---

## New Capabilities Analysis

### 1. Dependency Graph Analysis

**What's needed:** Topological sort of phases extracted from ROADMAP.md to produce execution waves.

**Decision: No library. Implement inline.**

Rationale: The dependency graph for GSD phases is acyclic (phases cannot depend on later phases), small (typically 3–10 phases), and the input is unstructured markdown text that must be LLM-parsed anyway. A topological sort on a small DAG is ~30 lines of TypeScript using Kahn's algorithm. Adding a library like `graphology`, `toposort`, or `dependency-graph` would import a package for logic that is trivially self-contained and would need custom integration code regardless.

```typescript
// All that's needed — no library required
function topoSort(phases: Map<number, number[]>): number[][] {
  // Kahn's algorithm → returns phases grouped into waves
}
```

**Confidence:** HIGH — verified against design doc Phase dependency_analysis step, which specifies exactly this algorithm.

---

### 2. State Machine Management

**What's needed:** Orchestrator state machine (INIT → DISCOVER → PLAN → EXECUTE → SYNC) and executor state machine (IDLE → ACK → SETUP → EXECUTING → COMPLETING → IDLE).

**Decision: No library. Pure TypeScript control flow.**

Rationale: Both state machines from the design doc are linear pipelines with 5–7 states and straightforward transitions. The orchestrator loop is a `for...of` over waves with conditional branching. The executor is a message handler with a status variable. Libraries like `xstate` or `robot3` add meaningful value only when state machines have many states, cross-cutting guards, parallel sub-machines, or need visual tooling. Neither applies here.

The existing codebase already implements analogous state logic (wave status transitions, task status transitions) as direct SQLite updates without a library — the new code should follow the same pattern.

**Confidence:** HIGH — verified by reading broker.ts state transitions and design doc state machine diagrams.

---

### 3. Timeout and Retry Handling

**What's needed:**
- 60s timeout waiting for decision proxy response
- 15s ACK timeout from executor after `execute_phase`
- 30s liveness timeout (no `status_response` → assume dead)
- 120s stalled-task detection in wave polling
- Single retry on git push conflict (rebase once, then `phase_blocked`)

**Decision: Use `AbortSignal.timeout()` — already in Bun. No library.**

Bun 1.x fully supports the Web Platform `AbortSignal.timeout(ms)` API, which is already used in `server.ts` (`AbortSignal.timeout(2000)` for broker health check). The same pattern covers all timeout cases. Retry logic for git rebase-and-push is a manual two-attempt loop — no library adds value here.

```typescript
// Already used in server.ts — same pattern for all new timeouts
const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
```

**Confidence:** HIGH — pattern verified in existing `server.ts` line 61.

---

### 4. Branch Management Automation

**What's needed:** Create wave branch, push after each task commit, rebase on conflict, merge wave branch to main after wave completion.

**Decision: `Bun.$` shell execution. No library.**

All git operations required by the design doc are simple CLI invocations:
- `git checkout -b wave-N`
- `git push origin wave-N`
- `git pull --rebase origin wave-N`
- `git merge --no-ff wave-N`
- `git log --oneline -5`

`Bun.$` (Bun's shell API, already used in the codebase) handles all of these. A library like `simple-git` or `isomorphic-git` would add ~300KB and wrap the same CLI calls with no benefit for this set of operations.

**Confidence:** HIGH — CLAUDE.md explicitly specifies `Bun.$` for shell operations.

---

### 5. Workflow Orchestration (Wave Polling Loop)

**What's needed:** Poll `/wave-status` every 10s during execution, handle task state changes, dispatch to peers, detect stalled executors.

**Decision: `setInterval` + `fetch`. No library.**

The existing broker already implements this pattern: `setInterval` for heartbeats (15s), `setInterval` for auto-prune (5min), `setInterval` for WAL checkpoint (2min). The wave polling loop is the same pattern. No workflow engine (Temporal, Bull, etc.) is warranted for a single-process coordinator managing 2–8 tasks.

**Confidence:** HIGH — pattern verified throughout broker.ts and server.ts.

---

### 6. New Broker Endpoint: `/peer-availability`

**What's needed:** Single endpoint combining list-peers + session-status + wave-status to return available and busy peers.

**Decision: Pure bun:sqlite query in broker.ts. No new dependency.**

This is a JOIN across `peers`, `sessions`, and `task_assignments` tables — all already in the existing schema. The implementation is a single prepared statement and ~20 lines of handler code in broker.ts following the exact patterns already present.

**Confidence:** HIGH — tables and query patterns verified in broker.ts.

---

### 7. New Message Types

**What's needed:** `execute_phase`, `phase_complete`, `phase_blocked`, `phase_progress`, `status_request`, `status_response`, `reclaim_task`, `discuss_choice`, `discuss_answer`

**Decision: Extend `MessageType` union in `shared/types.ts`. No schema change.**

The `messages` table already stores `msg_type` as TEXT with no constraint — the broker accepts any string. The MCP SDK tools already pass `msg_type` and `payload` as free-form fields. Adding new message types requires only updating the TypeScript union type in `shared/types.ts` and adding the new payload interfaces. Note: `status_request` and `status_response` are already in the `MessageType` union.

```typescript
// Current in shared/types.ts (line 15):
export type MessageType = "chat" | "task_complete" | "task_blocked" | "wave_advance" | "status_request" | "status_response";

// Needs to become:
export type MessageType =
  | "chat" | "status_request" | "status_response"
  | "execute_phase" | "phase_complete" | "phase_blocked" | "phase_progress"
  | "reclaim_task" | "discuss_choice" | "discuss_answer"
  | "task_complete" | "task_blocked" | "wave_advance"; // preserve existing
```

**Confidence:** HIGH — verified against broker.ts message handling and types.ts line 15.

---

### 8. Executor Agent / Orchestrator Agent Files

**What's needed:** New agent markdown files (`gsd-autonomous-peers-orchestrator.md`, `gsd-executor.md`) in `gsd-plugin/agents/` following the existing pattern of `gsd-peer-coordinator.md`.

**Decision: Markdown agent files. No new tooling.**

The existing codebase uses markdown files as agent instruction sets (see `gsd-plugin/agents/gsd-peer-coordinator.md`). The new orchestrator and executor agents follow this exact pattern. No template engine, no code generation tool.

**Confidence:** HIGH — pattern verified by reading existing agent file.

---

## What NOT to Add

| Package | Why Not |
|---------|---------|
| `graphology` / `toposort` | Dependency graph is trivially small; Kahn's algorithm is 30 lines |
| `xstate` / `robot3` | State machines have 5–7 states, no parallel sub-machines, no visual tooling needed |
| `simple-git` / `isomorphic-git` | Bun.$ handles all needed git ops; library adds weight with no benefit |
| `p-queue` / `bottleneck` | Task queue is managed by broker wave/task state; no in-process queue needed |
| `retry` / `p-retry` | Two-attempt git retry and 60s poll timeout is a manual loop; no library needed |
| `zod` (new usage) | Already available transitively via @modelcontextprotocol/sdk but not needed for new payload types — TypeScript interfaces suffice for internal types |
| Temporal / Bull / BullMQ | Overkill; orchestration is localhost-only, single process, 2–8 concurrent tasks |
| WebSockets upgrade | Polling at 10s intervals over localhost HTTP is sufficient; adds no meaningful latency |

---

## Integration Points

All new code plugs into the existing architecture at exactly three seams:

1. **broker.ts** — Add `/peer-availability` endpoint (~40 lines). Extend `pruneOldData` if needed for new retention rules. No schema migration required.

2. **shared/types.ts** — Extend `MessageType` union, add payload interfaces for the 9 new message types.

3. **gsd-plugin/agents/** — Add two new markdown agent files: orchestrator (implements the design doc Part 1 + Part 3 logic) and executor (implements Part 2 + Part 3 logic).

No changes to `server.ts`, `cli.ts`, `broker.test.ts` (beyond adding tests for the new endpoint), or existing agent/hook files.

---

## Final Stack (New Milestone)

```
Existing:
  bun 1.3.11          — runtime, shell, HTTP, timers
  bun:sqlite          — all state (no changes to schema)
  @modelcontextprotocol/sdk ^1.27.1  — MCP protocol
  TypeScript ^5       — type safety

Added:
  (nothing)
```

The implementation surface is:
- ~40 lines in broker.ts (new endpoint)
- ~30 lines in shared/types.ts (type extensions)
- ~2 new markdown agent files in gsd-plugin/agents/
- ~1 new TypeScript module: `gsd-plugin/agents/autonomous-peers-runtime.ts` (topological sort + wave polling loop, ~150–200 lines)

---

## Sources

- Verified against `/home/joshuaduffill/dev/claude-peers-mcp/broker.ts` (current implementation)
- Verified against `/home/joshuaduffill/dev/claude-peers-mcp/shared/types.ts` (current types)
- Verified against `/home/joshuaduffill/dev/claude-peers-mcp/server.ts` (AbortSignal.timeout pattern, line 61)
- Verified against `/home/joshuaduffill/dev/claude-peers-mcp/package.json` (current dependencies)
- Verified against `/home/joshuaduffill/dev/claude-peers-mcp/CLAUDE.md` (Bun API mandate)
- Verified against `/home/joshuaduffill/dev/claude-peers-mcp/design-peer-autonomous.md` (feature requirements)
- Bun 1.3.11 built-in APIs: AbortSignal.timeout, Bun.$, bun:sqlite (HIGH confidence — Bun version confirmed via `bun --version`)
