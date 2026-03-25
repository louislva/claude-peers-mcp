# Roadmap: gsd-comms-mcp

## Overview

This milestone adds peer-aware autonomous execution to the existing gsd-comms-mcp infrastructure. Starting from settled shared types and a new broker availability endpoint, it builds outward through the executor protocol, the decision proxy agent, and the orchestrator workflow — each component a prerequisite for the next. The result is a system where Claude Code instances collaborate on GSD milestones in parallel, with a dedicated proxy handling discuss-phase choices and the orchestrator managing wave execution, failure recovery, and fallback to sequential mode when peers are absent.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation** - Shared type contracts and broker availability endpoint (completed 2026-03-25)
- [x] **Phase 2: Executor Protocol** - Executor agent lifecycle, git setup, ACK/progress/completion/blocked/reclaim protocol (completed 2026-03-25)
- [x] **Phase 3: Decision Proxy** - Proxy agent persona, discuss_choice/discuss_answer protocol, DECISIONS.md logging (completed 2026-03-25)
- [ ] **Phase 4: Orchestrator Workflow** - Full autonomous peers workflow: discovery, dependency analysis, wave dispatch, monitoring, death handling, fallback
- [ ] **Phase 5: Runtime Module and Tests** - Extracted runtime module (Kahn's algorithm, wave polling), integration test coverage

## Phase Details

### Phase 1: Foundation
**Goal**: All downstream components share settled type contracts and the broker's single-call availability endpoint is live and tested
**Depends on**: Nothing (first phase)
**Requirements**: TYPE-01, TYPE-02, TYPE-03, BRKR-01, BRKR-02, BRKR-03
**Success Criteria** (what must be TRUE):
  1. `shared/types.ts` exports 9 new message type literals and their typed payload interfaces with no TypeScript errors
  2. `shared/types.ts` exports a `PeerAvailabilityResponse` type with `available` and `busy` peer arrays, each peer carrying `idle_since` or `current_task` fields as appropriate
  3. `POST /peer-availability` returns available and busy peers in a single broker round trip, replacing three separate calls
  4. `POST /task-complete` and wave-status logic recognize a `failed` terminal state that unblocks wave completion
  5. `/conflict-check` payload accepts and evaluates lock files and auto-generated index files, not only declared source files
**Plans:** 2/2 plans complete
Plans:
- [ ] 01-01-PLAN.md — Type contracts: 9 autonomous message types, payload interfaces, peer availability types, BRKR-02 verification
- [ ] 01-02-PLAN.md — Broker endpoints: /peer-availability endpoint, expanded conflict-check, integration tests

### Phase 2: Executor Protocol
**Goal**: The executor agent contract is fully specified — a peer running as executor knows exactly what to do from receiving `execute_phase` through sending `phase_complete` or `phase_blocked`, including git setup, security validation, and reclaim handling
**Depends on**: Phase 1
**Requirements**: EXEC-01, EXEC-02, EXEC-03, EXEC-04, EXEC-05, EXEC-06, EXEC-07, EXEC-08, EXEC-09
**Success Criteria** (what must be TRUE):
  1. An executor peer receiving `execute_phase` sends an acknowledgment within 15 seconds or the task is eligible for reclaim
  2. Executor runs `git pull`, reads the plan file, and calls `/conflict-check` before beginning any execution work
  3. Executor sends `phase_progress` messages (with `tasks_completed`, `tasks_total`, `last_commit`) after each task completes during execution
  4. Executor sends a structured `phase_complete` or `phase_blocked` message on exit — `phase_blocked` includes one of the seven defined reason categories
  5. Executor never writes to `ROADMAP.md` or `STATE.md` (enforced by `--no-transition` flag)
**Plans:** 3/3 plans complete
Plans:
- [ ] 02-01-PLAN.md — Executor helpers TypeScript module: all protocol functions (ACK, setup, progress, complete, blocked, reclaim, push jitter, no-transition guard)
- [ ] 02-02-PLAN.md — Executor agent markdown document: full lifecycle instructions for Claude instances
- [ ] 02-03-PLAN.md — Integration tests for all executor helper functions

### Phase 3: Decision Proxy
**Goal**: The decision proxy peer role is fully specified — a user-primed session can register as proxy, receive discuss-phase choices from the orchestrator, and respond consistently with logged decisions
**Depends on**: Phase 1
**Requirements**: PRXY-01, PRXY-02, PRXY-03, PRXY-04, PRXY-05
**Success Criteria** (what must be TRUE):
  1. A proxy peer receives a `discuss_choice` message containing phase context, the question, options, and a recommended default
  2. Proxy responds with `discuss_answer` (chosen option + reasoning) within 60 seconds
  3. Each `discuss_choice` payload includes prior decisions from the current autonomous run so the proxy can answer consistently
  4. Every proxy answer is appended to `.planning/DECISIONS.md` as a permanent audit trail
  5. If no proxy peer is reachable or the 60-second timeout elapses, the orchestrator uses the recommended default and continues
**Plans:** 2/2 plans complete
Plans:
- [ ] 03-01-PLAN.md — Proxy helpers TypeScript module: all protocol functions (poll, parse, answer, append decision, orchestrator-side choice/wait/timeout)
- [ ] 03-02-PLAN.md — Proxy agent markdown document + integration tests for all proxy helper functions

### Phase 4: Orchestrator Workflow
**Goal**: The `/gsd:autonomous-peers` workflow orchestrates a full autonomous milestone run — discovering peers, grouping phases into dependency waves, dispatching to executors in parallel, routing discuss-phase choices through the proxy, recovering from executor death, and falling back to sequential execution when no peers are present
**Depends on**: Phase 2, Phase 3
**Requirements**: ORCH-01, ORCH-02, ORCH-03, ORCH-04, ORCH-05, ORCH-06, ORCH-07, ORCH-08, ORCH-09, ORCH-10, ORCH-11, ORCH-12, ORCH-13
**Success Criteria** (what must be TRUE):
  1. On startup, orchestrator calls `/peer-availability` and classifies peers into at most one decision proxy and N executors based on peer summary content
  2. Orchestrator reads `ROADMAP.md`, builds a dependency graph with cycle detection (Kahn's algorithm), and groups independent phases into execution waves before dispatching any work
  3. Orchestrator dispatches phases in a wave to available executors in parallel after planning them sequentially, then polls `/wave-status` every 10 seconds to monitor progress
  4. Orchestrator reclaims tasks from unresponsive executors (no `phase_progress` for 120s, no `status_response` within 30s after a `status_request`) and reassigns them
  5. When no peers are discovered, the orchestrator falls back to standard sequential autonomous execution without error
**Plans**: TBD

### Phase 5: Runtime Module and Tests
**Goal**: The topological sort and wave polling logic are extracted into a standalone testable module, and integration test coverage validates the `/peer-availability` endpoint and the full two-session executor handshake
**Depends on**: Phase 4
**Requirements**: BRKR-04
**Success Criteria** (what must be TRUE):
  1. `gsd-plugin/autonomous-peers-runtime.ts` exports Kahn's topological sort and the wave polling loop as independently unit-testable functions
  2. `broker.test.ts` includes passing integration tests for `/peer-availability` covering available-only, busy-only, and mixed peer states
  3. A documented two-session smoke test runbook exists that a developer can follow to verify end-to-end executor handshake (execute_phase → ack → phase_complete)
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 2/2 | Complete   | 2026-03-25 |
| 2. Executor Protocol | 3/3 | Complete   | 2026-03-25 |
| 3. Decision Proxy | 2/2 | Complete   | 2026-03-25 |
| 4. Orchestrator Workflow | 0/TBD | Not started | - |
| 5. Runtime Module and Tests | 0/TBD | Not started | - |
