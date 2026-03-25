---
phase: 01-foundation
plan: "02"
subsystem: broker
tags: [typescript, sqlite, peer-availability, conflict-check, integration-tests]

# Dependency graph
requires:
  - 01-01 (PeerAvailabilityRequest, PeerAvailabilityResponse, AvailablePeer, BusyPeer types)
provides:
  - "POST /peer-availability endpoint: single-call peer discovery with repo/machine grouping"
  - "expandFilesForConflictCheck() helper expanding lock files and barrel exports"
  - "Expanded handleConflictCheck applying expansion to both sides of comparison"
  - "7 new integration tests covering /peer-availability and expanded conflict-check"
affects:
  - orchestrator (uses /peer-availability for task assignment decisions)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "selectPeersWithTaskState prepared statement: LEFT JOIN peers + sessions + task_assignments in one query"
    - "expandFilesForConflictCheck: expand-both-sides conflict detection to catch implicit file conflicts"
    - "Root-level files use empty string dir prefix (not ./) for consistent path comparison across expansion"

key-files:
  created: []
  modified:
    - broker.ts
    - broker.test.ts

key-decisions:
  - "expandFilesForConflictCheck uses empty string (not './') for root-level file dir prefix to ensure path consistency"
  - "Both sides of conflict comparison are expanded (input files AND running task files) enabling implicit-conflict detection"
  - "Existing conflict-check test updated from toEqual() to toContain() to accommodate correct expanded file set behavior"

patterns-established:
  - "Expand-both-sides pattern: apply same expansion to both input and stored files before comparing, preventing asymmetric conflict misses"

requirements-completed: [BRKR-01, BRKR-03]

# Metrics
duration: 4min
completed: 2026-03-25
---

# Phase 01 Plan 02: /peer-availability Endpoint and Expanded Conflict-Check Summary

**POST /peer-availability with LEFT JOIN peer-classification and expand-both-sides conflict-check covering lock files and barrel exports**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-25T16:31:02Z
- **Completed:** 2026-03-25T16:35:00Z
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments
- Added POST /peer-availability endpoint returning available/busy peers grouped by repo_peers and machine_peers in a single SQL round trip
- selectPeersWithTaskState prepared statement uses LEFT JOIN across peers, sessions, task_assignments to classify peers in one query
- handlePeerAvailability skips dead PIDs (liveness check), excludes requesting peer via exclude_id, no idle threshold per CONTEXT.md
- Added LOCK_FILE_NAMES and AUTO_GENERATED_PATTERNS constants for expandFilesForConflictCheck()
- expandFilesForConflictCheck() expands package.json → all lock files, source .ts/.js/.tsx/.jsx → barrel index files in same directory
- handleConflictCheck now expands both incoming files AND each running task's files before comparing for overlaps
- Added 7 integration tests: 5 for /peer-availability (empty, available, busy, exclude_id, machine scope) and 2 for expanded conflict-check (lock files, index.ts)

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement /peer-availability endpoint** - `7b84e74` (feat)
2. **Task 2: Expand conflict-check to cover lock files and auto-generated indexes** - `80f2db2` (feat)
3. **Task 3: Add integration tests** - `d1b577a` (feat)

**Plan metadata:** _(docs commit follows)_

## Files Created/Modified
- `broker.ts` — Added 120 lines: 4 new type imports, selectPeersWithTaskState prepared stmt, LOCK_FILE_NAMES, AUTO_GENERATED_PATTERNS, expandFilesForConflictCheck(), handlePeerAvailability(), /peer-availability route case; updated handleConflictCheck
- `broker.test.ts` — Added 7 new integration tests, updated 1 existing test assertion from toEqual to toContain

## Decisions Made
- Used empty string (not `"./"`) for root-level file directory prefix in expandFilesForConflictCheck so that `"package.json"` expands to `"bun.lockb"` (not `"./bun.lockb"`), ensuring path comparison consistency
- Both sides of conflict comparison are expanded (not just input), enabling detection of two tasks in the same directory both touching the barrel index
- Updated existing `conflict-check finds overlapping files` test assertion from `toEqual(["src/shared.ts"])` to `toContain("src/shared.ts")` since expansion is correct new behavior — this is not a regression

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed dir prefix inconsistency in expandFilesForConflictCheck**
- **Found during:** Task 3 (test failures)
- **Issue:** Plan code used `|| "./"` fallback for root-level files, causing `"package.json"` to expand to `"./bun.lockb"` but incoming `"bun.lockb"` stayed as `"bun.lockb"` — mismatch, conflict not detected
- **Fix:** Changed dir logic to use `""` for root-level files (no slash in path), ensuring consistent comparison
- **Files modified:** broker.ts
- **Commit:** d1b577a

**2. [Rule 1 - Bug] Fixed fake PIDs in peer-availability tests failing liveness check**
- **Found during:** Task 3 (test failures)
- **Issue:** Plan test code used fake PIDs (66601-66603) for peers that need to appear in /peer-availability results, but broker's PID liveness check (`process.kill(pid, 0)`) skips dead PIDs
- **Fix:** Changed tests to use `process.pid` (the test process itself is always alive) for peers that must appear in availability results
- **Files modified:** broker.test.ts
- **Commit:** d1b577a

**3. [Rule 1 - Bug] Updated existing conflict-check test for expanded behavior**
- **Found during:** Task 3 (test failures)
- **Issue:** Existing test used `toEqual(["src/shared.ts"])` but now conflict-check expansion adds index files to the overlap set
- **Fix:** Changed to `toContain("src/shared.ts")` — correctly validates the key overlap while allowing additional expanded conflicts
- **Files modified:** broker.test.ts
- **Commit:** d1b577a

## Issues Encountered

None beyond the 3 auto-fixed bugs above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- BRKR-01 and BRKR-03 satisfied — orchestrator can use /peer-availability for single-call peer discovery
- 30 tests pass (23 existing + 7 new)
- broker.ts ready for Phase 2 (executor, proxy, orchestrator MCP tools)

---
*Phase: 01-foundation*
*Completed: 2026-03-25*

## Self-Check: PASSED

- FOUND: broker.ts
- FOUND: broker.test.ts
- FOUND: .planning/phases/01-foundation/01-02-SUMMARY.md
- FOUND commit: 7b84e74 (feat: /peer-availability endpoint)
- FOUND commit: 80f2db2 (feat: expanded conflict-check)
- FOUND commit: d1b577a (feat: 7 new integration tests)
- FOUND commit: f4dc34a (docs: plan metadata)
