# Requirements: gsd-comms-mcp

**Defined:** 2026-03-30
**Core Value:** Multiple Claude Code instances can collaborate autonomously on GSD milestones without human intervention

## v1.1 Requirements

Requirements for the comms-watch TUI Dashboard milestone. Each maps to roadmap phases.

### TUI Core

- [x] **TUI-01**: TUI launches in alternate screen buffer with clean exit on quit (restores terminal state)
- [x] **TUI-02**: User can switch between 6 tabs via number keys (1-6) and Tab/Shift+Tab
- [x] **TUI-03**: TUI auto-refreshes data on configurable intervals (2s broker polling, 5s stats, event-driven for GSD Watch)
- [x] **TUI-04**: TUI handles terminal resize (SIGWINCH) without corruption
- [x] **TUI-05**: TUI renders box-drawing borders, ANSI 256 colors, and status badges

### GSD Watch Tab

- [x] **GSDW-01**: Tree view displays milestone > phases > plans hierarchy from .planning/ directory
- [x] **GSDW-02**: Phase/plan status badges update live via fs.watch() on .planning/ directory
- [x] **GSDW-03**: User can expand/collapse tree nodes with Enter, expand/collapse all with e/w
- [x] **GSDW-04**: Progress bar shows completed plans / total plans with percentage

### Broker Tabs

- [ ] **BRKR-01**: Peers tab shows live peer list with role badges (ORCH/EXEC/PROXY), PID, summary, last_seen
- [ ] **BRKR-02**: Waves tab shows wave-by-wave breakdown with dependency info and task status per wave
- [ ] **BRKR-03**: Tasks tab shows flat task table with wave, executor, files, status, duration
- [ ] **BRKR-04**: Messages tab shows recent message feed with type badges, from/to routing, and timestamps
- [ ] **BRKR-05**: Stats tab shows DB size, row counts, retention policy, schema version, and broker health

### Broker Endpoint

- [ ] **ENDP-01**: POST /list-messages returns recent N messages regardless of delivery status (default 50, max 200)

### Slash Commands

- [ ] **CMD-01**: /comms-watch launches TUI in tmux split pane (35% width, right side, duplicate detection)
- [ ] **CMD-02**: /comms-peers prints inline formatted peer list (no TUI, no tmux required)
- [ ] **CMD-03**: /comms-send <peer-id> <message> sends message to peer and reports success/failure inline
- [ ] **CMD-04**: /comms-stats prints inline stats dump with row counts and retention policy
- [ ] **CMD-05**: /comms-kill stops the broker daemon and confirms shutdown

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### TUI Enhancements

- **TUIX-01**: Mouse support for tab clicking and tree node selection
- **TUIX-02**: Filtering/search within tabs (e.g., filter messages by type)
- **TUIX-03**: Compiled binary distribution (currently runs via `bun tui/main.ts`)
- **TUIX-04**: Configuration file for themes, refresh intervals, custom keybindings

### Broker Enhancements

- **BRKX-01**: WebSocket-based real-time push (replace HTTP polling in TUI)
- **BRKX-02**: Message history pagination (beyond recent 50)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Web UI dashboard | TUI covers observability needs, web adds unnecessary complexity |
| Message sending from TUI | Use /comms-send for messaging, TUI is read-only |
| True color (24-bit) | ANSI 256 has wider terminal compatibility |
| Cross-machine broker | Localhost only, per existing constraint |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| TUI-01 | Phase 6 | Complete |
| TUI-02 | Phase 6 | Complete |
| TUI-03 | Phase 6 | Complete |
| TUI-04 | Phase 6 | Complete |
| TUI-05 | Phase 6 | Complete |
| GSDW-01 | Phase 7 | Complete |
| GSDW-02 | Phase 7 | Complete |
| GSDW-03 | Phase 7 | Complete |
| GSDW-04 | Phase 7 | Complete |
| BRKR-01 | Phase 8 | Pending |
| BRKR-02 | Phase 8 | Pending |
| BRKR-03 | Phase 8 | Pending |
| BRKR-04 | Phase 8 | Pending |
| BRKR-05 | Phase 8 | Pending |
| ENDP-01 | Phase 8 | Pending |
| CMD-01 | Phase 9 | Pending |
| CMD-02 | Phase 9 | Pending |
| CMD-03 | Phase 9 | Pending |
| CMD-04 | Phase 9 | Pending |
| CMD-05 | Phase 9 | Pending |

**Coverage:**
- v1.1 requirements: 19 total
- Mapped to phases: 19
- Unmapped: 0

---
*Requirements defined: 2026-03-30*
*Last updated: 2026-03-30 after roadmap creation (traceability complete)*
