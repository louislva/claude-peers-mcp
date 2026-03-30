# Phase 5: Runtime Module and Tests - Context

**Gathered:** 2026-03-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Extract the topological sort (Kahn's algorithm) and wave polling loop from orchestrator-helpers.ts into a standalone, independently testable runtime module. Add integration test coverage for `/peer-availability` covering available-only, busy-only, and mixed peer states. Create a documented two-session smoke test runbook that a developer can follow to verify the end-to-end executor handshake (execute_phase → ack → phase_complete).

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Key areas:
- Runtime module file location and name (e.g., `gsd-plugin/autonomous-peers-runtime.ts`)
- Which functions to extract vs leave in orchestrator-helpers (topological sort + wave poll are the targets)
- Whether to re-export from orchestrator-helpers for backwards compatibility
- Smoke test runbook format (markdown document with step-by-step instructions)
- Test structure for extracted runtime module

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source Module (Phase 4)
- `gsd-plugin/orchestrator/orchestrator-helpers.ts` — Contains `buildExecutionWaves` (Kahn's algorithm) and `waitForWaveComplete` (wave polling) to extract
- `gsd-plugin/orchestrator/orchestrator-helpers.test.ts` — Existing tests for these functions (must continue passing after extraction)

### Broker Endpoints
- `broker.ts` — `/peer-availability` endpoint (needs additional integration test coverage)
- `broker.test.ts` — Existing broker tests including some peer-availability coverage from Phase 1

### Type Contracts
- `shared/types.ts` — `PeerAvailabilityResponse`, `AvailablePeer`, `BusyPeer`

### Executor Protocol (for smoke test)
- `gsd-plugin/executor/executor-helpers.ts` — `sendAck`, `sendPhaseComplete` for the handshake
- `gsd-plugin/agents/gsd-executor.md` — Executor lifecycle documentation

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `buildExecutionWaves` in orchestrator-helpers.ts — Kahn's algorithm already implemented and tested
- `waitForWaveComplete` in orchestrator-helpers.ts — wave polling loop already implemented
- `broker.test.ts` — 5 peer-availability tests from Phase 1 (may already cover some states)
- `executor-helpers.test.ts` — 27 executor tests provide patterns for the smoke test

### Established Patterns
- Integration tests against isolated broker on unique port
- `brokerFetch<T>()` pattern for HTTP calls
- `bun test` as test runner
- Dynamic imports in test files for env var override

### Integration Points
- Extracted runtime module imports from `shared/types.ts` for PhaseNode and wave types
- Orchestrator-helpers imports from runtime module (after extraction)
- Smoke test references executor and orchestrator helpers

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

*Phase: 05-runtime-module-and-tests*
*Context gathered: 2026-03-25*
