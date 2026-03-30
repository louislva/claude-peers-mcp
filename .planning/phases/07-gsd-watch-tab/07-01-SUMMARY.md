---
phase: 07-gsd-watch-tab
plan: 01
subsystem: ui
tags: [tui, fs.watch, parser, roadmap, typescript, bun]

# Dependency graph
requires:
  - phase: 06-tui-core
    provides: "App shell, tab interface contract (render/start/stop/handleKey), render.ts ANSI primitives"
provides:
  - "parseGsdTree(planningDir) -> GsdTree: typed tree of milestone > phase > plan nodes"
  - "watchPlanning(planningDir, onChange): debounced fs.watch watcher with cleanup fn"
  - "Types: GsdTree, TreeNode, NodeStatus, NodeKind"
  - "Unit tests: 9 tests covering all status derivation paths"
affects: [07-02-gsd-watch-renderer, any future tab needing .planning/ tree data]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "TDD with bun:test: RED (failing tests committed) -> GREEN (implementation) -> verify"
    - "parseRoadmap two-pass: Phase Details first, then milestone/phase list with <details> skip"
    - "Status priority: DONE (roadmap [x]) > VRFY (VERIFICATION.md) > EXEC (SUMMARY.md) > PLAN (PLAN.md) > DISC (CONTEXT.md) > PEND"
    - "Phase status derived from children: any EXEC -> EXEC, all DONE -> DONE, any VRFY -> VRFY, etc."
    - "watchPlanning uses 100ms debounce to avoid rapid re-parses on burst file events"

key-files:
  created:
    - tui/tabs/gsd-watch-parser.ts
    - tui/tabs/gsd-watch-parser.test.ts
  modified: []

key-decisions:
  - "Two-pass ROADMAP.md parsing: first pass collects Phase Details plan entries, second pass collects milestone/phase list — avoids having to backtrack when phases appear before their details"
  - "Skip <details> blocks in ## Phases section to avoid parsing archived v1.0 milestone data"
  - "Phase number used as fuzzy match key when exact phase name match fails in Phase Details"
  - "parseGsdTree is async (Bun.file().text()) to match Bun API; watchPlanning is sync (fs.watch)"

patterns-established:
  - "Parser-renderer separation: parser (this plan) returns typed GsdTree; renderer (Plan 02) receives it as data"
  - "All file scanning uses node:fs.readdirSync — synchronous in getPhaseFiles, avoids async complexity"

requirements-completed: [GSDW-01, GSDW-02, GSDW-04]

# Metrics
duration: 4min
completed: 2026-03-30
---

# Phase 7 Plan 01: GSD Watch Tab Parser Summary

**Async ROADMAP.md parser producing typed milestone > phase > plan tree with 6-level status derivation from file presence, verified by 9 unit tests**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-30T18:36:14Z
- **Completed:** 2026-03-30T18:40:00Z
- **Tasks:** 1 (TDD: 2 commits — RED + GREEN)
- **Files modified:** 2

## Accomplishments
- `parseGsdTree(planningDir)` reads ROADMAP.md + scans phase directories, returns typed `GsdTree` with milestone > phase > plan hierarchy
- Plan status derivation: DONE (roadmap [x]), VRFY (VERIFICATION.md), EXEC (SUMMARY.md), PLAN (PLAN.md), DISC (CONTEXT.md), PEND (no files)
- Phase status derived from child plans (any EXEC -> EXEC, all DONE -> DONE, etc.)
- `watchPlanning()` wraps `fs.watch({ recursive: true })` with 100ms debounce, returns cleanup function
- All 9 unit tests pass; verified against real `.planning/` (Phase 6 DONE, Phase 7 PLAN, progress 2/4)

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Failing tests** - `61c003e` (test)
2. **Task 1 GREEN: Parser implementation** - `7121091` (feat)

## Files Created/Modified
- `tui/tabs/gsd-watch-parser.ts` — Main parser: parseGsdTree, watchPlanning, GsdTree/TreeNode/NodeStatus types
- `tui/tabs/gsd-watch-parser.test.ts` — 9 unit tests using bun:test with temp directory fixtures

## Decisions Made
- Two-pass ROADMAP.md parsing: Phase Details collected first (pass 1), then milestone/phase list (pass 2) — avoids backtracking
- Skip `<details>` blocks to avoid parsing archived v1.0 milestone data mixed into `## Phases` section
- Phase number used as fuzzy match fallback when exact phase name doesn't match Phase Details key

## Deviations from Plan

None - plan executed exactly as written. The two-pass parsing approach was an implementation detail not prescribed in the plan, but no plan-level scope changes occurred.

## Issues Encountered
- Initial implementation failed 5/9 tests: simple test ROADMAP fixtures (without `## Phases` section) weren't being parsed because the parser required the `## Phases` section marker before looking for `### vX.Y` milestone headers. Fixed by restructuring to scan for `### vX.Y` headers anywhere in the file (outside `<details>` blocks).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `parseGsdTree` and `watchPlanning` fully implemented and tested
- Plan 02 can import from `tui/tabs/gsd-watch-parser.ts` to get the `GsdTree` data structure
- The existing `tui/tabs/gsd-watch.ts` stub is ready to be replaced by Plan 02

---
*Phase: 07-gsd-watch-tab*
*Completed: 2026-03-30*

## Self-Check: PASSED

- tui/tabs/gsd-watch-parser.ts: FOUND
- tui/tabs/gsd-watch-parser.test.ts: FOUND
- .planning/phases/07-gsd-watch-tab/07-01-SUMMARY.md: FOUND
- Commit 61c003e (test RED): FOUND
- Commit 7121091 (feat GREEN): FOUND
