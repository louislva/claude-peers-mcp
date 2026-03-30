---
phase: 08-broker-tabs-and-endpoint
verified: 2026-03-30T21:00:00Z
status: human_needed
score: 6/6 must-haves verified
re_verification: false
human_verification:
  - test: "Launch TUI and cycle through all 5 broker tabs"
    expected: "Tabs 2-6 render real data from the broker (or appropriate empty-state messages) with correct colors, badges, and layout; status bar shows 'BROKER OK'; q restores terminal cleanly"
    why_human: "ANSI rendering, layout correctness, color coding, and terminal restore behavior cannot be verified programmatically"
  - test: "Resize the terminal while a broker tab is active"
    expected: "All tabs re-render correctly without visual artifacts after SIGWINCH"
    why_human: "Terminal resize behavior requires a live terminal session"
  - test: "Press j/k on Peers, Waves, Tasks, and Messages tabs with more items than fit in the viewport"
    expected: "Scroll position changes and the visible rows update correctly without corrupting other areas"
    why_human: "Scroll rendering requires visual inspection in a live terminal"
---

# Phase 8: Broker Tabs and Endpoint Verification Report

**Phase Goal:** Users can inspect all live broker state (peers, waves, tasks, messages, stats) from the TUI
**Verified:** 2026-03-30T21:00:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Tab 2 (Peers) shows live peer list with ORCH/EXEC/PROXY role badges, PID, summary, and color-coded last_seen — refreshes every 2s | VERIFIED | `tui/tabs/peers.ts` L78-82 role detection, L88-112 color-coded last_seen, REFRESH_MS=2000, safeFetch→/list-peers wired at L54 |
| 2 | Tab 3 (Waves) shows tasks grouped by wave with wave status badges and per-task executor, status, and duration rows | VERIFIED | `tui/tabs/waves.ts` L90-107 status badges, L180-200 per-task rows with executor + duration, safeFetch→/list-waves + /wave-status wired |
| 3 | Tab 4 (Tasks) shows a flat task table sorted by wave then task ID; footer lists files currently in-flight | VERIFIED | `tui/tabs/tasks.ts` L71-74 sort by wave_number+id, L79-90 filesInFlight collection from running tasks, L215-222 footer row 2 in-flight output |
| 4 | Tab 5 (Messages) shows 50 most recent messages across all peers (type badge, from/to, text preview, timestamp) via /list-messages | VERIFIED | `tui/tabs/messages.ts` L51 safeFetch("/list-messages", {limit:50}), L68-85 14 type badges, L147-159 from_id/to_id/text/timeAgo row format |
| 5 | Tab 6 (Stats) shows DB row counts, DB size, retention policy, schema version, and broker health — refreshes every 5s | VERIFIED | `tui/tabs/stats.ts` REFRESH_MS=5000, sections: Broker Health (L150-158), Database (L165-175), Row Counts (L183-242), Retention Policy (L253-265) |
| 6 | POST /list-messages returns most recent N messages (default 50, max 200) regardless of delivery status | VERIFIED | `broker.ts` L860: `Math.min(Math.max((body.limit ?? 50), 1), 200)`, selectRecentMessages ignores delivered flag; 4 tests at broker.test.ts L887-1007 pass |

**Score:** 6/6 truths verified

### Required Artifacts

