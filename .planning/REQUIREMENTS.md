# Requirements: gsd-comms-mcp

**Defined:** 2026-03-25
**Core Value:** Multiple Claude Code instances can collaborate autonomously on GSD milestones without human intervention

## v1.0 Requirements

Requirements for peer-aware autonomous workflow. Each maps to roadmap phases.

### Type System & Contracts

- [x] **TYPE-01**: Shared types define 9 new message type literals (execute_phase, phase_complete, phase_blocked, phase_progress, status_request, status_response, reclaim_task, discuss_choice, discuss_answer)
- [x] **TYPE-02**: Each message type has a typed payload interface with required fields
- [x] **TYPE-03**: Peer availability types define available/busy peer state with idle_since and current_task fields

### Broker Infrastructure

- [x] **BRKR-01**: `/peer-availability` endpoint returns available and busy peers in a single query (replaces 3 round trips)
- [x] **BRKR-02**: Task assignments support a `failed` terminal state that unblocks wave completion
- [x] **BRKR-03**: Conflict-check covers lock files and auto-generated indexes, not just declared source files
- [ ] **BRKR-04**: `/peer-availability` endpoint has integration test coverage

### Executor Protocol

- [x] **EXEC-01**: Executor peer acknowledges `execute_phase` within 15 seconds or task is reclaimed
- [x] **EXEC-02**: Executor runs git pull, reads plan file, validates via conflict-check before starting execution
- [x] **EXEC-03**: Executor sends `phase_progress` after each task completion with tasks_completed, tasks_total, last_commit
- [x] **EXEC-04**: Executor sends `phase_complete` with verification result, commit list, and files_modified on completion
- [x] **EXEC-05**: Executor sends `phase_blocked` with categorized reason (git_conflict, file_conflict, plan_not_found, test_failure, dependency_missing, permission_denied, unknown)
- [x] **EXEC-06**: Executor responds to `status_request` immediately, interrupting current work
- [x] **EXEC-07**: Executor handles `reclaim_task` by committing WIP, pushing, and returning to idle
- [x] **EXEC-08**: Executor uses push jitter (random 0-3s delay) to avoid git push collisions between parallel peers
- [x] **EXEC-09**: Executor runs with `--no-transition` flag so it never modifies ROADMAP.md or STATE.md

### Decision Proxy

- [ ] **PRXY-01**: Decision proxy peer receives `discuss_choice` messages with phase context, question, options, and recommended default
- [ ] **PRXY-02**: Decision proxy responds with `discuss_answer` containing chosen option and reasoning within 60 seconds
- [ ] **PRXY-03**: Decision proxy includes prior decisions from the same autonomous run in each query for consistency
- [ ] **PRXY-04**: All proxy decisions are logged to `.planning/DECISIONS.md` as an audit trail
- [ ] **PRXY-05**: Orchestrator falls back to recommended default if proxy is unavailable or times out

### Orchestrator Workflow

