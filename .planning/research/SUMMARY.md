# Project Research Summary

**Project:** gsd-comms-mcp — Peer-aware autonomous orchestration milestone
**Domain:** Multi-agent AI orchestration layered on existing peer messaging infrastructure
**Researched:** 2026-03-25
**Confidence:** HIGH

## Executive Summary

This milestone adds parallel phase execution across Claude Code peers to the existing gsd-comms-mcp system. The critical insight from research is that the entire feature set can be built on the existing stack with zero new dependencies: Bun 1.3.11, bun:sqlite, and @modelcontextprotocol/sdk already provide everything required. The new components are pure TypeScript logic — a broker endpoint, two agent markdown files, one orchestrator workflow, and a small runtime module (~200 lines). The implementation surface is deliberately small by design: three seams in the existing codebase, all additive.

The recommended approach is to build in strict dependency order: type definitions first, then the `/peer-availability` broker endpoint, then executor and decision proxy agent files, then the orchestrator workflow. This order is non-negotiable because the orchestrator is the integration point for every other component, and testing it end-to-end requires the broker endpoint and executor protocol to exist first. The architecture is a flat hierarchy: one orchestrator session, N executor sessions, one optional decision proxy. No nested orchestration, no cross-machine discovery, no auto-spawning — users pre-launch executor sessions, the orchestrator discovers them.

The two most dangerous risks are git conflict cascades from concurrent executors on a shared branch (Pitfall 1) and pipeline freezes from the absence of a terminal `failed` state in the task state machine (Pitfall 5). Both require deliberate mitigations during implementation: expanded conflict-check coverage for side-effect files, push jitter, and a `failed` state with max-wave-age enforcement. The decision proxy introduces a subtler risk — bad architectural decisions propagating silently into downstream phases — which is addressed by including prior decisions in each proxy query and writing a `.planning/DECISIONS.md` log. Security validation of `plan_path` and `from_id` in executor message handling is not optional for a system with broad filesystem access.

## Key Findings

### Recommended Stack

The milestone requires no new dependencies. All implementation builds on the existing Bun 1.3.x runtime, bun:sqlite for state, @modelcontextprotocol/sdk for MCP protocol, and Bun.$`` for git operations. The `AbortSignal.timeout()` pattern for all timeout handling is already in use in server.ts. Dependency graph analysis (topological sort) is implemented inline using Kahn's algorithm at roughly 30 lines — no library justified. State machines are pure TypeScript control flow following the same pattern as existing broker.ts transactions.

**Core technologies:**
- Bun 1.3.11: runtime, shell execution, HTTP server, timers — already in use, no version change
- bun:sqlite: all orchestration state (waves, tasks, peers, messages) — schema unchanged
- @modelcontextprotocol/sdk ^1.27.1: MCP stdio server, channel push — already in use
- TypeScript ^5: type safety — extend MessageType union and add PeerAvailabilityResponse interface
- Bun.$``: git branch creation, rebase, push, merge — already mandated by CLAUDE.md

**What not to add:** graphology/toposort (trivially self-contained), xstate (5-7 state machines, no visual tooling needed), simple-git (Bun.$ covers all needed ops), p-queue (broker wave state is the queue), Temporal/Bull (overkill for localhost single-process).

### Expected Features

Production multi-agent orchestration systems (CrewAI Flows, AutoGen, LangGraph, Claude Code Agent Teams) converge on the same core requirements. This milestone implements all table-stakes features and the most valuable differentiators.

**Must have (table stakes):**
- Peer discovery with availability classification — distinguish idle vs busy before dispatching
- Executor ACK protocol — explicit acknowledgment before treating task as dispatched; 15s timeout triggers reclaim
- Dependency-aware phase grouping (waves) — topological sort of ROADMAP.md phases into parallel execution groups
- Single orchestrator ownership of ROADMAP.md and STATE.md — enforced by `--no-transition` flag on executors
- Structured completion reporting (`phase_complete` with verification result) — orchestrator needs pass/fail to advance waves
- Typed blocked/stuck reporting (`phase_blocked` with reason category) — enables differentiated recovery paths
- Task reclaim on executor death — broker PID cleanup triggers orchestrator reassignment
- Fallback to sequential execution if no peers discovered — system must function without peers
- File conflict detection before dispatch — `/conflict-check` called pre-dispatch; side-effect files need expanded coverage
- Progress heartbeat (`phase_progress`) — distinguishes working-slowly from stuck
- Status ping (`status_request`/`status_response`) — liveness check independent of task events
- Context handoff via filesystem — executor reads PLAN.md, not message payload

