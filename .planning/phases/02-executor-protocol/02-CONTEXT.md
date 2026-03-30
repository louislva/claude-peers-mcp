# Phase 2: Executor Protocol - Context

**Gathered:** 2026-03-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Implement the executor agent lifecycle: receiving `execute_phase` messages, ACK within 15s, git pull + conflict-check pre-validation, progress reporting after each task, structured `phase_complete`/`phase_blocked` exit messages, `status_request` handling, `reclaim_task` handling with WIP commit, push jitter, and `--no-transition` enforcement. This is the core protocol that allows a peer to act as a remote executor for the orchestrator.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Key areas:
- Executor agent file structure (single file vs modular)
- Message handler dispatch pattern (switch, map, class methods)
- Git operation error handling strategy
- Push jitter implementation (setTimeout, crypto random)
- How to intercept/enforce --no-transition (file guard, flag check, or wrapper)
- Whether to use server.ts MCP message handlers or a separate executor module
- Test structure for executor protocol flows

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design Document
- `design-peer-autonomous.md` — Full executor protocol spec (Part 2: Executor Protocol, lines ~370-500): ACK flow, execution loop, progress reporting, blocked handling, reclaim protocol
- `design-peer-autonomous-executor.md` — Executor-specific design details if present

### Type Contracts (from Phase 1)
- `shared/types.ts` — All payload interfaces: `ExecutePhasePayload`, `PhaseCompletePayload`, `PhaseBlockedPayload`, `PhaseProgressPayload`, `StatusRequestPayload`, `StatusResponsePayload`, `ReclaimTaskPayload`, `BlockedReason`, `AutonomousPayloadMap`

### Broker Endpoints
- `broker.ts` — Existing endpoints used by executor: `/conflict-check`, `/task-start`, `/task-complete`, `/task-blocked`, `/wave-status`
- `server.ts` — MCP server with `send_message` tool (executor uses this to send ACK, progress, completion messages)

### GSD Plugin
- `gsd-plugin/` — Existing plugin structure with hooks and agents directories

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `server.ts` send_message tool — executor uses this to communicate with orchestrator
- `shared/types.ts` payload interfaces — all message shapes defined in Phase 1
- Broker `/task-start`, `/task-complete`, `/task-blocked` endpoints — executor calls these for state transitions
- Broker `/conflict-check` endpoint — executor calls this before starting execution (now expanded with lock file + index detection)

### Established Patterns
- MCP server tools follow pattern: tool definition with inputSchema + handler function
- Broker HTTP calls use fetch to localhost:7899
- Message payloads serialized as JSON strings in the `payload` field
- GSD plugin hooks in `gsd-plugin/hooks/` directory
- GSD plugin agents in `gsd-plugin/agents/` directory

### Integration Points
- Executor registers as a peer via `/register` on startup
- Executor receives `execute_phase` messages via MCP channel push or poll
- Executor sends progress/completion/blocked via `send_message` to orchestrator peer
- Executor calls broker endpoints directly for task state transitions
- `--no-transition` flag prevents executor from modifying ROADMAP.md/STATE.md

</code_context>

<specifics>
## Specific Ideas

No specific requirements — infrastructure phase

</specifics>

<deferred>
## Deferred Ideas

None

</deferred>

---

*Phase: 02-executor-protocol*
*Context gathered: 2026-03-25*