- [ ] **ORCH-01**: Orchestrator discovers available peers via `/peer-availability` on startup
- [ ] **ORCH-02**: Orchestrator classifies peers into decision_proxy (at most one) and executors by summary content
- [ ] **ORCH-03**: Orchestrator builds dependency graph from ROADMAP.md phases with cycle detection (Kahn's algorithm)
- [ ] **ORCH-04**: Orchestrator groups independent phases into execution waves based on dependency graph
- [ ] **ORCH-05**: Orchestrator plans all phases in a wave sequentially (orchestrator-only), then dispatches execution in parallel to peers
- [ ] **ORCH-06**: Orchestrator delegates discuss-phase choices to decision proxy instead of prompting user
- [ ] **ORCH-07**: Orchestrator monitors wave progress via `/wave-status` polling every 10 seconds
- [ ] **ORCH-08**: Orchestrator reclaims tasks from unresponsive executors (no progress for 120s, no status_response within 30s)
- [ ] **ORCH-09**: Orchestrator handles executor death by checking git for partial work and reassigning
- [ ] **ORCH-10**: Orchestrator performs post-wave sync (git pull, re-read ROADMAP.md, update STATE.md, refresh peer list)
- [ ] **ORCH-11**: Orchestrator applies delegation decision logic (delegate vs execute locally based on phase size, dependencies, checkpoint types, file conflicts)
- [ ] **ORCH-12**: Orchestrator falls back to standard sequential autonomous if no peers are available
- [ ] **ORCH-13**: Orchestrator serializes conflicting phases into synthetic sub-waves when conflict-check detects file overlap

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Enhanced Resilience

- **RSLN-01**: Git worktree isolation per executor (eliminates push collisions entirely)
- **RSLN-02**: Progress-monotonicity stuck detection (track tasks_completed + last_commit over time, not just ping)
- **RSLN-03**: Automatic partial-completion assessment (>80% done → complete locally)

### Advanced Proxy

- **APRX-01**: Decision proxy persists preferences across sessions via memory files
- **APRX-02**: Decision proxy can request clarification from user before answering
- **APRX-03**: User can review and override proxy decisions mid-run

### Observability

- **OBSV-01**: Real-time dashboard showing peer status, wave progress, and message flow
- **OBSV-02**: Session report includes peer collaboration metrics (delegation count, reclaims, proxy decisions)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Core GSD modifications | Constraint: GSD stays untouched, this is wrapper/plugin only |
| Cross-machine peer discovery | Localhost only — networking adds security and complexity |
| ML-based failure prediction | Overkill for single-machine dev tool; timeout+reclaim+retry covers 95% |
| Per-executor git branches | Added merge complexity without solving the core problem; use conflict-check instead (v2 may add worktrees) |
| Web UI dashboard | CLI and peer messaging sufficient for v1 |
| Persistent proxy memory | Proxy is primed per-session; persistence is a v2 concern |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| TYPE-01 | Phase 1 | Complete |
| TYPE-02 | Phase 1 | Complete |
| TYPE-03 | Phase 1 | Complete |
| BRKR-01 | Phase 1 | Complete |
| BRKR-02 | Phase 1 | Complete |
| BRKR-03 | Phase 1 | Complete |
| BRKR-04 | Phase 5 | Pending |
| EXEC-01 | Phase 2 | Complete |
| EXEC-02 | Phase 2 | Complete |
| EXEC-03 | Phase 2 | Complete |
| EXEC-04 | Phase 2 | Complete |
| EXEC-05 | Phase 2 | Complete |
| EXEC-06 | Phase 2 | Complete |
| EXEC-07 | Phase 2 | Complete |
| EXEC-08 | Phase 2 | Complete |
| EXEC-09 | Phase 2 | Complete |
| PRXY-01 | Phase 3 | Pending |
| PRXY-02 | Phase 3 | Pending |
| PRXY-03 | Phase 3 | Pending |
| PRXY-04 | Phase 3 | Pending |
| PRXY-05 | Phase 3 | Pending |
| ORCH-01 | Phase 4 | Pending |
| ORCH-02 | Phase 4 | Pending |
| ORCH-03 | Phase 4 | Pending |
| ORCH-04 | Phase 4 | Pending |
| ORCH-05 | Phase 4 | Pending |
| ORCH-06 | Phase 4 | Pending |
| ORCH-07 | Phase 4 | Pending |
| ORCH-08 | Phase 4 | Pending |
| ORCH-09 | Phase 4 | Pending |
| ORCH-10 | Phase 4 | Pending |
| ORCH-11 | Phase 4 | Pending |
| ORCH-12 | Phase 4 | Pending |
| ORCH-13 | Phase 4 | Pending |

**Coverage:**
- v1.0 requirements: 34 total
- Mapped to phases: 34
- Unmapped: 0

---
*Requirements defined: 2026-03-25*
*Last updated: 2026-03-25 after roadmap creation — all 34 requirements mapped*
