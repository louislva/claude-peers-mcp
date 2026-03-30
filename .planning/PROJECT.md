# gsd-comms-mcp

## What This Is

A peer discovery, messaging, and autonomous coordination layer for Claude Code instances. Enables multiple running Claude sessions to find each other, communicate in real-time, and collaboratively execute GSD milestones in parallel — with orchestration, decision proxying, and failure recovery built in.

## Core Value

Multiple Claude Code instances can collaborate autonomously on GSD milestones without human intervention — parallel execution, shared state, and intelligent decision-making across peers.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

- Peer discovery via broker daemon (`list_peers` by machine/directory/repo)
- Real-time messaging between Claude instances (`send_message` with channel push)
- Auto-summary generation via gpt-5.4-nano
- SQLite-backed state management (atomic transactions, WAL mode, auto-retention)
- Wave orchestration primitives (`/wave-create`, `/task-start`, `/task-complete`, `/conflict-check`)
- Session tracking via PostToolUse hook (`/session-heartbeat`)
- GSD plugin with peer coordinator agent
- CLI for broker inspection and maintenance
- ✓ Shared type contracts (13 message types, 9 payload interfaces, peer availability types) — v1.0
- ✓ `/peer-availability` endpoint (single-call peer discovery replacing 3 round trips) — v1.0
- ✓ Expanded conflict-check (lock files, auto-generated indexes) — v1.0
- ✓ Executor protocol (ACK, git setup, progress, completion, blocked, reclaim, push jitter) — v1.0
- ✓ Decision proxy (discuss_choice/answer, prior decisions, DECISIONS.md audit trail, 60s timeout) — v1.0
- ✓ Orchestrator workflow (Kahn's dependency graph, wave dispatch, monitoring, death recovery, sequential fallback) — v1.0
- ✓ Standalone runtime module (extracted topological sort + wave polling) — v1.0

### Active

<!-- Current scope. Building toward these. -->

- [ ] comms-watch TUI app with 6 tabs (GSD Watch, Peers, Waves, Tasks, Messages, Stats)
- [ ] Raw ANSI renderer (zero deps, alternate screen, resize-aware)
- [ ] GSD Watch tab replicating gsd-watch tree view with fs.watch()
- [ ] Broker visualization tabs (live polling of peers, waves, tasks, messages)
- [ ] New broker endpoint: POST /list-messages (recent messages regardless of delivery)
- [ ] Slash commands: /comms-watch, /comms-peers, /comms-send, /comms-stats, /comms-kill

## Current Milestone: v1.1 comms-watch TUI Dashboard

**Goal:** A unified terminal dashboard for monitoring GSD project status and claude-peers broker state, with slash commands for quick access.

**Target features:**
- comms-watch TUI app (6 tabs: GSD Watch, Peers, Waves, Tasks, Messages, Stats)
- Raw ANSI renderer (zero dependencies, alternate screen, resize-aware)
- GSD Watch tab (replicate gsd-watch tree view with fswatch)
- Broker visualization tabs (live polling of peers, waves, tasks, messages)
- New broker endpoint: POST /list-messages
- Slash commands: /comms-watch, /comms-peers, /comms-send, /comms-stats, /comms-kill

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- Modifying core GSD workflows — this is a wrapper/plugin layer only
- Cross-machine peer discovery — localhost only for now
- Web UI dashboard — TUI dashboard covers observability needs
- Persistent decision proxy memory — proxy is primed per-session, not stored
- Git worktree isolation per executor — v2 enhancement (RSLN-01)
- Progress-monotonicity stuck detection — v2 enhancement (RSLN-02)
- ~~Real-time dashboard — v2 enhancement (OBSV-01)~~ → Addressed by v1.1 comms-watch TUI

## Context

- Forked from louislva/claude-peers-mcp, extended with GSD v2 SQLite state management
- Broker runs on localhost:7899 with SQLite (`~/.claude-peers.db`)
- MCP server per Claude session, stdio transport
- Channel protocol for instant message delivery
- Design document co-authored by Sam and Mike (two Claude peers) at `design-peer-autonomous.md`
- Shipped v1.0 with 6,061 LOC TypeScript, 99 integration tests across 4 test files
- GSD plugin: executor, proxy, and orchestrator agent docs + helpers + workflows

## Constraints

- **GSD untouched**: No modifications to core GSD workflows, agents, or tools
- **Runtime**: Bun (not Node.js) — all new code must use Bun APIs
- **Transport**: Localhost only — broker is single-machine
- **Backwards compatible**: If no peers available, falls back to standard sequential autonomous

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Separate wrapper, not GSD fork | Keep GSD upgradeable, reduce blast radius | ✓ Good — clean separation maintained |
| One planner, many executors | Avoid race conditions on shared state (ROADMAP.md, STATE.md) | ✓ Good — orchestrator plans sequentially, dispatches in parallel |
| Decision proxy as dedicated peer role | Separates "understanding the user" from "planning/coordinating" | ✓ Good — proxy stays available, never assigned execution work |
| Single branch per wave | Simpler than per-executor branches, conflict-check prevents file overlap | ✓ Good — push jitter + conflict-check sufficient for v1 |
| Filesystem-first context handoff | Executors read plan files from git, no large message payloads | ✓ Good — keeps message payloads small, git is source of truth |
| Per-module brokerFetch duplication | Each helper module is self-contained, no cross-module imports | ✓ Good — prevents circular imports between executor/proxy/orchestrator |
| Local file-overlap matrix for conflict serialization | Static planning-time check, not runtime broker call | ✓ Good — no broker dependency during wave grouping |

## Known Tech Debt (from v1.0)

- `reclaimExecutorTask` passes `error` key to `/task-blocked` but broker expects `reason` — reclaim audit trail stores NULL
- Nyquist validation not formally signed off on any phase (VALIDATION.md exists but `nyquist_compliant: false`)
- No VALIDATION.md for Phase 1

---
*Last updated: 2026-03-30 after v1.1 milestone start*
