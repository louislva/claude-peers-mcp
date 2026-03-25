# Architecture Patterns

**Domain:** Peer-aware autonomous execution layer for GSD + claude-peers-mcp
**Researched:** 2026-03-25
**Confidence:** HIGH — based on direct reading of all existing source files and the co-authored design document

---

## Existing Architecture (Baseline)

Before placing the new components, understand what already exists and what it owns.

```
Claude Session A (MCP stdio)           Claude Session B (MCP stdio)
  server.ts ─── polls/pushes             server.ts ─── polls/pushes
       │                                      │
       └──────────────┬───────────────────────┘
                      │ HTTP (localhost:7899)
                      ▼
              broker.ts (Bun.serve + bun:sqlite)
              ~/.claude-peers.db
              ┌─────────────┬──────────────┬──────────────┬───────────────┐
              │ peers       │ messages     │ sessions     │ waves +       │
              │ (live PIDs) │ (ACK-based)  │ (GSD hook)   │ task_assign.  │
              └─────────────┴──────────────┴──────────────┴───────────────┘

GSD PostToolUse hook (gsd-peers-sync.js)
  → fires on every tool use in GSD sessions
  → calls /session-heartbeat (atomic register + session upsert + summary sync)
  → no MCP dependency — raw HTTP to broker

gsd-peer-coordinator agent (gsd-peer-coordinator.md)
  → spawned by orchestrator when needed
  → read-only: /list-peers, /wave-status, /conflict-check
  → can send typed messages via /send-message
```

**What exists and must NOT be modified:**
- `broker.ts` — all endpoints, schema, transactions
- `server.ts` — MCP tool handlers, channel push loop
- `gsd-plugin/hooks/gsd-peers-sync.js` — PostToolUse hook
- `gsd-plugin/agents/gsd-peer-coordinator.md` — coordinator agent
- `shared/types.ts` — `MessageType` union, all interface shapes
- GSD itself — zero changes, ever

---

## New Architecture Overview

The new features add three components that layer on top of the existing system without modifying it:

