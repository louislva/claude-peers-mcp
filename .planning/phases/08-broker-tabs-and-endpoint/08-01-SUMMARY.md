---
phase: 08-broker-tabs-and-endpoint
plan: "01"
subsystem: broker
tags: [broker, endpoints, list-messages, list-waves, tui]
dependency_graph:
  requires: []
  provides: ["/list-messages endpoint", "/list-waves endpoint", "ListMessagesRequest type", "ListWavesResponse type"]
  affects: ["tui/broker.ts (will consume these endpoints)", "broker.test.ts"]
tech_stack:
  added: []
  patterns: ["prepared statement with correlated subqueries for aggregates", "limit clamp pattern (Math.min/max)"]
key_files:
  created: []
  modified:
    - broker.ts
    - shared/types.ts
    - broker.test.ts
decisions:
  - "/list-messages uses sent_at DESC ordering so TUI shows newest messages first"
  - "limit clamped to 1-200 range (default 50) to prevent runaway queries"
  - "selectAllWaves uses correlated subqueries for task count aggregates — avoids extra round trips"
metrics:
  duration_minutes: 3
  completed_date: "2026-03-30"
  tasks_completed: 2
  files_modified: 3
---

# Phase 08 Plan 01: Broker List Endpoints Summary

**One-liner:** Added POST /list-messages and POST /list-waves to broker with correlated subquery aggregates and 6 new integration tests.

## What Was Built

Two new read-only HTTP endpoints for the TUI dashboard:

- **POST /list-messages** — Returns the most recent N messages from all peers regardless of delivery status. Used by the Messages TUI tab which needs a global read-only view (unlike `/poll-messages` which is per-peer and ACK-based). Limit parameter: default 50, clamped to 1-200.

- **POST /list-waves** — Returns all waves with per-wave task count aggregates (`task_count`, `tasks_completed`, `tasks_running`). Used by the Waves/Tasks TUI tabs which need to discover active wave IDs (unlike `/wave-status` which requires knowing the wave_id upfront).

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add /list-messages and /list-waves endpoints | 06c936f | broker.ts, shared/types.ts |
| 2 | Add integration tests for /list-messages and /list-waves | 61c8caa | broker.test.ts |

## Key Changes

### broker.ts

- Added `ListMessagesRequest` and `ListWavesResponse` to import block
- Added `Wave` to import block (needed for ListWavesResponse type annotation)
- Added `selectRecentMessages` prepared statement: `SELECT * FROM messages ORDER BY sent_at DESC LIMIT ?`
- Added `selectAllWaves` prepared statement with correlated subqueries for task count, tasks_completed, tasks_running aggregates
- Added `handleListMessages(body: ListMessagesRequest): Message[]` — clamps limit to 1-200, default 50
- Added `handleListWaves(): ListWavesResponse` — returns all waves with aggregates
- Registered `/list-messages` and `/list-waves` routes in switch statement (before `/ack-message`)

### shared/types.ts

- Added `ListMessagesRequest` interface: `{ limit?: number }`
- Added `ListWavesResponse` interface: `{ waves: Array<Wave & { task_count: number; tasks_completed: number; tasks_running: number }> }`

### broker.test.ts

6 new tests added:
1. `/list-messages` returns array (shape check)
2. `/list-messages` returns messages in `sent_at DESC` order
3. `/list-messages` respects limit parameter and caps at 200
4. `/list-messages` returns both delivered and undelivered messages
5. `/list-waves` returns waves array (shape check)
6. `/list-waves` returns task_count, tasks_running, tasks_completed aggregates

**Test count:** 31 existing + 6 new = **37 tests, all passing**

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED
