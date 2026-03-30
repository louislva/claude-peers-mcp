# Phase 8: Broker Tabs and Endpoint - Context

**Gathered:** 2026-03-30
**Status:** Ready for planning
**Mode:** Auto-generated (infrastructure phase — discuss skipped)

<domain>
## Phase Boundary

Implement 5 broker visualization tabs (Peers, Waves, Tasks, Messages, Stats) and the new `POST /list-messages` broker endpoint. Each tab polls the broker HTTP API at configured intervals and renders formatted output using the established tab interface from Phase 6.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion. Key references:
- Design spec: `docs/superpowers/specs/2026-03-30-comms-watch-tui-design.md` (Tabs 2-6 sections)
- HTML preview: `docs/tui-preview.html` (Tabs 2-6 visual reference)
- Broker endpoints documented in CLAUDE.md

### Tab Data Sources
- **Peers tab:** `POST /list-peers` with `scope: "machine"`, `cwd: "/"`, `git_root: null`
- **Waves tab:** Needs wave discovery — use `/stats` counts.waves_running to detect if waves exist, then get wave IDs from task assignments or broker state
- **Tasks tab:** Same data source as Waves, flat view
- **Messages tab:** New `POST /list-messages` endpoint (returns recent N messages regardless of delivery)
- **Stats tab:** `GET /stats` + `GET /health`

### New Broker Endpoint
- `POST /list-messages` — add to `broker.ts`
- Request: `{ limit?: number }` (default 50, max 200)
- Response: array of Message objects (id, from_id, to_id, text, msg_type, payload, sent_at, delivered)
- SQL: `SELECT * FROM messages ORDER BY sent_at DESC LIMIT ?`

### Waves Tab Discovery Issue
- The `/wave-status` endpoint requires a wave_id
- The TUI needs to discover active wave IDs
- Options: (a) add a `/list-waves` endpoint, (b) read wave IDs from `/stats` response, (c) scan task_assignments table
- Recommend: add `POST /list-waves` endpoint returning recent waves (simplest, cleanest)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `tui/broker.ts` — `brokerFetch<T>()`, `safeFetch<T>()`, `isBrokerUp()`, `BROKER_URL`
- `tui/render.ts` — `badge()`, `fg()`, `bg()`, `resetStyle()`, `bold()`, `truncate()`, `padRight()`, color constants
- `tui/tabs/*.ts` — stub files from Phase 6 to replace
- `broker.ts` — main broker server, SQLite queries, endpoint handlers
- `shared/types.ts` — Peer, Message, Session, Wave, TaskAssignment, TaskStatus types
- `cli.ts` — existing `/list-peers` and `/stats` call patterns

### Established Patterns
- Tab modules: `TAB_NAME`, `REFRESH_MS`, `render()`, `start()`, `stop()`, `handleKey()`
- `REFRESH_MS = 2000` for broker tabs, `5000` for stats (from design spec)
- `render()` returns void, writes directly via render.ts helpers
- `start()` does initial data fetch, `stop()` clears any state
- Broker endpoint pattern: register route in Bun.serve routes, parse JSON body, query SQLite, return JSON

### Integration Points
- Each tab stub in `tui/tabs/` already has the correct TAB_NAME and REFRESH_MS
- `tui/app.ts` already calls `tab.start()` and sets up refresh timers
- `broker.ts` server needs new `/list-messages` route added
- May also need `/list-waves` route for wave discovery

</code_context>

<specifics>
## Specific Ideas

- Peers tab: role badges (ORCH/EXEC/PROXY) parsed from summary string, color-coded last_seen (green <30s, yellow 30-120s, red >120s)
- Waves tab: tasks grouped by wave with wave status badge
- Tasks tab: flat table sorted by wave then task ID, footer shows files in-flight
- Messages tab: type-colored badges, from/to routing, text preview, timestamps
- Stats tab: stat cards pattern with row counts and retention display

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>