```
┌─────────────────────────────────────────────────────────────────┐
│  NEW LAYER: Peer-aware autonomous execution                     │
│                                                                 │
│  /gsd:autonomous-peers (new GSD workflow file)                  │
│    └── orchestrator session                                     │
│          ├── discover_peers step (calls list_peers MCP tool)    │
│          ├── dependency_analysis step (reads ROADMAP.md)        │
│          ├── parallel_phase_loop (manages waves)                │
│          └── death_handling (monitors + reclaims)               │
│                                                                 │
│  executor-protocol.md (new GSD agent file in gsd-plugin/)       │
│    └── executor session (one per available peer)                │
│          ├── receives execute_phase message (channel push)      │
│          ├── runs gsd:execute-phase with --no-transition flag   │
│          ├── sends phase_progress / phase_complete / blocked    │
│          └── handles status_request / reclaim_task              │
│                                                                 │
│  decision-proxy.md (new GSD agent file in gsd-plugin/)          │
│    └── dedicated peer session (user-primed)                     │
│          ├── receives discuss_choice messages                   │
│          └── responds with discuss_answer                       │
└─────────────────────────────────────────────────────────────────┘
                      │ uses existing infrastructure
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│  EXISTING LAYER (unchanged)                                     │
│                                                                 │
│  broker.ts + bun:sqlite                                         │
│    ├── /list-peers, /send-message, /poll-messages, /ack-message │
│    ├── /wave-create, /wave-status, /task-start, /task-complete  │
│    ├── /task-blocked, /conflict-check                           │
│    └── NEW: /peer-availability (additive only)                  │
│                                                                 │
│  server.ts (MCP stdio per session)                              │
│    ├── list_peers, send_message, set_summary, check_messages    │
│    └── channel push loop (1s poll → notifications/claude/channel)│
│                                                                 │
│  gsd-peers-sync.js (PostToolUse hook, unchanged)                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Component Boundaries: New vs Existing

### Component 1: `/gsd:autonomous-peers` Workflow File

**What it is:** A new GSD workflow file, NOT a fork or modification of the existing `/gsd:autonomous`. Lives in the GSD workflows directory (same pattern as other GSD workflows). The design document refers to it as `/gsd:autonomous-peers` or `/gsd:autonomous --peers`.

**Where it lives:** As a new `.claude/commands/gsd/autonomous-peers.md` file (following GSD's convention), or equivalently as a GSD workflow registered via the usual mechanism. This is entirely separate from `gsd-plugin/` — it is the orchestrator brain, not a plugin.

**What it owns:**
- `discover_peers` step: calls `list_peers` MCP tool, classifies peers into `decision_proxy` and `available_executors[]`
- `dependency_analysis` step: reads ROADMAP.md, builds wave graph
- `parallel_phase_loop` step: manages the plan-then-distribute-then-wait-then-sync cycle per wave
- `executor_death_handling` step: detects dead peers via `/peer-availability` or failed message delivery
- Fallback path: if no peers found, behaves identically to standard `/gsd:autonomous`

**What it does NOT own:**
- Any planning logic (delegates to existing `gsd:discuss-phase`, `gsd:plan-phase`)
- Any execution logic (delegates to `gsd:execute-phase` locally, or sends `execute_phase` message to executor peers)
- Any broker persistence (reads wave status via existing endpoints)

**Integration with existing message flow:**
- Uses `send_message` MCP tool with typed payloads (`execute_phase`, `status_request`, `reclaim_task`, `discuss_choice`)
- Uses `check_messages` / channel push to receive `phase_complete`, `phase_blocked`, `phase_progress`, `status_response`, `discuss_answer`
- Creates waves via existing `/wave-create` endpoint
- Polls progress via existing `/wave-status` endpoint
- Calls existing `/conflict-check` before dispatching each phase to a peer

### Component 2: Executor Protocol (`gsd-plugin/agents/executor-protocol.md`)

**What it is:** A new agent file in `gsd-plugin/agents/` — an instruction document that defines how an executor peer session should behave when it receives an `execute_phase` message. Sits alongside the existing `gsd-peer-coordinator.md`.

**Where it lives:** `gsd-plugin/agents/executor-protocol.md`

**What it owns:**
- The executor lifecycle state machine: IDLE → ACK_RECEIVED → SETUP → EXECUTING → COMPLETING → IDLE
- Git setup steps (pull --rebase, validate plan file exists, conflict-check)
- Execution delegation to `gsd:execute-phase` with `--no-transition --auto` flags
- Progress reporting protocol (`phase_progress` messages after each task)
- Completion protocol (verify → push → `phase_complete` message → `/task-complete` → set_summary to idle)
- Blocked protocol (`phase_blocked` with reason category)
- Response to `status_request` (immediate, structured `status_response`)
- Response to `reclaim_task` (WIP commit, push, IDLE)

**Integration with existing message flow:**
- The executor session already has the PostToolUse hook firing → `/session-heartbeat` keeps it visible in broker
- Receives messages via channel push (existing mechanism in server.ts poll loop)
- Calls `/task-complete` and `/task-blocked` via broker HTTP (same endpoints used today)
- Does NOT call `/wave-create` or manage global state

**Critical constraint:** Executors never modify ROADMAP.md or STATE.md. The `--no-transition` flag passed to `gsd:execute-phase` enforces this. Orchestrator owns global GSD state.

### Component 3: Decision Proxy Agent (`gsd-plugin/agents/decision-proxy.md`)

**What it is:** A new agent file in `gsd-plugin/agents/` that defines a special long-running peer session the user primes with preferences before an autonomous run. Not a workflow — a persona/instruction set.

**Where it lives:** `gsd-plugin/agents/decision-proxy.md`

**What it owns:**
- How to receive and respond to `discuss_choice` messages
- How to reason about choices using stored preferences (in conversation context, not in broker)
- How to set its own summary to "Decision proxy — ..." so orchestrator can identify it
- Timeout handling (if decision proxy goes silent, orchestrator falls back to default recommendation)

**Integration with existing message flow:**
- No broker schema changes: uses existing `msg_type` string field with `discuss_choice` and `discuss_answer` values
- Channel push delivers `discuss_choice` messages immediately via existing 1s poll loop in server.ts
- Responds via `send_message` MCP tool (existing)
- Broker does not know this peer is a "decision proxy" — that classification happens in the orchestrator's `discover_peers` step based on summary string matching

### Component 4: `/peer-availability` Broker Endpoint (additive)

**What it is:** A single new endpoint in `broker.ts`. It is the only broker change required.

**What it does:** Combines `/list-peers` + `/session-status` + `/wave-status` into one call. Returns a structured `{ available: [...], busy: [...] }` response that lets the orchestrator make delegation decisions without three round trips.

**Why it is needed:** The orchestrator's `delegation_decision` step needs to know which peers are truly idle (not just registered). Today this requires calling `/list-peers` then cross-referencing with `/wave-status` per peer. The new endpoint does this join in one SQLite query.

**Integration:** New `case "/peer-availability":` block in broker.ts's `Bun.serve` router. New handler function `handlePeerAvailability`. New prepared statement that joins `peers` LEFT JOIN `task_assignments` WHERE task status = 'running'. No schema changes required.

---

## Data Flow: Orchestrator Dispatching a Phase to a Peer

```
Orchestrator session
  │
  1. POST /peer-availability {repo, exclude_ids: [self]}
  │    → broker joins peers + running tasks
  │    ← {available: [{peer_id, session_id, idle_since}], busy: [...]}
  │
  2. POST /conflict-check {wave_id, files: phase.expected_files}
  │    ← {conflicts: []}  (empty = safe to dispatch)
  │
  3. POST /task-start {task_id, session_id: executor.session_id}
  │    ← {ok: true}  (task is now "running" in broker)
  │
  4. send_message MCP tool → broker /send-message
  │    {from_id: self, to_id: executor.peer_id,
  │     msg_type: "execute_phase",
  │     payload: {phase_number, plan_path, wave_id, task_id, flags}}
  │
  │    broker inserts into messages table
  │    server.ts on executor side polls /poll-messages (1s interval)
  │    server.ts pushes channel notification to executor Claude session
  │    executor receives immediate interrupt: "execute this phase"
  │
  5. Orchestrator polls /wave-status {wave_id} every 10s
  │
  6. Executor completes → sends phase_complete message
  │    → orchestrator receives via channel push
  │    → orchestrator calls POST /task-complete {task_id}
  │    → broker auto-completes wave if all tasks done
  │
  7. git pull (orchestrator syncs executor's commits)
  │
  8. advance to next wave
```

---

## Data Flow: Decision Proxy Interaction

```
User session (pre-primed)
  │
  → set_summary("Decision proxy — ...")
  → waits for channel messages

Orchestrator hits a discuss-phase choice point:
  │
  1. send_message → decision_proxy.peer_id
  │    msg_type: "discuss_choice"
  │    payload: {phase_number, question, options, recommended, context}
  │
  2. Orchestrator enters 60s timeout wait (polls check_messages)
  │
  3. Decision proxy receives channel push (via server.ts poll loop)
  │    → reasons with conversation context + user preferences
  │    → send_message → orchestrator.peer_id
  │       msg_type: "discuss_answer"
  │       payload: {phase_number, chosen, reasoning}
  │
  4. Orchestrator receives discuss_answer
  │    → proceeds with chosen option, logs reasoning
  │
  timeout path:
  │    → uses recommended default (--auto behavior)
  │    → logs: "Decision proxy unavailable, used recommended default"
```

---

## New vs Modified: Explicit Accounting

| Item | New / Modified / Unchanged | Notes |
|------|---------------------------|-------|
| `broker.ts` | Modified (additive only) | Add `/peer-availability` endpoint + handler |
| `server.ts` | Unchanged | All message types already work via msg_type string |
| `shared/types.ts` | Modified (additive only) | Add new `MessageType` union values; add `PeerAvailabilityResponse` interface |
| `gsd-peers-sync.js` | Unchanged | Already handles executor heartbeats correctly |
| `gsd-peer-coordinator.md` | Unchanged | Existing coordinator still useful for ad-hoc queries |
| `gsd-plugin/agents/executor-protocol.md` | New | Executor lifecycle + all message handling |
| `gsd-plugin/agents/decision-proxy.md` | New | Decision proxy persona + discuss protocol |
| `/gsd:autonomous-peers` workflow | New | Core orchestrator brain; separate from gsd-plugin |
| `broker.test.ts` | Modified | Add tests for `/peer-availability` |

**Schema changes:** None. All new message types use the existing `msg_type TEXT` column. The `payload TEXT` column (JSON blob) already carries structured data.

**Type changes in `shared/types.ts`:**
```typescript
// Existing union — add new values:
export type MessageType =
  | "chat"
  | "task_complete"
  | "task_blocked"
  | "wave_advance"
  | "status_request"
  | "status_response"
  // New:
  | "execute_phase"
  | "phase_complete"
  | "phase_blocked"
  | "phase_progress"
  | "reclaim_task"
  | "discuss_choice"
  | "discuss_answer";

// New response type for /peer-availability:
export interface PeerAvailabilityResponse {
  available: Array<{
    peer_id: PeerId;
    session_id: string;
    cwd: string;
    summary: string;
    idle_since: string;
  }>;
  busy: Array<{
    peer_id: PeerId;
    session_id: string;
    current_task: string;
    wave_id: number;
  }>;
}
```

---

## Build Order (Dependency-First)

The build order follows what must exist before what can be built or tested.

### Step 1: Type Definitions (no deps)

Extend `shared/types.ts` with new `MessageType` values and `PeerAvailabilityResponse`. This is purely additive — no runtime impact.

**Why first:** Every subsequent component references these types. Getting the contract right before implementing anything prevents rework.

### Step 2: Broker `/peer-availability` Endpoint (depends on: Step 1)

Add to `broker.ts`: handler, prepared statement (joins peers + task_assignments), route registration, test coverage in `broker.test.ts`.

**Why second:** The orchestrator's delegation logic calls this endpoint. It must exist before the orchestrator workflow can be tested end-to-end.

**What it reuses:** Existing `peers`, `task_assignments`, `sessions` tables. Existing `cleanStalePeers()` logic (peers with dead PIDs won't appear in results).

### Step 3: Executor Protocol Agent (depends on: Step 1, Step 2)

Write `gsd-plugin/agents/executor-protocol.md`.

**Why third:** Defines the contract executors present to orchestrators. Must be settled before writing the orchestrator's dispatch and monitoring logic, since the orchestrator's behavior depends on what messages executors send and when.

**What it reuses:** Channel push delivery (server.ts, unchanged). `/task-complete`, `/task-blocked`, `/session-heartbeat` (all existing broker endpoints).

### Step 4: Decision Proxy Agent (depends on: Step 1)

Write `gsd-plugin/agents/decision-proxy.md`.

**Why fourth (parallel with Step 3):** Decision proxy is independent of executor protocol. Both can be written simultaneously. The proxy only depends on the message types defined in Step 1.

### Step 5: Orchestrator Workflow `/gsd:autonomous-peers` (depends on: Steps 1–4)

Write the new GSD workflow file. This is the most complex piece and depends on every other component being defined.

**Implementation order within this step:**
1. `discover_peers` + `dependency_analysis` steps (no broker writes, low risk — can test with just `list_peers`)
2. `dependency_analysis` + wave graph construction (pure computation, no I/O)
3. `parallel_phase_loop` with single-peer dispatch (simpler: one executor, one wave, happy path)
4. Multi-peer dispatch + wave completion detection
5. `discuss_via_proxy` integration (decision proxy path)
6. `executor_death_handling` + reclaim logic (edge case, last)

**Why last:** The orchestrator is the integration point for everything else. Testing it requires executor protocol and broker endpoint to be in place.

### Step 6: Integration Tests (depends on: Steps 1–5)

End-to-end tests in `broker.test.ts` for `/peer-availability`. Manual integration test: two Claude sessions, one orchestrator, one executor, one phase.

---

## Reuse Map: Existing Endpoints by New Component

| Existing Endpoint | Used By |
|-------------------|---------|
| `/list-peers` | orchestrator `discover_peers` step |
| `/send-message` | orchestrator dispatching `execute_phase`, `status_request`, `reclaim_task`, `discuss_choice`; executor sending `phase_complete`, `phase_blocked`, `phase_progress`, `status_response`; proxy sending `discuss_answer` |
| `/poll-messages` | server.ts poll loop (unchanged) — delivers all above messages via channel push |
| `/ack-message` | server.ts (unchanged) |
| `/wave-create` | orchestrator, once per wave, before dispatching |
| `/wave-status` | orchestrator polling every 10s |
| `/task-start` | orchestrator before sending `execute_phase` message |
| `/task-complete` | orchestrator on receipt of `phase_complete` message |
| `/task-blocked` | executor directly, before sending `phase_blocked` message |
| `/conflict-check` | orchestrator pre-dispatch; executor during SETUP step |
| `/session-heartbeat` | gsd-peers-sync.js PostToolUse hook (unchanged) |
| `/set-summary` | executor sets idle/active status; decision proxy sets "Decision proxy — ..." |

**New endpoint needed:** `/peer-availability` only.

---

## Key Architectural Constraints

### Orchestrator Owns GSD Global State

ROADMAP.md, STATE.md, and phase transitions belong exclusively to the orchestrator session. Executors run with `--no-transition` and do not touch these files. This is enforced by the flag, not the broker — there is no server-side guard.

**Implication for build order:** The `--no-transition` flag must be documented in the executor protocol (Step 3) and verified during integration testing (Step 6).

### Message Delivery is Eventually Consistent

The broker's ACK-based delivery guarantees no message is dropped, but delivery latency is bounded by the 1s poll interval in server.ts. The orchestrator's 15s ACK timeout for `execute_phase` and 30s for `status_request` are well above this bound.

**Implication:** Do not design timeouts shorter than 5s. The 60s proxy timeout and 30s status-request timeout in the design document are correct.

### Channel Push Requires `--dangerously-load-development-channels`

The instant channel notification path (used for all inter-peer messages) only works when Claude is started with this flag. Without it, the polling fallback via `check_messages` is the only option.

**Implication:** The setup instructions for the autonomous-peers workflow must make this requirement explicit. The orchestrator and all executor sessions need the flag. If an executor session lacks it, message delivery degrades to manual `check_messages` polling.

### Decision Proxy State is Ephemeral

The proxy's knowledge of user preferences lives only in its conversation context. There is no broker table for "preferences" — and per PROJECT.md, this is an explicit out-of-scope item. If the proxy session dies, the orchestrator falls back to recommended defaults.

**Implication:** No broker schema work needed for the proxy. Its agent file just needs to be clear about using `send_message` to respond and `set_summary` to identify itself.

### Single Branch Per Wave

All executors in a wave push to the same wave branch. The branch strategy (not a GSD concept) is managed entirely by the orchestrator workflow and the executor protocol. The broker does not know about branches.

**Implication:** The orchestrator workflow must create the wave branch before dispatching. The executor protocol must checkout or create the branch before `git pull --rebase`.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Forking `/gsd:autonomous`

**What:** Copying the existing autonomous workflow and adding peer logic inline.
**Why bad:** Makes GSD updates impossible to merge. Creates two diverging codebases for the same sequential execution path.
**Instead:** Write `/gsd:autonomous-peers` as a wrapper that calls into GSD's existing `discuss-phase`, `plan-phase`, and `execute-phase` steps. The peer logic wraps around these steps, it does not replace them.

### Anti-Pattern 2: Storing Decision Proxy Preferences in Broker

**What:** Adding a `preferences` table or column to persist proxy knowledge across sessions.
**Why bad:** Out of scope (PROJECT.md is explicit). Adds schema complexity. The proxy is designed to be primed per-session.
**Instead:** Preferences live in conversation context. The proxy's agent file describes how to receive preferences from the user before an autonomous run starts.

### Anti-Pattern 3: Executor Modifying Wave State Directly

**What:** Executor calling `/wave-status` writes or `/task-start` on its own task.
**Why bad:** Creates race conditions. The orchestrator must remain the single source of truth for wave transitions.
**Instead:** Executor calls only `/task-complete` and `/task-blocked` (reporting its own status). All assignment logic stays in the orchestrator.

### Anti-Pattern 4: Blocking Channel Push on Message Processing

**What:** Executor receives `execute_phase` channel push, processes the entire phase before ACKing.
**Why bad:** server.ts already ACKs messages in the poll loop. The executor Claude session responding to a channel push is the execution path — there is no separate ACK needed from the executor to the broker for message delivery. The executor's first responsibility is to send `status_response {status: "acknowledged"}` back to the orchestrator (peer-to-peer), not to the broker.
**Instead:** On receiving channel push, executor immediately sends `status_response` to orchestrator via `send_message`, then begins SETUP asynchronously.

### Anti-Pattern 5: Polling `/wave-status` Inside the Executor

**What:** Executor checking its own task status in the broker.
**Why bad:** The executor doesn't need wave-level visibility. It knows what task it was given. Polling adds unnecessary load.
**Instead:** Executor tracks its own progress internally and reports via messages. Wave-level aggregation is the orchestrator's job.

---

## Sources

- `/home/joshuaduffill/dev/claude-peers-mcp/broker.ts` — full source, all endpoints, schema, transactions (HIGH confidence, primary source)
- `/home/joshuaduffill/dev/claude-peers-mcp/server.ts` — MCP server, channel push loop, tool handlers (HIGH confidence, primary source)
- `/home/joshuaduffill/dev/claude-peers-mcp/shared/types.ts` — all type definitions, MessageType union (HIGH confidence, primary source)
- `/home/joshuaduffill/dev/claude-peers-mcp/gsd-plugin/hooks/gsd-peers-sync.js` — PostToolUse hook implementation (HIGH confidence, primary source)
- `/home/joshuaduffill/dev/claude-peers-mcp/gsd-plugin/agents/gsd-peer-coordinator.md` — existing coordinator agent (HIGH confidence, primary source)
- `/home/joshuaduffill/dev/claude-peers-mcp/design-peer-autonomous.md` — co-authored design document, full spec (HIGH confidence, authoritative design)
- `/home/joshuaduffill/dev/claude-peers-mcp/.planning/PROJECT.md` — validated requirements and out-of-scope decisions (HIGH confidence)
