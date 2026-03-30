---
phase: 08-broker-tabs-and-endpoint
plan: 03
subsystem: ui
tags: [tui, ansi, waves, tasks, messages, broker]

# Dependency graph
requires:
  - phase: 06-tui-core
    provides: render.ts primitives, TabDef interface, app.ts refresh loop
  - phase: 08-broker-tabs-and-endpoint
    provides: /list-waves, /wave-status, /list-messages endpoints (from plan 01)
provides:
  - Waves tab (Tab 3): wave groups with status badges, per-task executor/status/duration
  - Tasks tab (Tab 4): flat task table sorted by wave/id with in-flight files footer
  - Messages tab (Tab 5): 50 most recent messages with type badges, from/to, text preview, timestamps
affects: [09-slash-commands]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - fire-and-forget fetchData() with lastRenderArgs re-render (same as peers.ts)
    - safeFetch wraps all broker calls for graceful degradation
    - wave_number propagated from /list-waves into flattened task rows

key-files:
  created: []
  modified:
    - tui/tabs/waves.ts
    - tui/tabs/tasks.ts
    - tui/tabs/messages.ts

decisions:
  - "Waves tab fetches /list-waves then /wave-status per wave — single sequential pass for simplicity"
  - "Tasks tab reuses same wave fetch pattern, flattens with wave_number attached"
  - "Messages tab uses /list-messages (read-only) not /poll-messages (ACK-based)"
  - "Badge visual width fixed at 6 chars ([XXXX]) for layout calculation"

metrics:
  duration_minutes: 3
  completed_date: "2026-03-30"
  tasks_completed: 2
  files_modified: 3
---

# Phase 08 Plan 03: Waves, Tasks, and Messages Tabs Summary

**One-liner:** Three broker visualization tabs replacing Phase 6 stubs — waves grouped by wave with per-task status/executor/duration, flat task table with in-flight files footer, and message feed with 14 color-coded type badges.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Implement Waves tab (BRKR-02) | c83ead9 | tui/tabs/waves.ts |
| 2 | Implement Tasks tab (BRKR-03) and Messages tab (BRKR-04) | 1e2c2ed | tui/tabs/tasks.ts, tui/tabs/messages.ts |

## What Was Built

### Waves Tab (tui/tabs/waves.ts)
- Fetches `/list-waves` to get all waves with summary counts
- For each wave, fetches `/wave-status` to get full task detail
- Renders wave header with status badge (completed=green, running=purple, pending=gray, failed=red), wave number, phase, and N/total task progress
- Indented per-task rows: status badge + task name (truncated to 30) + executor session ID (8 chars) or "unassigned" + elapsed duration
- Duration computed from started_at to completed_at (or now), formatted as Xs/Xm/Xh
- Footer shows wave count; j/k scrolling; "No waves" empty state

### Tasks Tab (tui/tabs/tasks.ts)
- Same data source as Waves tab (list-waves + wave-status per wave)
- Flattens all tasks with wave_number attached, sorts by wave_number ASC then id ASC
- Column headers: ID / Wave / Task / Executor / Status / Duration
- Footer row 1: task count; footer row 2: "In-flight: file1, file2..." (yellow) for running task files
- filesInFlight: parses task.files (JSON array) from all status="running" tasks

### Messages Tab (tui/tabs/messages.ts)
- Fetches `/list-messages` with `{ limit: 50 }`
- 14 color-coded type badges: EXEC/PROG/DONE/BLKD/ASK/ANS/TASK/TBLK/WAVE/SREQ/SRSP/RCLM/CHAT/MSG
- Row format: [BADGE] fromID -> toID  text preview  Xs
- timeAgo formatted as Xs/Xm/Xh/Xd
- Footer shows message count; j/k scrolling; "No messages" empty state

## Verification Pending (Task 3 — Human Checkpoint)

Task 3 is a `checkpoint:human-verify`. The following manual steps are required:

### How to Verify

1. Start the broker: `bun /home/joshuaduffill/dev/claude-peers-mcp/broker.ts &`
2. Launch the TUI: `bun /home/joshuaduffill/dev/claude-peers-mcp/tui/main.ts`
3. Press `2` — Peers tab: peer list or "No peers connected"
4. Press `3` — Waves tab: wave groups with task detail rows, or "No waves"
5. Press `4` — Tasks tab: flat task table with "No tasks" if empty; in-flight footer if waves running
6. Press `5` — Messages tab: recent messages with type badges, or "No messages"
7. Press `6` — Stats tab: broker health (green "ok"), DB info, row counts, retention
8. Verify status bar at bottom shows "BROKER OK" in green
9. Resize terminal — all tabs should re-render without artifacts
10. Press `q` — terminal should restore cleanly

### Automated Verification Results
- `bun build --no-bundle tui/tabs/waves.ts` — PASS
- `bun build --no-bundle tui/tabs/tasks.ts` — PASS
- `bun build --no-bundle tui/tabs/messages.ts` — PASS
- `bun test broker.test.ts` — 37 pass, 0 fail

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None - all three tabs are fully implemented with real broker data fetching.

## Self-Check: PASSED
- tui/tabs/waves.ts — FOUND
- tui/tabs/tasks.ts — FOUND
- tui/tabs/messages.ts — FOUND
- Commit c83ead9 — FOUND
- Commit 1e2c2ed — FOUND
