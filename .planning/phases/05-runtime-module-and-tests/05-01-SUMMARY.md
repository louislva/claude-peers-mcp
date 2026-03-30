---
phase: 05-runtime-module-and-tests
plan: 01
subsystem: testing
tags: [typescript, bun, refactor, orchestrator, topo-sort, wave-scheduling]

# Dependency graph
requires:
  - phase: 04-orchestrator-workflow
    provides: orchestrator-helpers.ts with buildExecutionWaves, waitForWaveComplete, and runtime helpers
provides:
  - gsd-plugin/autonomous-peers-runtime.ts standalone module with Kahn's sort and wave polling
  - re-export shim in orchestrator-helpers.ts for backwards compatibility
affects: [05-runtime-module-and-tests plan 02 (runtime tests)]

# Tech tracking
tech-stack:
  added: []
  patterns: [per-module self-contained brokerFetch (duplicated, not imported cross-module), re-export shim for backwards compatibility]

key-files:
  created:
    - gsd-plugin/autonomous-peers-runtime.ts
  modified:
    - gsd-plugin/orchestrator/orchestrator-helpers.ts

key-decisions:
  - "autonomous-peers-runtime.ts has zero imports from sibling modules — only ../shared/types.ts to prevent circular deps"
  - "brokerFetch duplicated in runtime module per established per-module self-contained pattern (not imported)"
  - "Unused type imports (DiscussChoicePayload, DiscussAnswerPayload, Message) removed from orchestrator-helpers.ts after extraction"

patterns-established:
  - "Extraction pattern: move function bodies to new module, add re-export shim in original file for backwards compatibility"

requirements-completed: [BRKR-04]

# Metrics
duration: 4min
completed: 2026-03-25
---

# Phase 5 Plan 01: Runtime Module Extraction Summary

**Kahn's topological sort (buildExecutionWaves) and wave polling loop (waitForWaveComplete) extracted to standalone autonomous-peers-runtime.ts with zero circular imports**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-25T19:16:30Z
- **Completed:** 2026-03-25T19:20:45Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Created `gsd-plugin/autonomous-peers-runtime.ts` with all 7 required exports: `PhaseNode`, `buildExecutionWaves`, `waitForWaveComplete`, `pollOrchestratorMessages`, `ackMessages`, `sendStatusRequest`, `reclaimExecutorTask`
- Updated `orchestrator-helpers.ts` to re-export extracted symbols from runtime module, preserving 100% backwards compatibility
- All 29 existing orchestrator-helpers tests pass unchanged with no test file modifications

## Task Commits

Each task was committed atomically:

1. **Task 1: Create autonomous-peers-runtime.ts** - `dbf3888` (feat)
2. **Task 2: Update orchestrator-helpers.ts with re-exports** - `c4e1355` (refactor)

## Files Created/Modified
- `/home/joshuaduffill/dev/claude-peers-mcp/gsd-plugin/autonomous-peers-runtime.ts` - Standalone runtime: Kahn's sort + wave polling + 4 broker helpers, self-contained with local brokerFetch
- `/home/joshuaduffill/dev/claude-peers-mcp/gsd-plugin/orchestrator/orchestrator-helpers.ts` - Replaced extracted function bodies with re-export block, cleaned unused type imports

## Decisions Made
- `autonomous-peers-runtime.ts` imports only from `../shared/types.ts` — no sibling module imports prevents circular dependencies
- `brokerFetch` duplicated per established per-module self-contained pattern (not imported from orchestrator-helpers.ts)
- Cleaned unused type imports (`DiscussChoicePayload`, `DiscussAnswerPayload`, `Message`) from orchestrator-helpers.ts after extraction

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## Next Phase Readiness
- `autonomous-peers-runtime.ts` is now independently importable and testable
- Plan 02 can write unit tests for `buildExecutionWaves` and `waitForWaveComplete` by importing directly from `gsd-plugin/autonomous-peers-runtime.ts`
- No blockers

---
*Phase: 05-runtime-module-and-tests*
*Completed: 2026-03-25*