**Should have (differentiators):**
- Decision proxy peer (`discuss_choice`/`discuss_answer`) — eliminates blocking on discuss-phase choices in autonomous runs
- Wave-scoped branch strategy — single branch per wave, push after each task, merge on wave completion
- `/peer-availability` single-call endpoint — replaces three round-trips for orchestrator startup
- Post-wave git sync and state refresh — prevents drift across long multi-wave runs
- Dynamic wave insertion on conflict — serializes colliding "independent" phases without replanning
- Partial-completion triage on reclaim — check git log before reassigning from scratch

**Defer:**
- Partial-completion >80% heuristic — useful but adds orchestrator complexity; implement after basic reclaim works
- CLI wave visibility enhancements — existing `bun cli.ts stats` covers initial monitoring needs
- Persistent decision proxy memory — explicitly out of scope; preferences live in conversation context

### Architecture Approach

The new layer adds three new components on top of the existing broker/server architecture without modifying any existing files except for two additive changes: extending the `MessageType` union in `shared/types.ts` and adding one endpoint to `broker.ts`. The `/gsd:autonomous-peers` orchestrator workflow is the brain; it owns all global GSD state. The executor protocol agent defines worker behavior including ACK, git setup, execution, and completion reporting. The decision proxy agent defines a separate long-running peer session the user primes before a run.

**Major components:**
1. `/gsd:autonomous-peers` workflow — orchestrator brain: discover_peers, dependency_analysis, parallel_phase_loop, death_handling, fallback to sequential
2. `gsd-plugin/agents/executor-protocol.md` — executor lifecycle (IDLE → ACK_RECEIVED → SETUP → EXECUTING → COMPLETING → IDLE), git setup, progress/completion/blocked reporting
3. `gsd-plugin/agents/decision-proxy.md` — long-running peer that receives discuss_choice, responds with discuss_answer using stored conversation preferences
4. `/peer-availability` broker endpoint — single JOIN across peers + task_assignments + sessions, replaces three calls
5. `autonomous-peers-runtime.ts` — topological sort module + wave polling loop (~150–200 lines)

**Build order:** types → broker endpoint → executor agent → decision proxy agent → orchestrator workflow → integration tests. This order is dependency-driven and cannot be reordered.

### Critical Pitfalls

1. **Concurrent executors producing git conflicts on shared branch** — Expand conflict-check to cover side-effect files (*.lock, barrel indexes). Add push jitter (0–5s random delay). Consider git worktrees per executor for full isolation. Treat repeated push failures as signal to serialize.

2. **Stuck agent not detected via PID liveness alone** — Require progress monotonicity: if two consecutive `status_response` messages show identical `tasks_completed` and `last_commit`, trigger reclaim regardless of PID liveness. Add per-task wall-clock deadline.

3. **Decision proxy bad decisions cascading into downstream phases** — Include `prior_decisions` array in every `discuss_choice` payload. Write `.planning/DECISIONS.md` after each proxy answer. For choices affecting more than two downstream phases, escalate to user rather than delegating to proxy.

