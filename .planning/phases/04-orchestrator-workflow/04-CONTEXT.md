# Phase 4: Orchestrator Workflow - Context

**Gathered:** 2026-03-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Implement the `/gsd:autonomous-peers` workflow that orchestrates a full autonomous milestone run: discover peers via `/peer-availability`, classify into proxy + executors, build dependency graph from ROADMAP.md with Kahn's algorithm cycle detection, group independent phases into execution waves, plan phases sequentially (orchestrator-only), dispatch execution to available executor peers in parallel, monitor via `/wave-status` polling, route discuss-phase choices through the decision proxy, reclaim tasks from unresponsive executors, handle executor death with partial work recovery, and fall back to standard sequential autonomous execution when no peers are available.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Key areas:
- Workflow file structure (single orchestrator-helpers.ts + skill/command document, or modular)
- How Kahn's algorithm and wave grouping are implemented (inline vs extracted function)
- Wave dispatch pattern (parallel spawn with Promise.all vs sequential with parallelization flag)
- Polling mechanism for wave status (setInterval, recursive setTimeout, or loop with sleep)
- How orchestrator identifies proxy vs executors from peer summary content
- State machine implementation (explicit states vs implicit flow)
- How sequential fallback is triggered and whether it reuses existing `/gsd:autonomous` skill
- Test structure for orchestrator protocol flows
- Whether orchestrator helpers are a single file or split into discovery/dispatch/monitoring modules

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design Documents
- `design-peer-autonomous-orchestrator.md` — Full orchestrator design: state machine, peer classification, dependency analysis, wave dispatch loop, monitoring, death handling, delegation decisions
- `design-peer-autonomous.md` — Overall architecture: peer roles, message protocol, fallback behavior, discuss_via_proxy step

### Existing Protocol Modules (from Phases 2-3)
- `gsd-plugin/executor/executor-helpers.ts` — Executor protocol functions (reference for brokerFetch pattern, message sending)
- `gsd-plugin/proxy/proxy-helpers.ts` — Proxy protocol functions (sendDiscussChoice, waitForAnswer for orchestrator-side use)
- `gsd-plugin/agents/gsd-executor.md` — Executor agent document (reference for agent doc structure)
- `gsd-plugin/agents/gsd-proxy.md` — Proxy agent document

### Type Contracts (from Phase 1)
- `shared/types.ts` — All payload interfaces: `ExecutePhasePayload`, `PhaseCompletePayload`, `PhaseBlockedPayload`, `PhaseProgressPayload`, `StatusRequestPayload`, `StatusResponsePayload`, `ReclaimTaskPayload`, `PeerAvailabilityRequest`, `PeerAvailabilityResponse`

### Broker Endpoints
- `broker.ts` — `/peer-availability`, `/wave-create`, `/wave-status`, `/task-start`, `/task-complete`, `/task-blocked`, `/conflict-check`, `/send-message`, `/poll-messages`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `proxy-helpers.ts` `sendDiscussChoice` + `waitForAnswer` — orchestrator uses these directly for proxy communication
- `executor-helpers.ts` `brokerFetch` pattern — orchestrator helpers follow same HTTP call pattern
- `shared/types.ts` all payload interfaces — complete type contracts for every message
- Broker wave/task endpoints — `/wave-create`, `/wave-status`, `/task-start`, `/task-complete`, `/task-blocked`
- Existing `/gsd:autonomous` skill — sequential fallback already exists, orchestrator wraps around it

### Established Patterns
- Protocol modules: one helpers .ts file + one agent/skill .md document + tests
- `brokerFetch<T>(endpoint, body)` for all broker HTTP calls
- Message sending via `send_message` with typed payloads
- Integration tests against isolated broker on unique port
- GSD skills in `.claude/get-shit-done/skills/` directory

### Integration Points
- Orchestrator calls `/peer-availability` to discover peers on startup
- Orchestrator classifies peers by summary content ("decision proxy" → proxy, others → executors)
- Orchestrator sends `execute_phase` to executor peers, monitors via `/wave-status`
- Orchestrator routes discuss-phase to proxy via `sendDiscussChoice`/`waitForAnswer`
- Orchestrator reclaims unresponsive tasks via `reclaim_task` message + `/task-blocked`
- Falls back to standard `/gsd:autonomous` skill when no peers available

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

*Phase: 04-orchestrator-workflow*
*Context gathered: 2026-03-25*
