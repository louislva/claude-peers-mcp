---
phase: 04-orchestrator-workflow
plan: "02"
subsystem: orchestration
tags: [wave-dispatch, monitoring, recovery, git-sync, peer-messaging, bun-test]

# Dependency graph
requires:
  - phase: 04-orchestrator-workflow
    plan: "01"
    provides: "discoverPeers, parseRoadmapPhases, buildExecutionWaves, checkWaveConflicts, PhaseNode interface"
  - phase: 03-decision-proxy
    provides: "sendDiscussChoice, waitForAnswer in proxy-helpers.ts (re-exported for orchestrator use)"
  - phase: 01-foundation
    provides: "PeerId, AvailablePeer, Wave, TaskAssignment, ExecutePhasePayload, PhaseCompletePayload types"
provides:
  - "dispatchWave: creates broker wave, sends execute_phase messages, returns assignments + localPhases"
  - "waitForWaveComplete: 10s poll loop, drains messages before stale checks, 120s/30s reclaim thresholds"
  - "pollOrchestratorMessages: categorizes phase_progress/complete/blocked/status_response messages"
  - "ackMessages: bulk ACK with empty-guard"
  - "sendStatusRequest: sends status_request to stale executor"
  - "reclaimExecutorTask: sends reclaim_task AND calls /task-blocked"
  - "handleExecutorDeath: checks git log for partial work, returns hasPartialWork + lastCommit"
  - "postWaveSync: git pull --rebase, re-reads ROADMAP.md, refreshes peer list"
  - "shouldDelegate: false for small phases, no executors, file conflicts, human checkpoints"
  - "sendDiscussChoice, waitForAnswer: re-exported from proxy-helpers for orchestrator convenience"
affects: [05-runtime-module-and-tests, orchestrator-agent-doc]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Drain message queue BEFORE checking timestamps (pitfall 3) — prevents false stale detection"
    - "Executors own /task-start transition — orchestrator never calls it (pitfall 2 anti-pattern avoided)"
    - "Idempotent dispatch: check /wave-status after /wave-create and skip non-pending tasks on retry"
    - "dummyProc pattern for broker tests: spawn sleep process to get a real signalable PID"
    - "Separate PIDs per registered test peer to avoid broker's re-registration PID collision"

key-files:
  created: []
  modified:
    - gsd-plugin/orchestrator/orchestrator-helpers.ts
    - gsd-plugin/orchestrator/orchestrator-helpers.test.ts

key-decisions:
  - "dispatchWave checks /wave-status after /wave-create and skips non-pending tasks — idempotent on retry without double-dispatch"
  - "Executors own /task-start — dispatchWave sends execute_phase message only; executor calls /task-start when it begins work"
  - "waitForWaveComplete drains message queue before checking stale timestamps — prevents false reclaims when progress messages are pending"
  - "Test registerPeer helper uses dummyPid (spawned sleep process) for second peer so both coexist — broker removes existing registration for same PID"
  - "shouldDelegate uses filesModified.length < 3 as proxy for 'fewer than 3 tasks' heuristic — avoids plan-file reads at dispatch time"

patterns-established:
  - "Stale executor reclaim: 120s no-progress -> sendStatusRequest -> 30s no-response -> reclaimExecutorTask + /task-blocked"
  - "pollOrchestratorMessages pattern mirrors proxy pollForChoices — categorize without ACK, caller ACKs after processing"
  - "postWaveSync always runs in sequence: git pull -> re-read ROADMAP -> discoverPeers refresh"

requirements-completed: [ORCH-05, ORCH-06, ORCH-07, ORCH-08, ORCH-09, ORCH-10, ORCH-11, ORCH-12]

# Metrics
duration: 9min
completed: 2026-03-25
---

# Phase 04 Plan 02: Orchestrator Runtime Helpers Summary

**Wave dispatch with idempotent /wave-create + execute_phase messaging, 10s/120s/30s stale-executor reclaim loop, git pull sync, and proxy re-exports completing the orchestrator-helpers module**