4. **Dependency graph cycle from LLM-inferred dependencies** — Run mandatory cycle detection (DFS or Kahn's) on inferred graph before constructing waves. Fail loudly and surface the cycle to the user. Never silently drop phases.

5. **Blocked task freezing entire pipeline indefinitely** — Add `failed` terminal state to `task_assignments`. After 2 retries, transition `blocked` → `failed`. Treat `failed` as terminal in wave-completion check. Add max wave age (30 min) with force-fail fallback.

**Integration-specific warnings from existing codebase:**
- `/conflict-check` is file-list-only — real execution produces side-effect writes not in declared task files
- Task reassignment has no idempotency guard — a recovered executor can call `/task-start` again; need session-level ownership check
- `sessionEndTxn` cascades-deletes all messages — orchestrator must ACK all pending messages before calling session-end for any peer

## Implications for Roadmap

Based on the dependency structure in ARCHITECTURE.md and the pitfall phase-mapping in PITFALLS.md, the natural phase structure follows the build order with security hardening embedded, not deferred.

### Phase 1: Foundation — Type Contracts and Broker Endpoint

**Rationale:** Every subsequent component depends on the `MessageType` union and `PeerAvailabilityResponse` types being settled. The broker endpoint must exist before the orchestrator workflow can be tested end-to-end. This phase has no risk — it is purely additive to existing files.
**Delivers:** Extended `shared/types.ts` (9 new message types, `PeerAvailabilityResponse` interface); `/peer-availability` endpoint in broker.ts with handler, prepared JOIN statement, and test coverage in broker.test.ts.
**Addresses:** `/peer-availability` single-call endpoint (differentiator); enables discover_peers step in orchestrator.
**Avoids:** Pitfall 4 (cycle detection) — types for wave graph structures should include a `dependencies: number[]` field now, not retrofitted later.
**Research flag:** Standard patterns, skip research-phase. Direct implementation against existing broker.ts.

### Phase 2: Executor Protocol

**Rationale:** The executor contract must be defined before the orchestrator's dispatch and monitoring logic is written. If executor behavior is defined after the orchestrator, the orchestrator will embed assumptions that conflict with the executor implementation.
**Delivers:** `gsd-plugin/agents/executor-protocol.md` — complete executor lifecycle state machine, git setup procedure, progress/completion/blocked message protocol, `status_request` response, `reclaim_task` response, security validation of `plan_path` and `from_id`.
**Addresses:** Table-stakes executor ACK protocol, progress heartbeat, typed blocked reporting, context handoff via filesystem.
**Avoids:** Pitfall 1 (push conflict — document push jitter requirement here), Pitfall 6 (phantom completion — executor must include push result in phase_complete payload), Pitfall 8 (security — validate plan_path against broker record and realpath against git root), Pitfall 9 (SHA-churn — force-with-lease), Anti-Pattern 4 (blocking channel push on processing).
**Research flag:** Standard patterns, skip research-phase. Executor lifecycle is well-specified in design-peer-autonomous.md.

### Phase 3: Decision Proxy Agent

**Rationale:** Independent of executor protocol; can be written in parallel with Phase 2 but is sequenced here for simplicity. Depends only on Phase 1 message types.
**Delivers:** `gsd-plugin/agents/decision-proxy.md` — proxy persona, discuss_choice/discuss_answer protocol, how to set summary for orchestrator classification, prior_decisions handling, graceful deregistration behavior.
**Addresses:** Decision proxy differentiator; unblocks discuss-phase choices in autonomous runs.
**Avoids:** Pitfall 3 (cascading bad decisions — prior_decisions in payload, DECISIONS.md log requirement), Pitfall 12 (graceful deregistration — proxy updates summary on each query/response).
**Research flag:** Standard patterns, skip research-phase. Protocol is well-specified in design-peer-autonomous.md.

### Phase 4: Orchestrator Workflow

**Rationale:** The integration point for everything. Must come after executor protocol and decision proxy are defined. This is the largest and most complex piece. Build it in sub-steps: discovery + dependency analysis first (no broker writes, low risk), then single-peer happy path, then multi-peer, then proxy integration, then death handling last.
**Delivers:** `/gsd:autonomous-peers` workflow — discover_peers (list_peers + peer classification), dependency_analysis (ROADMAP.md parse + topological sort + cycle detection), parallel_phase_loop (wave management + dispatch + monitoring + post-wave sync), discuss_via_proxy, executor_death_handling + reclaim, sequential fallback if no peers.
**Addresses:** All table-stakes features; wave-scoped branch strategy; dynamic wave insertion; post-wave sync; fallback to sequential.
**Avoids:** Pitfall 2 (stuck detection — progress monotonicity check on status_response), Pitfall 4 (cycle detection — mandatory DFS before wave construction), Pitfall 5 (pipeline freeze — failed state transitions, max wave age), Pitfall 7 (context window — filesystem-first state, wave-completion checkpoint files), Pitfall 10 (stale availability — 30s freshness check at dispatch), Pitfall 11 (STATE.md drift — wave-completion checkpoint before post-wave sync), Anti-Pattern 1 (do not fork /gsd:autonomous), Anti-Pattern 3 (orchestrator owns wave state transitions).
**Research flag:** Needs `/gsd:research-phase` for the dependency analysis parsing logic — specifically, the format in which ROADMAP.md expresses phase dependencies needs to be confirmed against real GSD-generated roadmaps before coding the parser.

### Phase 5: Runtime Module and Integration Tests

**Rationale:** Extract the topological sort and wave polling loop into a standalone TypeScript module (`autonomous-peers-runtime.ts`) to enable unit testing independent of the full orchestrator workflow. Then integration testing with two real Claude sessions.
**Delivers:** `gsd-plugin/agents/autonomous-peers-runtime.ts` (~150–200 lines: Kahn's algorithm, wave polling loop with `setInterval` + `fetch`); expanded `broker.test.ts` tests for `/peer-availability`; integration test runbook for two-session smoke test.
**Addresses:** Validates all phases end-to-end; catches Pitfall 6 (message ordering) and Pitfall 9 (SHA-churn) in practice.
**Avoids:** Testing the orchestrator and executor as a black box only — the runtime module must be unit-testable in isolation.
**Research flag:** Standard patterns, skip research-phase. Bun test patterns are well-documented.

### Phase Ordering Rationale

- Types first because all components share the same contracts; settling them prevents rework.
- Broker endpoint before orchestrator because the orchestrator's first step (`discover_peers`) calls this endpoint; it must be testable independently.
- Executor before orchestrator because the orchestrator's dispatch logic encodes assumptions about executor behavior; defining the contract first prevents mismatch.
- Proxy parallel-capable with executor but sequenced after for simplicity.
- Orchestrator last because it is the integration point; partial orchestrator is not testable until its dependencies exist.
- Security validation (Pitfall 8) is embedded in Phase 2 (executor), not deferred — the executor has full filesystem and shell access; unsanitized plan paths are a real risk.
- The `failed` terminal state (Pitfall 5) must be addressed in Phase 1 (schema/types) and Phase 4 (orchestrator policy), not as a follow-up; pipeline freeze in the first real use would require a schema migration under load.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 4 (Orchestrator Workflow):** The dependency analysis parser needs to confirm the exact format of ROADMAP.md phase dependency declarations against real GSD-generated roadmaps. If GSD does not emit explicit dependency declarations, the inference approach is the fallback, and cycle detection becomes more critical. Run `/gsd:research-phase` before coding the parser.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Foundation):** Direct SQLite query + TypeScript types; no external patterns needed.
- **Phase 2 (Executor Protocol):** Fully specified in design-peer-autonomous.md.
- **Phase 3 (Decision Proxy):** Fully specified in design-peer-autonomous.md.
- **Phase 5 (Runtime + Tests):** Bun test and setInterval patterns are well-established in the codebase.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All findings verified against actual source files (broker.ts, server.ts, package.json, CLAUDE.md). Zero new dependencies required — this is a strong, verifiable claim. |
| Features | HIGH | Table-stakes features validated against official docs (CrewAI, LangGraph, AutoGen, Claude Code Agent Teams). Differentiators grounded in design-peer-autonomous.md which was co-authored by peer Claude instances with full codebase access. |
| Architecture | HIGH | Derived from direct reading of all source files. Build order is dependency-driven with no ambiguity. The three integration seams are precisely identified. |
| Pitfalls | MEDIUM-HIGH | Critical pitfalls (1, 2, 4, 5) are grounded in direct broker.ts code analysis and official Claude Code issue trackers. Security pitfall (8) backed by OWASP 2025. Git conflict pitfalls backed by community research. Context window pitfall (7) backed by multiple 2025-2026 sources. Overall confidence is high for the "what can go wrong" but prevention strategies for some pitfalls (worktrees, push jitter calibration) require validation against real executor behavior. |

**Overall confidence:** HIGH

### Gaps to Address

- **ROADMAP.md dependency format:** The orchestrator's `dependency_analysis` step assumes ROADMAP.md phases carry explicit dependency declarations. If GSD's roadmap format does not include these, the parser must fall back to LLM inference, which introduces the cycle risk from Pitfall 4. Validate against a real GSD-generated ROADMAP.md before writing the parser.
- **Git worktree vs single-branch decision:** The research recommends git worktrees as the robust solution for concurrent pushes (Pitfall 1) but the design doc specifies single-branch-per-wave. This tension needs a deliberate decision in Phase 2 executor protocol design. Single-branch with push jitter is simpler but more fragile; worktrees are more robust but add orchestrator branch-management complexity.
- **Decision proxy timeout calibration:** PITFALLS.md recommends 30s proxy timeout; FEATURES.md/design-doc specifies 60s. The right value depends on observed proxy response times in practice. Start with 60s (design doc) and lower if proxy runs are faster than expected.
- **`--dangerously-load-development-channels` requirement:** Channel push (the instant notification path) requires this flag on every session. Setup instructions must make this explicit and visible. Without it, executor message delivery degrades to manual polling. This is a user-facing friction point that needs documentation emphasis.

## Sources

### Primary (HIGH confidence)
- `/home/joshuaduffill/dev/claude-peers-mcp/broker.ts` — full endpoint, schema, and transaction analysis
- `/home/joshuaduffill/dev/claude-peers-mcp/server.ts` — channel push loop, AbortSignal.timeout pattern (line 61)
- `/home/joshuaduffill/dev/claude-peers-mcp/shared/types.ts` — current MessageType union (line 15)
- `/home/joshuaduffill/dev/claude-peers-mcp/design-peer-autonomous.md` — co-authored design specification
- `/home/joshuaduffill/dev/claude-peers-mcp/.planning/PROJECT.md` — validated requirements and explicit out-of-scope decisions
- [Claude Code Agent Teams (official docs)](https://code.claude.com/docs/en/agent-teams) — table-stakes and anti-pattern validation
- [OWASP LLM Top 10 2025](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) — Pitfall 8 security basis
- [Claude Code issues #20430, #27172](https://github.com/anthropics/claude-code/issues/) — stuck agent and unattended mode behavior

### Secondary (MEDIUM confidence)
- [MAST taxonomy — arXiv 2503.13657](https://arxiv.org/pdf/2503.13657) — multi-agent failure taxonomy
- [Galileo: Multi-Agent AI Failure Recovery](https://galileo.ai/blog/multi-agent-ai-system-failure-recovery) — failure recovery patterns
- [CrewAI Documentation](https://docs.crewai.com) — parallel execution and dependency patterns
- [LangGraph: Agent Orchestration Framework](https://www.langchain.com/langgraph) — DAG-based wave grouping validation
- [Git Worktrees for Parallel Agent Workflows](https://elchemista.com/en/post/how-to-leverage-git-trees-for-parallel-agent-workflows) — Pitfall 1 prevention
- [Context Window Overflow — Redis Blog](https://redis.io/blog/context-window-overflow/) — Pitfall 7 basis
- [Shipyard: Claude Code Multi-agent 2026](https://shipyard.build/blog/claude-code-multi-agent/) — deployment patterns

### Tertiary (LOW confidence)
- [DEV Community: LangGraph vs CrewAI vs AutoGen 2026](https://dev.to/pockit_tools/langgraph-vs-crewai-vs-autogen-the-complete-multi-agent-ai-orchestration-guide-for-2026-2d63) — pattern validation only; community post

---
*Research completed: 2026-03-25*
*Ready for roadmap: yes*
