# Phase 3: Decision Proxy - Context

**Gathered:** 2026-03-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Implement the decision proxy peer role: a user-primed Claude session that registers as proxy, receives `discuss_choice` messages from the orchestrator, responds with `discuss_answer` messages, includes prior decisions for consistency, logs all decisions to `.planning/DECISIONS.md`, and falls back to recommended defaults on timeout. The proxy is NOT an executor — it stays available throughout the autonomous run.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Key areas:
- Proxy agent file structure (helpers module + agent document, mirroring Phase 2 pattern)
- How proxy detects it should handle `discuss_choice` messages (summary-based identification)
- DECISIONS.md format and append strategy
- Timeout mechanism (60s for proxy response)
- How prior decisions are aggregated and included in each `discuss_choice` payload
- Whether proxy helpers are a separate module or extend existing infrastructure
- Test structure for proxy protocol flows

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design Document
- `design-peer-autonomous.md` — Decision proxy spec: `discuss_via_proxy` step (lines ~104-163), message types (`discuss_choice`/`discuss_answer`), proxy identification, timeout/fallback behavior, user priming flow

### Type Contracts (from Phase 1)
- `shared/types.ts` — `DiscussChoicePayload` (phase_number, phase_goal, question, options, recommended, context, prior_decisions), `DiscussAnswerPayload` (phase_number, chosen, reasoning)

### Executor Pattern (from Phase 2)
- `gsd-plugin/executor/executor-helpers.ts` — Reference implementation for peer protocol helpers (same pattern: brokerFetch, send_message, typed payloads)
- `gsd-plugin/agents/gsd-executor.md` — Reference for agent document structure

### Broker Endpoints
- `broker.ts` — `/send-message`, `/poll-messages`, `/ack-message` for proxy communication
- `server.ts` — MCP server with `send_message` and `check_messages` tools

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `executor-helpers.ts` `brokerFetch` pattern — proxy helpers can follow the same HTTP call pattern
- `shared/types.ts` `DiscussChoicePayload` and `DiscussAnswerPayload` — already defined with all fields
- `server.ts` message handling — existing poll/ack infrastructure for message delivery
- Existing `gsd-plugin/agents/` directory for agent documents

### Established Patterns
- Peer protocol modules: one helpers .ts file + one agent .md document + tests
- Message sending via `send_message` tool or direct broker `/send-message` endpoint
- Payload serialization as JSON string in message `payload` field
- Agent documents: imperative instructions with state machine, message handlers, constraints

### Integration Points
- Proxy receives `discuss_choice` via message poll (same as executor receives `execute_phase`)
- Proxy sends `discuss_answer` via `send_message` to orchestrator
- Proxy appends to `.planning/DECISIONS.md` (new file, created on first decision)
- Orchestrator identifies proxy by summary content containing "decision proxy"

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

*Phase: 03-decision-proxy*
*Context gathered: 2026-03-25*