## Performance

- **Duration:** ~9 min
- **Started:** 2026-03-25T18:40:48Z
- **Completed:** 2026-03-25T18:49:23Z
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments
- Extended `orchestrator-helpers.ts` with 9 additional exports covering ORCH-05 through ORCH-12
- `dispatchWave` creates broker wave atomically, checks wave-status for idempotency, sends execute_phase to available executors (never calls /task-start — executor owns that)
- `waitForWaveComplete` implements the full monitoring loop: 10s poll, drain messages BEFORE checking timestamps (avoids pitfall 3), 120s stale threshold with status_request → 30s reclaim window
- `postWaveSync` performs git pull --rebase, re-reads ROADMAP.md, and refreshes peer list for next wave
- `sendDiscussChoice` and `waitForAnswer` re-exported from proxy-helpers for orchestrator convenience (ORCH-06)
- Filled all 27 test.todo stubs with real tests; 26 total tests all pass

## Task Commits

Each task was committed atomically:

1. **Task 1: Add dispatch, messaging, and delegation functions** - `e72c887` (feat)
2. **Task 2: Add monitoring, recovery, and sync functions** - `a51a5c4` (feat)
3. **Task 3: Fill test.todo stubs with real tests** - `a116d1e` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `gsd-plugin/orchestrator/orchestrator-helpers.ts` — Extended with 9 exports + 1 re-export; 15 total exports; complete module for ORCH-01 through ORCH-13
- `gsd-plugin/orchestrator/orchestrator-helpers.test.ts` — All 27 test.todo stubs replaced with real tests; 26 pass, 0 fail

## Decisions Made
- `dispatchWave` calls `/wave-status` after `/wave-create` to check existing task states — idempotent on retry without risk of double-dispatching
- Executors own `/task-start` transition — the orchestrator only sends the `execute_phase` message; this matches the research anti-pattern warning
- `waitForWaveComplete` drains the message queue FIRST before checking stale timestamps in each iteration — prevents false reclaims for in-flight progress messages
- `shouldDelegate` checks `filesModified.length < 3` as heuristic for "fewer than 3 tasks" — avoids reading plan files at dispatch time
- Test `registerPeer` uses a spawned `sleep` dummy process for the second peer's PID — broker's re-registration logic removes existing entries for the same PID, causing test isolation failures when both peers share `process.pid`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test registerPeer PID collision caused proxy peer to be overwritten by executor peer**
- **Found during:** Task 3 (fill test stubs — discoverPeers classification test)
- **Issue:** The broker's `registerTxn` removes any existing peer with the same PID before inserting a new one. When both test peers were registered with `process.pid`, the second registration deleted the first (proxy) peer, making it impossible to test proxy classification
- **Fix:** Added `pid` parameter to `registerPeer` helper; spawned a `sleep 300` dummy process in `beforeAll` to get a second real signalable PID (`dummyPid`); proxy peer registered with `dummyPid`, executor with `process.pid`
- **Files modified:** gsd-plugin/orchestrator/orchestrator-helpers.test.ts
- **Verification:** `bun test` — `discoverPeers > classifies peer as proxy` passes
- **Committed in:** a116d1e (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - test isolation bug from PID collision)
**Impact on plan:** Essential correctness fix for test reliability. PID collision would have produced false negatives in all multi-peer discovery tests.

## Issues Encountered
- PID 1 (systemd) is alive per `ps` but returns `EPERM` for `process.kill(1, 0)` in WSL — broker treats EPERM as "dead" and skips the peer. Required spawning a real child process for a signalable PID.

## Next Phase Readiness
- `orchestrator-helpers.ts` is fully complete with all 15 exports covering ORCH-01 through ORCH-13
- Phase 05 (runtime module) can import directly from this module
- Test patterns (dummyProc for multi-peer tests, dynamic import after env var) are established
- No blockers

---
*Phase: 04-orchestrator-workflow*
*Completed: 2026-03-25*