| Artifact | Expected | Exists | Lines | Status |
|----------|----------|--------|-------|--------|
| `tui/tabs/peers.ts` | Live peer list renderer with role badges and color-coded last_seen | Yes | 247 | VERIFIED (min 80, has 247) |
| `tui/tabs/stats.ts` | Stats dashboard renderer with row counts and retention display | Yes | 303 | VERIFIED (min 60, has 303) |
| `tui/tabs/waves.ts` | Wave breakdown renderer grouped by wave | Yes | 263 | VERIFIED (min 80, has 263) |
| `tui/tabs/tasks.ts` | Flat task table renderer | Yes | 265 | VERIFIED (min 80, has 265) |
| `tui/tabs/messages.ts` | Message feed renderer with type badges | Yes | 205 | VERIFIED (min 80, has 205) |
| `broker.ts` | /list-messages and /list-waves route handlers | Yes | — | VERIFIED (routes at L938-943) |
| `shared/types.ts` | ListMessagesRequest and ListWavesResponse types | Yes | — | VERIFIED (L121-127) |
| `broker.test.ts` | Integration tests for new endpoints | Yes | — | VERIFIED (6 new tests, 37 total passing) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `tui/tabs/peers.ts` | `/list-peers` | safeFetch in fetchData() | WIRED | L54: `safeFetch<Peer[]>("/list-peers", {...})` |
| `tui/tabs/stats.ts` | `/stats` | safeFetch in fetchData() | WIRED | L90: `safeFetch<StatsResponse>("/stats")` |
| `tui/tabs/stats.ts` | `/health` | safeFetch in fetchData() | WIRED | L91: `safeFetch<HealthResponse>("/health")` |
| `tui/tabs/waves.ts` | `/list-waves` | safeFetch for wave discovery | WIRED | L62: `safeFetch<ListWavesResponse>("/list-waves")` |
| `tui/tabs/waves.ts` | `/wave-status` | safeFetch for task details per wave | WIRED | L66: `safeFetch<{wave,tasks}>("/wave-status", {wave_id})` |
| `tui/tabs/tasks.ts` | `/list-waves` | safeFetch for wave/task data | WIRED | L54: `safeFetch<ListWavesResponse>("/list-waves")` |
| `tui/tabs/messages.ts` | `/list-messages` | safeFetch for recent messages | WIRED | L51: `safeFetch<Message[]>("/list-messages", {limit:50})` |
| `broker.ts` | `shared/types.ts` | import ListMessagesRequest | WIRED | Import block includes ListMessagesRequest, ListWavesResponse, Wave |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `tui/tabs/peers.ts` | `peerData` | safeFetch→/list-peers→broker DB `peers` table | Yes — broker queries live SQLite table | FLOWING |
| `tui/tabs/stats.ts` | `statsData`, `healthData` | safeFetch→/stats, /health→broker DB | Yes — /stats queries all tables for row counts | FLOWING |
| `tui/tabs/waves.ts` | `wavesData` | safeFetch→/list-waves then /wave-status→broker DB | Yes — selectAllWaves and wave-status query DB | FLOWING |
| `tui/tabs/tasks.ts` | `allTasks`, `filesInFlight` | Same as waves — /list-waves + /wave-status | Yes — real DB data, files parsed from JSON column | FLOWING |
| `tui/tabs/messages.ts` | `messagesData` | safeFetch→/list-messages→selectRecentMessages | Yes — `SELECT * FROM messages ORDER BY sent_at DESC LIMIT ?` | FLOWING |
| `broker.ts /list-messages` | returned messages | `selectRecentMessages.all(limit)` | Yes — direct DB query, no static fallback | FLOWING |
| `broker.ts /list-waves` | returned waves | `selectAllWaves.all()` with correlated subqueries | Yes — aggregates computed from task_assignments table | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| All 37 broker tests pass including 6 new endpoint tests | `bun test broker.test.ts` | 37 pass, 0 fail, 112 expect() calls | PASS |
| peers.ts compiles without errors | `bun build --no-bundle tui/tabs/peers.ts` | exit 0 | PASS |
| stats.ts compiles without errors | `bun build --no-bundle tui/tabs/stats.ts` | exit 0 | PASS |
| waves.ts compiles without errors | `bun build --no-bundle tui/tabs/waves.ts` | exit 0 | PASS |
| tasks.ts compiles without errors | `bun build --no-bundle tui/tabs/tasks.ts` | exit 0 | PASS |
| messages.ts compiles without errors | `bun build --no-bundle tui/tabs/messages.ts` | exit 0 | PASS |
| /list-messages limit clamped to 1-200, default 50 | code inspection broker.ts L860 | `Math.min(Math.max((body.limit ?? 50), 1), 200)` confirmed | PASS |
| TUI launch and tab rendering | requires live terminal | N/A | SKIP — see Human Verification |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| BRKR-01 | 08-02-PLAN.md | Peers tab shows live peer list with role badges (ORCH/EXEC/PROXY), PID, summary, last_seen | SATISFIED | `tui/tabs/peers.ts` fully implemented: ORCH/EXEC/PROXY/PEER badges L78-82, PID L179, summary L182, color-coded last_seen L169; REFRESH_MS=2000 |
| BRKR-02 | 08-03-PLAN.md | Waves tab shows wave-by-wave breakdown with dependency info and task status per wave | SATISFIED | `tui/tabs/waves.ts`: wave header with status badge + progress, indented task rows with executor/status/duration; fetches /list-waves+/wave-status |
| BRKR-03 | 08-03-PLAN.md | Tasks tab shows flat task table with wave, executor, files, status, duration | SATISFIED | `tui/tabs/tasks.ts`: column headers ID/Wave/Task/Executor/Status/Duration, in-flight files footer at L215-222; filesInFlight parses task.files JSON |
| BRKR-04 | 08-03-PLAN.md | Messages tab shows recent message feed with type badges, from/to routing, and timestamps | SATISFIED | `tui/tabs/messages.ts`: 14 type badges L68-85, from_id/to_id/text/timeAgo row format, fetches /list-messages with limit 50 |
| BRKR-05 | 08-02-PLAN.md | Stats tab shows DB size, row counts, retention policy, schema version, and broker health | SATISFIED | `tui/tabs/stats.ts`: all 4 sections present — Broker Health (status+peers), Database (path/size/schema), Row Counts (5 categories), Retention Policy (3 settings); REFRESH_MS=5000 |
| ENDP-01 | 08-01-PLAN.md | POST /list-messages returns recent N messages regardless of delivery status (default 50, max 200) | SATISFIED | `broker.ts` L859-862: handleListMessages clamps limit, selectRecentMessages has no delivered filter; 4 tests pass including "returns both delivered and undelivered messages" |

