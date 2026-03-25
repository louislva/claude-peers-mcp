# Phase 1: Foundation - Context

**Gathered:** 2026-03-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Settle shared type contracts for 9 new autonomous message types, add a `/peer-availability` broker endpoint, ensure the `failed` task state unblocks wave completion, and expand conflict-check to cover lock files and auto-generated files. This is pure infrastructure — no workflow logic, no agent files.

</domain>

<decisions>
## Implementation Decisions

### Payload Contract Design
- Claude's discretion on interface structure (strict per-type, discriminated union, or hybrid)
- Claude's discretion on required vs optional fields per payload
- Claude's discretion on broker-side vs client-side payload validation
- Claude's discretion on extending existing `MessageType` union vs creating a separate `AutonomousMessageType`

### Peer Availability Classification
- Peer is available immediately when no running task — no idle time threshold
- `/peer-availability` returns same-repo peers as primary, machine-wide peers as fallback (separate grouping in response)
- Claude's discretion on how availability is determined (summary-based, session-state-based, or hybrid)
- Claude's discretion on whether to include last-completed-task info for affinity-based assignment

### Conflict-Check Expansion
- Claude's discretion on which lock files and auto-generated files to cover
- Claude's discretion on whether to include build outputs in conflict checks
- Claude's discretion on glob patterns vs exact paths vs auto-appended patterns
- Claude's discretion on whether to include severity levels (hard/soft) in conflict response

### Claude's Discretion
- All type system architecture decisions (union shape, strictness, validation layer)
- Conflict-check pattern matching strategy and file coverage
- Availability determination method and response shape enrichment
- Any implementation details not explicitly locked above

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Type System
- `shared/types.ts` — Current type definitions: `MessageType` union (6 values), `TaskStatus` (includes `failed`), `WaveStatus`, all request/response interfaces
- `design-peer-autonomous.md` — Full architecture design with message type definitions, payload examples, and protocol spec

### Broker
- `broker.ts` — Current broker implementation: `taskCompleteTxn` (line 656), `handleConflictCheck` (line 694), all route handlers, SQLite schema
- `broker.test.ts` — Existing integration tests (23 tests covering all endpoints)

### Research
- `.planning/research/STACK.md` — Confirms zero new dependencies, all capabilities covered by Bun built-ins
- `.planning/research/ARCHITECTURE.md` — Integration points, build order recommendation
- `.planning/research/PITFALLS.md` — Missing `failed` state gap flagged, conflict-check expansion needed

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `MessageType` union in `shared/types.ts` (line 15): Currently 6 values, stored as TEXT in SQLite with no constraint — new types work without schema migration
- `TaskStatus` in `shared/types.ts` (line 52): Already includes `"failed"` — BRKR-02 may be partially satisfied
- `taskCompleteTxn` in `broker.ts` (line 656): Already counts `failed` in wave-completion check (`NOT IN ('completed', 'failed')`)
- All request/response interfaces in `shared/types.ts`: Follow consistent pattern (`FooRequest`/`FooResponse`)

### Established Patterns
- Broker endpoints follow pattern: `handleFoo(body: FooRequest): FooResponse` with a corresponding route in the switch statement
- Atomic transactions use `db.transaction()` for multi-step state changes
- Prepared statements defined at module scope for hot-path queries
- Partial indexes for query optimization (`WHERE delivered = 0`, `WHERE status = 'running'`)

### Integration Points
- New types imported by `server.ts` (MCP server) and `broker.ts` (HTTP daemon)
- `/peer-availability` joins across `peers`, `sessions`, and `task_assignments` tables
- Conflict-check currently in `handleConflictCheck` (line 694) — extend in place
- Route handler switch in `broker.ts` (line ~780) — add new case for `/peer-availability`

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches. Claude has broad discretion on all type system and implementation decisions for this foundational phase.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-foundation*
*Context gathered: 2026-03-25*
