---
phase: 05-runtime-module-and-tests
plan: "02"
subsystem: tests-and-docs
tags: [testing, integration-test, peer-availability, smoke-test, executor-protocol]
dependency_graph:
  requires: []
  provides: [BRKR-04-test-coverage, executor-handshake-runbook]
  affects: [broker.test.ts, docs/smoke-test-executor-handshake.md]
tech_stack:
  added: []
  patterns: [process.ppid-for-distinct-live-pid, two-session-smoke-test-runbook]
key_files:
  created:
    - docs/smoke-test-executor-handshake.md
  modified:
    - broker.test.ts
decisions:
  - "Mixed-state test uses process.pid for idle peer and process.ppid for busy peer — broker deduplicates by PID on /register so two distinct live PIDs are required"
  - "Runbook uses curl throughout (not bun/TypeScript) for maximum copy-paste convenience across any terminal session"
metrics:
  duration: "3 min"
  completed: "2026-03-25"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 2
---

# Phase 05 Plan 02: Mixed-State Test and Executor Handshake Runbook Summary

Mixed-state /peer-availability integration test (BRKR-04) added to broker.test.ts, plus a curl-based two-session smoke test runbook for the execute_phase -> acknowledged -> phase_complete handshake.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add mixed-state /peer-availability integration test | a29bc1c | broker.test.ts |
| 2 | Create two-session executor handshake smoke test runbook | c245736 | docs/smoke-test-executor-handshake.md |

## What Was Built

**Task 1 — Mixed-state /peer-availability test (BRKR-04):**

Added test `/peer-availability returns both available and busy peers in mixed state` to the Phase 5 peer availability section of broker.test.ts (after line 697). The test:

1. Registers an idle peer via `/register` using `process.pid`
2. Registers a busy peer via `/session-heartbeat` using `process.ppid` (distinct live PID)
3. Creates a wave + starts a task to put the busy peer into running state
4. Queries `/peer-availability` for the shared repo (`/tmp/mixed-avail-repo`)
5. Asserts `repo_peers.available.length >= 1` and `repo_peers.busy.length >= 1`
6. Verifies each peer ID appears in the correct bucket with expected fields
7. Cleans up via `/unregister` and `/session-end`

Total test suite: 31 tests, 0 failures.

**Task 2 — Executor handshake smoke test runbook:**

Created `docs/smoke-test-executor-handshake.md` with step-by-step curl commands covering:
- Broker startup and health check
- Session A (orchestrator): peer registration, `execute_phase` dispatch
- Session B (executor): peer registration, message polling, ACK, `status_response`, `phase_complete`
- Session A verification: poll for completion messages
- Cleanup with `/unregister` calls
- `bun cli.ts peers` verification checkpoint between registration and message exchange
- Message type reference table

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] PID collision in mixed-state test**

- **Found during:** Task 1 — first test run failed with `Expected: >= 1, Received: 0`
- **Issue:** Plan specified `process.pid` for both idle and busy peer registrations. Broker's `registerTxn` deduplicates by PID — registering two peers with the same PID removes the first before the second is created. The idle peer was being deleted when the busy peer registered.
- **Fix:** Used `process.pid` for the idle peer and `process.ppid` (parent process PID, always alive in test context) for the busy peer. Added code comment explaining the rationale.
- **Files modified:** broker.test.ts
- **Commit:** a29bc1c (included in task commit)

## Verification

- `bun test broker.test.ts`: 31 pass, 0 fail
- `grep -c "mixed" broker.test.ts`: 13 (test name, assertions, variable names, comments)
- `docs/smoke-test-executor-handshake.md` exists with: 8 occurrences of "execute_phase", 9 of "phase_complete", 6 of "status_response", 12 curl commands, 1 "bun cli.ts peers" checkpoint, 2 "poll-messages" references, 2 "/unregister" cleanup calls

## Self-Check: PASSED

- broker.test.ts: FOUND
- docs/smoke-test-executor-handshake.md: FOUND
- Commit a29bc1c: FOUND
- Commit c245736: FOUND