All 6 Phase 8 requirements are SATISFIED. No orphaned requirements found.

### Anti-Patterns Found

None. Scan of all 5 tab files returned:
- No TODO/FIXME/placeholder comments
- No empty handler bodies
- No hardcoded empty arrays passed to render functions
- No `return null` stub implementations
- All data variables populated from live broker fetch, not static defaults

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | — | — | — |

### Human Verification Required

#### 1. Full TUI Visual Inspection

**Test:** Start the broker (`bun broker.ts &`), launch the TUI (`bun tui/main.ts`), press keys 2 through 6 to cycle through all broker tabs.

**Expected:**
- Tab 2 (Peers): Peer list with role badges (ORCH/EXEC/PROXY/PEER), PID values, truncated summary, green/yellow/red last_seen times — or "No peers connected" if no peers registered
- Tab 3 (Waves): Wave header rows with status badges and N/total task counts, indented task rows showing status badge + task name + executor + duration — or "No waves" if none
- Tab 4 (Tasks): Column headers (ID / Wave / Task / Executor / Status / Duration), task rows, task count footer, "In-flight: ..." footer line if any tasks are running — or "No tasks" if none
- Tab 5 (Messages): Type badge + from/to IDs + text preview + timestamp per row, message count footer — or "No messages" if none
- Tab 6 (Stats): "Broker Health" section showing OK (green) status, "Database" section with path/size/schema, "Row Counts" table with 5 categories, "Retention Policy" section with 3 settings

**Why human:** ANSI escape codes, color rendering, column alignment, and badge appearance require visual inspection in a real terminal.

#### 2. Terminal Resize Handling

**Test:** While the TUI is running on a broker tab, resize the terminal window (drag or use terminal shortcuts).

**Expected:** The active tab re-renders correctly to fill the new dimensions without any visual artifacts, overlapping text, or out-of-bounds rendering.

**Why human:** SIGWINCH response and layout recalculation require a live terminal session.

#### 3. Scroll Navigation

**Test:** On Peers, Waves, Tasks, and Messages tabs, when there are more items than fit in the visible area, press j/k (or down/up arrow keys) to scroll.

**Expected:** The scroll offset changes, visible rows update cleanly, the footer stays anchored to the bottom, and no content from adjacent rows bleeds into the scrolled area.

**Why human:** Scroll rendering correctness requires visual inspection with real data populated beyond viewport height.

### Gaps Summary

No gaps. All 6 success criteria from ROADMAP.md are satisfied:

1. Tab 2 (Peers): Full implementation with role badges, PID, summary, color-coded last_seen, 2s refresh — SATISFIED
2. Tab 3 (Waves): Wave groups with status badges, per-task executor/status/duration — SATISFIED
3. Tab 4 (Tasks): Flat table sorted by wave then task ID, in-flight files footer — SATISFIED
4. Tab 5 (Messages): 50 most recent messages with type badge, from/to, text, timestamp via /list-messages — SATISFIED
5. Tab 6 (Stats): DB row counts, size, retention, schema, health, 5s refresh — SATISFIED
6. POST /list-messages: Default 50, max 200, includes delivered and undelivered — SATISFIED

The only remaining items are visual correctness checks that require a human to confirm in a live terminal (standard for any ANSI TUI phase).

---

_Verified: 2026-03-30T21:00:00Z_
_Verifier: Claude (gsd-verifier)_
