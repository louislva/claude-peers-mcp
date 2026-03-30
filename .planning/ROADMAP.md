# Roadmap: gsd-comms-mcp

## Milestones

- ✅ **v1.0 Peer-Aware Autonomous Execution** — Phases 1-5 (shipped 2026-03-25) — [archive](milestones/v1.0-ROADMAP.md)
- 🔄 **v1.1 comms-watch TUI Dashboard** — Phases 6-9 (in progress)

## Phases

<details>
<summary>✅ v1.0 Peer-Aware Autonomous Execution (Phases 1-5) — SHIPPED 2026-03-25</summary>

- [x] Phase 1: Foundation (2/2 plans) — completed 2026-03-25
- [x] Phase 2: Executor Protocol (3/3 plans) — completed 2026-03-25
- [x] Phase 3: Decision Proxy (2/2 plans) — completed 2026-03-25
- [x] Phase 4: Orchestrator Workflow (4/4 plans) — completed 2026-03-25
- [x] Phase 5: Runtime Module and Tests (2/2 plans) — completed 2026-03-25

</details>

### v1.1 comms-watch TUI Dashboard

- [ ] **Phase 6: TUI Core** - Alternate-screen shell with tab switching, resize handling, and ANSI renderer
- [ ] **Phase 7: GSD Watch Tab** - Live .planning/ tree view with fswatch and progress bar
- [ ] **Phase 8: Broker Tabs and Endpoint** - Five broker visualization tabs plus /list-messages endpoint
- [ ] **Phase 9: Slash Commands** - Five project slash commands for inline broker access and TUI launch

## Phase Details

### Phase 6: TUI Core
**Goal**: The TUI application launches, renders a tabbed interface, and handles all terminal I/O correctly
**Depends on**: Nothing (first v1.1 phase)
**Requirements**: TUI-01, TUI-02, TUI-03, TUI-04, TUI-05
**Success Criteria** (what must be TRUE):
  1. Running `bun tui/main.ts` enters alternate screen and `q` returns terminal to its prior state without corruption
  2. Pressing number keys 1-6 switches the active tab; Tab and Shift+Tab cycle through tabs in order
  3. Resizing the terminal window re-renders the layout correctly without visual artifacts
  4. Tab content updates automatically: broker tabs refresh every 2s, stats every 5s, GSD Watch responds to file events
  5. Box-drawing borders, ANSI 256 colors, and status badges render correctly in the active tab
**Plans**: 2 plans
Plans:
- [ ] 06-01-PLAN.md — Foundation modules: ANSI renderer, keypress parser, broker fetch helper
- [ ] 06-02-PLAN.md — App shell, tab state machine, placeholder tabs, and main entry point

### Phase 7: GSD Watch Tab
**Goal**: Users can monitor GSD project progress in real time from the TUI without switching windows
**Depends on**: Phase 6
**Requirements**: GSDW-01, GSDW-02, GSDW-03, GSDW-04
**Success Criteria** (what must be TRUE):
  1. Tab 1 displays a tree of milestone > phases > plans parsed from .planning/ROADMAP.md and phase directories
  2. Editing a plan file causes the status badge for that plan to update within one second (fs.watch event-driven)
  3. Pressing Enter on a tree node toggles it collapsed/expanded; `e` expands all nodes; `w` collapses all nodes
  4. A progress bar at the bottom shows completed plans / total plans and a percentage that stays accurate as files change
**Plans**: TBD
**UI hint**: yes

### Phase 8: Broker Tabs and Endpoint
**Goal**: Users can inspect all live broker state (peers, waves, tasks, messages, stats) from the TUI
**Depends on**: Phase 6
**Requirements**: BRKR-01, BRKR-02, BRKR-03, BRKR-04, BRKR-05, ENDP-01
**Success Criteria** (what must be TRUE):
  1. Tab 2 (Peers) shows the live peer list with ORCH/EXEC/PROXY role badges, PID, summary, and color-coded last_seen — refreshes every 2s
  2. Tab 3 (Waves) shows tasks grouped by wave with wave status badges and per-task executor, status, and duration rows
  3. Tab 4 (Tasks) shows a flat task table sorted by wave then task ID; footer lists files currently in-flight
  4. Tab 5 (Messages) shows the 50 most recent messages across all peers (type badge, from/to, text preview, timestamp) via the new /list-messages endpoint
  5. Tab 6 (Stats) shows DB row counts, DB size, retention policy, schema version, and broker health — refreshes every 5s
  6. POST /list-messages returns the most recent N messages (default 50, max 200) regardless of delivery status
**Plans**: TBD
**UI hint**: yes

### Phase 9: Slash Commands
**Goal**: Users can access broker state and control the TUI from any Claude Code conversation without leaving the chat
**Depends on**: Phase 6, Phase 8
**Requirements**: CMD-01, CMD-02, CMD-03, CMD-04, CMD-05
**Success Criteria** (what must be TRUE):
  1. Running /comms-watch inside a tmux session spawns the TUI in a 35%-width right pane; a second invocation detects the existing pane and does not open a duplicate
  2. Running /comms-peers prints a formatted peer list inline in the conversation without launching a TUI
  3. Running /comms-send <peer-id> <message> delivers the message and reports success or failure inline
  4. Running /comms-stats prints row counts and retention policy inline in the conversation
  5. Running /comms-kill stops the broker daemon and confirms shutdown inline
**Plans**: TBD

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | v1.0 | 2/2 | Complete | 2026-03-25 |
| 2. Executor Protocol | v1.0 | 3/3 | Complete | 2026-03-25 |
| 3. Decision Proxy | v1.0 | 2/2 | Complete | 2026-03-25 |
| 4. Orchestrator Workflow | v1.0 | 4/4 | Complete | 2026-03-25 |
| 5. Runtime Module and Tests | v1.0 | 2/2 | Complete | 2026-03-25 |
| 6. TUI Core | v1.1 | 0/2 | Planning | - |
| 7. GSD Watch Tab | v1.1 | 0/? | Not started | - |
| 8. Broker Tabs and Endpoint | v1.1 | 0/? | Not started | - |
| 9. Slash Commands | v1.1 | 0/? | Not started | - |
