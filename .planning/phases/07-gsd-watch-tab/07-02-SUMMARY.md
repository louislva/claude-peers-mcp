---
phase: 07-gsd-watch-tab
plan: 02
subsystem: tui/tabs/gsd-watch
tags: [tui, gsd-watch, tree-view, navigation, fs-watch]
dependency_graph:
  requires: ["07-01"]
  provides: ["GSD Watch tab renderer"]
  affects: ["tui/app.ts tab rendering"]
tech_stack:
  added: []
  patterns:
    - "Flat visible-node list derived from tree on each render — avoids stale index issues"
    - "lastRenderArgs caching enables watcher-triggered re-renders without app.ts coupling"
    - "async start() with Promise<void> — compatible with TabDef void return (assignable in TS)"
key_files:
  created: []
  modified:
    - tui/tabs/gsd-watch.ts
decisions:
  - "start() is async to call parseGsdTree (async); TabDef interface uses void return which is assignable from Promise<void> in TypeScript"
  - "collapseAll() keeps milestone (root) nodes expanded so phase children remain visible"
  - "lastRenderArgs pattern: module stores last render dimensions; watcher callback re-renders directly without coupling to app.ts"
metrics:
  duration_minutes: 3
  completed_date: "2026-03-30"
  tasks_completed: 1
  tasks_total: 2
  files_modified: 1
---

# Phase 7 Plan 2: GSD Watch Tab Renderer Summary

## One-liner

Full GSD Watch tab replacing placeholder stub: live .planning/ tree view with expand/collapse navigation, status badges, fs.watch-driven updates, and progress bar.

## What Was Built

Replaced `tui/tabs/gsd-watch.ts` placeholder with 457-line full implementation:

- **Tree flattening**: `flattenVisible()` converts GsdTree roots into a flat `VisibleNode[]` list respecting expanded/collapsed state
- **Keyboard navigation**: `j`/`k`/`up`/`down` scroll with viewport tracking; `Enter` toggles expand/collapse; `e` expands all; `w` collapses all (keeping milestone roots expanded)
- **Status badges**: DONE=green, EXEC=purple, PLAN=blue, DISC=yellow, VRFY=green, PEND=dimGray — using `badge()` from render.ts
- **Progress bar**: `[||||....] XX% (N/M plans)` using `|` for filled, `.` for empty, color-coded
- **Live updates**: `watchPlanning` callback re-parses tree and immediately re-renders using cached `lastRenderArgs`
- **start()/stop()**: Detects `.planning/` via ROADMAP.md presence; initializes tree; starts watcher; resets all state on stop

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1: Implement GSD Watch tab | c3a9b1c | feat(07-02): implement GSD Watch tab with live tree view |

## Deviations from Plan

None - plan executed exactly as written.

## Verification Instructions (Task 2: Human Verify)

The checkpoint requires running `bun tui/main.ts` and verifying the GSD Watch tab:

1. Run `bun /home/joshuaduffill/dev/claude-peers-mcp/tui/main.ts` — Tab 1 (GSD Watch) should be active by default
2. Verify tree structure: milestone nodes at top level, phases indented below, plans indented below phases
3. Verify status badges: completed phases show [DONE] in green, current phase shows appropriate status
4. Press `j`/`k` or arrow keys — cursor should move through tree nodes (highlighted row)
5. Press `Enter` on a phase node — it should collapse/expand its child plans
6. Press `w` — all nodes should collapse to milestone and phase level only
7. Press `e` — all nodes should expand back
8. Verify progress bar at bottom: shows something like `[||||||||..] XX% (N/M plans)`
9. In another terminal: `touch /home/joshuaduffill/dev/claude-peers-mcp/.planning/phases/07-gsd-watch-tab/test-file.md` — tree should update within ~1 second
10. Clean up: `rm /home/joshuaduffill/dev/claude-peers-mcp/.planning/phases/07-gsd-watch-tab/test-file.md`
11. Press `q` to exit — terminal should restore cleanly

## Known Stubs

None - the tab is fully wired to real data via `parseGsdTree(planningDir)` and `watchPlanning`.

## Self-Check: PASSED

- FOUND: tui/tabs/gsd-watch.ts (457 lines, min_lines 100 requirement met)
- FOUND: .planning/phases/07-gsd-watch-tab/07-02-SUMMARY.md
- FOUND: commit c3a9b1c (feat(07-02): implement GSD Watch tab with live tree view)
