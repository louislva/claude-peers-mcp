---
phase: 06-tui-core
plan: 02
subsystem: tui
tags: [tui, tabs, app-shell, tab-state-machine, entry-point, placeholder]
dependency_graph:
  requires: [tui/render.ts, tui/input.ts, tui/broker.ts]
  provides: [tui/app.ts, tui/main.ts, tui/tabs/*.ts]
  affects: []
tech_stack:
  added: []
  patterns: [tab state machine, setInterval refresh loop, SIGWINCH resize handler, cleanup function pattern]
key_files:
  created:
    - tui/app.ts
    - tui/main.ts
    - tui/tabs/gsd-watch.ts
    - tui/tabs/peers.ts
    - tui/tabs/waves.ts
    - tui/tabs/tasks.ts
    - tui/tabs/messages.ts
    - tui/tabs/stats.ts
  modified: []
decisions:
  - REFRESH_MS=0 for GSD Watch tab (event-driven via fs.watch in Phase 7, not polling)
  - Broker health check on separate 5s interval independent of per-tab refresh timers
  - onQuit callback pattern allows main.ts to hook cleanup without App knowing about exitAltScreen
metrics:
  duration: "~4 minutes"
  completed: "2026-03-30"
  tasks_completed: 2
  files_created: 8
  checkpoint_at: task-3
---

# Phase 06 Plan 02: App Shell and Tab Modules Summary

Complete TUI shell with 6 placeholder tab modules, App class tab state machine with refresh loops, and main.ts entry point — `bun tui/main.ts` launches a working TUI with alt screen, tab switching, broker status, resize handling, and clean exit.

## What Was Built

### tui/tabs/*.ts (6 files, ~55 LOC each)

Six placeholder tab renderers with consistent interface consumed by app.ts:
- `TAB_NAME` (string): display name for tab bar
- `REFRESH_MS` (number): polling interval (0 = event-driven)
- `render(startRow, startCol, width, height)`: draws placeholder content centered in bounds
- `start()` / `stop()`: lifecycle hooks for background work
- `handleKey(name)`: tab-specific key dispatch

Tab intervals per design spec:
- `gsd-watch.ts`: REFRESH_MS=0, will be wired to fs.watch in Phase 7
- `peers.ts`, `waves.ts`, `tasks.ts`, `messages.ts`: REFRESH_MS=2000
- `stats.ts`: REFRESH_MS=5000 (less frequent, DB stats)

### tui/app.ts (~150 LOC)

App class with full tab state machine:
- `activeTab: number` — index into TABS array (default 0)
- `brokerConnected: boolean` — updated every 5s via isBrokerUp()
- `onQuit: (() => void) | null` — callback hook for main.ts cleanup
- `start(noEmoji)`: hideCursor, startInput, SIGWINCH handler, per-tab setInterval timers, broker health timer, initial render
- `stop()`: clearInterval all timers, tab.stop() each tab, stopInput()
- `handleKey(key)`: q/Ctrl+C → quit via onQuit, 1-6 → tab switch, Tab/Shift+Tab → cycle, others forwarded to active tab
- `render()`: clearScreen, renderTabBar (row 1), drawHLine (row 2), active tab render (rows 3..rows-1), renderStatusBar (row rows)
- Tab bar: active tab purple bg + bright bold, inactive tabs dim gray
- Status bar: green "BROKER OK" or red "BROKER --" + URL on left, key hints on right

### tui/main.ts (~75 LOC)

Entry point for `bun tui/main.ts`:
- Arg parsing: --no-emoji flag, --help/-h with usage output
- enterAltScreen() on startup
- cleanup(): app.stop() → clearScreen() → exitAltScreen() → showCursor() → process.exit(0)
- SIGINT + SIGTERM → cleanup
- app.onQuit = cleanup

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Create 6 placeholder tab renderers | 2b36d19 |
| 2 | Create app shell (tui/app.ts + tui/main.ts) | 287b4ef |
| 3 | Human verification checkpoint | (pending) |

## Checkpoint: Task 3 — Human Verification Required

The TUI shell is complete. Automated verification passed (`bun tui/main.ts --help` prints usage and exits cleanly). Human verification is needed to confirm:

1. `bun tui/main.ts` enters alternate screen with dark background
2. Tab bar shows: `1 GSD Watch  2 Peers  3 Waves  4 Tasks  5 Messages  6 Stats`
3. Tab 1 (GSD Watch) is active by default with purple highlight
4. Pressing 2-6 switches tabs with purple indicator moving
5. Tab / Shift+Tab cycle through tabs
6. Status bar shows broker status (green if broker running, red if not) and key hints
7. Resizing the terminal re-renders without artifacts
8. q exits cleanly — no corrupted terminal (cursor visible, no escape code artifacts)
9. `bun tui/main.ts --no-emoji` works without error
10. `bun tui/main.ts --help` prints usage and exits (exit code 0)

## Deviations from Plan

None — plan executed exactly as written. All acceptance criteria verified for tasks 1 and 2.

## Known Stubs

The 6 tab modules are intentional placeholder stubs. Each renders centered text describing the planned data source and a "(Phase 7)" or "(Phase 8)" label. These will be replaced:
- `tui/tabs/gsd-watch.ts`: Phase 7 will implement .planning/ tree view with fs.watch
- `tui/tabs/peers.ts`, `waves.ts`, `tasks.ts`, `messages.ts`, `stats.ts`: Phase 8 will wire live broker data

The placeholder content does NOT prevent the plan's goal (working TUI shell with tab switching) — the stubs are intentional and tracked.

## Self-Check: PASSED

- tui/app.ts: FOUND
- tui/main.ts: FOUND
- tui/tabs/gsd-watch.ts: FOUND
- tui/tabs/peers.ts: FOUND
- tui/tabs/waves.ts: FOUND
- tui/tabs/tasks.ts: FOUND
- tui/tabs/messages.ts: FOUND
- tui/tabs/stats.ts: FOUND
- Commit 2b36d19: FOUND
- Commit 287b4ef: FOUND
