# gsd-comms-mcp

## What This Is

A peer discovery and messaging layer for Claude Code instances, designed to work alongside GSD v1. Enables multiple running Claude sessions to find each other, communicate in real-time, and coordinate work — replacing the isolated single-session model with collaborative multi-agent execution.

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

### Active

<!-- Current scope. Building toward these. -->

- [ ] Peer-aware autonomous wrapper workflow
- [ ] Decision proxy peer for unattended discuss-phase choices
- [ ] Parallel phase execution with dependency analysis
- [ ] New broker endpoint: `/peer-availability`
- [ ] Executor protocol (receive plan, execute, report, handle blocks)
- [ ] Error recovery (death handling, task reclaim, conflict resolution)

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- Modifying core GSD workflows — this is a wrapper/plugin layer only
- Cross-machine peer discovery — localhost only for now
- Web UI dashboard — CLI and peer messaging are sufficient
- Persistent decision proxy memory — proxy is primed per-session, not stored

## Context

- Forked from louislva/claude-peers-mcp, extended with GSD v2 SQLite state management
- Broker runs on localhost:7899 with SQLite (`~/.claude-peers.db`)
- MCP server per Claude session, stdio transport
- Channel protocol for instant message delivery
- Design document co-authored by Sam and Mike (two Claude peers) at `design-peer-autonomous.md`
- Existing gsd-plugin provides PostToolUse hook and peer coordinator agent

## Constraints

- **GSD untouched**: No modifications to core GSD workflows, agents, or tools
- **Runtime**: Bun (not Node.js) — all new code must use Bun APIs
- **Transport**: Localhost only — broker is single-machine
- **Backwards compatible**: If no peers available, falls back to standard sequential autonomous

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Separate wrapper, not GSD fork | Keep GSD upgradeable, reduce blast radius | -- Pending |
| One planner, many executors | Avoid race conditions on shared state (ROADMAP.md, STATE.md) | -- Pending |
| Decision proxy as dedicated peer role | Separates "understanding the user" from "planning/coordinating" | -- Pending |
| Single branch per wave | Simpler than per-executor branches, conflict-check prevents file overlap | -- Pending |
| Filesystem-first context handoff | Executors read plan files from git, no large message payloads | -- Pending |

---
*Last updated: 2026-03-25 after milestone v1.0 initialization*
