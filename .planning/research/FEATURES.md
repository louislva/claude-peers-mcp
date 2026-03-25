# Feature Landscape: Peer-Aware Autonomous Execution

**Domain:** Multi-agent AI orchestration — parallel phase execution across Claude Code instances
**Researched:** 2026-03-25
**Research Mode:** Ecosystem — what do production multi-agent systems require?

---

## Context: What Already Exists

This milestone builds on top of completed infrastructure. Do NOT re-implement:

- Peer discovery (`list_peers` by scope) — DONE
- Messaging with channel push (`send_message`, `poll-messages`, `ack-message`) — DONE
- Wave/task primitives (`/wave-create`, `/task-start`, `/task-complete`, `/conflict-check`) — DONE
- Session tracking (`/session-heartbeat`, `/session-status`, `/session-end`) — DONE
- GSD PostToolUse hook and peer coordinator agent — DONE

All new features build on or extend this foundation.

---

## Table Stakes

Features that multi-agent orchestration systems universally implement. If missing, the system is incomplete or unreliable. Evidence drawn from CrewAI Flows, AutoGen, LangGraph, and Claude Code Agent Teams (all verified via official docs and current-year sources).

| Feature | Why Expected | Complexity | Dependency on Existing |
|---------|--------------|------------|------------------------|
| **Peer discovery with availability classification** | Systems must distinguish idle peers from busy ones before dispatching work. Claude Code Agent Teams, CrewAI, and AutoGen all require this. Sending tasks to busy executors wastes rounds. | Low | Extends `/list-peers` + wave-status into new `/peer-availability` endpoint |
| **Executor acknowledgment protocol** | Every production orchestration framework requires an explicit ACK before treating a task as dispatched. Without it, tasks are silently lost when the target is unavailable. Claude Code Agent Teams document this as a mandatory pattern. | Low | Uses existing `send_message` + `ack-message`. New: timeout-based reclaim on missing ACK. |
| **Dependency-aware phase grouping (waves)** | LangGraph, CrewAI Flows, and AutoGen all treat dependency analysis as table stakes. Without DAG-based grouping, parallel execution violates ordering constraints. | Medium | `/wave-create` already exists. New: orchestrator-side dependency analysis reading ROADMAP.md |
| **Single orchestrator ownership of shared state** | All frameworks that support parallel workers enforce one writer for shared state. CrewAI and Claude Code Agent Teams both document this. Without it, ROADMAP.md and STATE.md get conflicting writes. | Low | Architecture decision, no new broker code. Enforced by `--no-transition` flag on executors |
| **Task completion reporting with verification result** | AutoGen and LangGraph require workers to report a structured completion payload — not just "done." Orchestrators need pass/fail to decide whether to proceed to the next wave. | Low | New `phase_complete` message type using existing `send_message` + `payload` field |
| **Blocked/stuck reporting with typed reasons** | Claude Code Agent Teams explicitly document that stuck teammates must report with reasons so the lead can route. LangGraph supports this via conditional edges. Without categorized reasons, the orchestrator cannot distinguish recoverable from fatal blocks. | Low | New `phase_blocked` message type; reason categories map to distinct orchestrator actions |
| **Task reclaim on executor death** | Every production framework (CrewAI Flows, AutoGen, LangGraph) documents this. The broker already cleans dead PIDs; the orchestrator must notice and reassign. Unreclaimed tasks silently stall the pipeline. | Medium | Uses existing PID-cleanup in broker + wave-status polling. New: orchestrator detects orphaned running tasks |
| **Fallback to sequential if no peers** | Validated requirement from Claude Code Agent Teams ("graceful degradation") and the project's own constraints. The system must not require peers to function. | Low | Conditional branch in orchestrator wrapper — if `available_executors.length === 0`, run locally |
| **File conflict detection before dispatch** | Claude Code Agent Teams explicitly warn against two teammates editing the same file. The broker `/conflict-check` endpoint exists for this reason. Dispatching without checking causes git push failures that block the wave. | Low | `/conflict-check` already exists. New: orchestrator calls it before every dispatch |
| **Progress heartbeat from executors** | LangGraph and AutoGen both document periodic progress signals to distinguish "working slowly" from "stuck." Without these, the orchestrator can't set a sensible timeout. | Low | New `phase_progress` message type. Executor sends after each task commit. |
| **Status-request / status-response ping** | Production multi-agent systems universally implement a liveness check separate from task events. Claude Code Agent Teams document explicit teammate pinging. | Low | New `status_request` / `status_response` message types using existing messaging |
| **Context handoff via filesystem** | Claude Code Agent Teams document that teammates load project context from files, not from the lead's message history. LangGraph and CrewAI both use shared state objects for the same reason — message payloads are too expensive for large context. | Low | Plan files written by orchestrator to git. Executors read PLAN.md from filesystem. `context_summary` field is optional fallback only. |

---

## Differentiators

Features that go beyond baseline orchestration and provide meaningful value. Not universally required, but materially improve the system for this specific use case.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Decision proxy peer** | Eliminates the main blocking point in fully autonomous runs: discuss-phase choices. No competing framework implements this — it's novel to this system's GSD integration. The proxy is a long-running peer primed with the user's decision-making preferences; orchestrator delegates choice points to it rather than blocking or defaulting. | Medium | Requires `discuss_choice` / `discuss_answer` message types. Timeout fallback to recommended default. Proxy peer is user-managed, not auto-spawned. |
| **Wave-scoped branch strategy** | Most frameworks use flat branches or per-worker branches. Single branch per wave (executors push after each task, rebase on conflict) simplifies merging and makes git log readable. After wave completion, orchestrator merges to main. | Medium | Requires executor git discipline (push per task, rebase-and-retry once). Documented in design-peer-autonomous.md. |
| **Partial-completion triage on reclaim** | When the orchestrator reclaims a dead executor's task, it checks git log to assess how much work was done. If more than 80% complete, finish locally rather than reassign from scratch. This saves significant time on large phases. No competing framework implements this heuristic. | Medium | Requires orchestrator to read git log and SUMMARY.md. Threshold is configurable. |
| **Dynamic wave insertion on conflict** | When two "independent" phases both touch the same file, instead of blocking, the orchestrator dynamically creates a synthetic wave N+0.5 to serialize them. This avoids replanning while preserving parallelism where possible. | Medium | Depends on `/conflict-check`. Orchestrator adjusts wave graph dynamically. |
| **`/peer-availability` single-call endpoint** | Currently, determining peer availability requires three separate calls (list-peers + session-status + wave-status). A single aggregated endpoint reduces orchestrator startup latency and simplifies the discovery step. | Low | New broker endpoint. Combines existing queries. Returns `available[]` and `busy[]` with current task context. |
| **Executor role self-advertisement via summary** | Executors and decision proxies advertise their role via `set_summary`. This is low-overhead and uses the existing summary field — no schema changes. The orchestrator filters by summary content to classify peers at discovery time. | Low | Relies on existing `set_summary` tool. Convention-based, not enforced. |
| **Post-wave git sync and state refresh** | After each wave completes, orchestrator does `git pull`, re-reads ROADMAP.md (catches dynamically inserted phases), updates STATE.md, and refreshes executor list. This tight sync loop prevents drift across long multi-wave runs. | Low | Standard git operations. Depends on executor push discipline. |

---

## Anti-Features

Features to explicitly NOT build for this milestone.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Modify core GSD workflows** | Project constraint: GSD must remain upgradeable. Any fork or modification creates a maintenance burden. | Wrap via `/gsd:autonomous-peers` or `--peers` flag. GSD stays untouched. |
| **Cross-machine peer discovery** | Network complexity (auth, TLS, latency, firewall) is disproportionate to value for a developer tool. Increases attack surface. | Localhost only. If users want cross-machine, they can tunnel. |
| **Persistent decision proxy memory** | Storing user preferences in the DB creates a privacy and staleness problem — preferences change per project. | Proxy is primed per-session by the user. Context lives in Claude's conversation history, not the DB. |
| **Web UI dashboard** | Significant frontend scope for marginal value. CLI and peer messaging cover all monitoring needs. | CLI (`bun cli.ts status`, `peers`, `stats`) is the dashboard. Invest in better CLI output instead. |
| **Executor spawning by orchestrator** | Auto-spawning Claude processes introduces process management complexity (auth, terminal allocation, context). Claude Code Agent Teams document this as a known hard problem. | Users pre-launch executor sessions. Orchestrator discovers them, not spawns them. |
| **Per-executor git branches** | More branches = more merge conflicts, harder to follow git history, harder to do post-wave sync. | Single branch per wave. Conflict-check prevents file overlap before dispatch. |
| **Nested orchestration (executor spawns sub-executors)** | Claude Code Agent Teams explicitly prohibit this ("no nested teams"). Adds exponential coordination complexity for unclear gain. | Flat hierarchy: one orchestrator, N executors. Decision proxy is a distinct role, not a sub-orchestrator. |
| **Plan approval gates during autonomous run** | Claude Code Agent Teams support plan approval gates, but this conflicts with the goal of fully autonomous execution. Adding human approval points defeats the purpose. | Use decision proxy for architectural choices. Human approval only for `human_action` checkpoints already in GSD plans. |
| **Predictive/ML resilience** | Galileo research identifies this as advanced differentiator territory, not table stakes. Overkill for a developer tool running on a single machine. | Simple timeout + reclaim + retry covers 95% of failure cases. |

---

## Feature Dependencies

```
/peer-availability endpoint
  → depends on: list-peers, session-status, wave-status (all exist)

discover_peers step (orchestrator)
  → depends on: /peer-availability (new)
  → depends on: set_summary convention for role advertisement (existing tool)

dependency_analysis step (orchestrator)
  → depends on: ROADMAP.md phase format (existing)
  → produces: wave graph for parallel_phase_loop

parallel_phase_loop (orchestrator)
  → depends on: wave-create, task-start, task-complete (all exist)
  → depends on: /conflict-check (exists)
  → depends on: /peer-availability (new)
  → depends on: send_message (exists)
  → depends on: poll-messages / ack-message (exists)

executor lifecycle (executor side)
  → depends on: poll-messages (exists)
  → depends on: send_message (exists)
  → depends on: /task-start, /task-complete, /task-blocked (all exist)
  → depends on: /conflict-check (exists)

decision proxy protocol
  → depends on: send_message + msg_type + payload (exists)
  → depends on: set_summary for role advertisement (exists)
  → requires: discuss_choice / discuss_answer message type convention (new, no schema change)

executor ACK + reclaim
  → depends on: status_request / status_response message types (new, no schema change)
  → depends on: reclaim_task message type (new, no schema change)
  → depends on: wave-status polling (exists)

partial completion triage
  → depends on: git log access (filesystem)
  → depends on: executor WIP commit convention (new behavior, no broker change)
```

---

## MVP Recommendation

For this milestone, implement in this order:

**Must Have (Wave 1 — unblock parallel execution):**
1. `/peer-availability` broker endpoint — enables the discover_peers step
2. Orchestrator wrapper with `discover_peers` + `dependency_analysis` — core enabling logic
3. `execute_phase` message dispatch + executor ACK protocol — task assignment
4. Executor lifecycle: setup, execute, `phase_complete`, `phase_blocked` — worker side
5. Wave status polling + task reclaim on executor death — keeps pipeline unblocked

**Should Have (Wave 2 — make it robust):**
6. Decision proxy protocol (`discuss_choice` / `discuss_answer`) — unblocks discuss-phase in autonomous mode
7. `phase_progress` heartbeat + `status_request` / `status_response` — liveness detection
8. Post-wave git sync + state refresh — prevents drift across waves
9. Dynamic wave insertion on file conflict — eliminates unnecessary serialization

**Defer:**
- Partial completion triage (>80% heuristic) — useful but adds orchestrator complexity; implement after basic reclaim works
- CLI enhancements for wave visibility — can use existing `bun cli.ts stats` initially

---

## Sources

- [Claude Code Agent Teams (official docs)](https://code.claude.com/docs/en/agent-teams) — HIGH confidence
- [Claude Code Subagents (official docs)](https://platform.claude.com/docs/en/agent-sdk/subagents) — HIGH confidence
- [Multi-Agent Orchestration Patterns in Production 2026 — Chanl Blog](https://www.chanl.ai/blog/multi-agent-orchestration-patterns-production-2026) — MEDIUM confidence (industry blog, verified against official sources)
- [Galileo: Multi-Agent AI Failure Recovery](https://galileo.ai/blog/multi-agent-ai-system-failure-recovery) — MEDIUM confidence
- [LangGraph vs CrewAI vs AutoGen 2026 — DEV Community](https://dev.to/pockit_tools/langgraph-vs-crewai-vs-autogen-the-complete-multi-agent-ai-orchestration-guide-for-2026-2d63) — LOW confidence (community post, used for pattern validation only)
- [CrewAI Documentation](https://docs.crewai.com) — HIGH confidence
- [LangGraph: Agent Orchestration Framework](https://www.langchain.com/langgraph) — HIGH confidence
- [Shipyard: Multi-agent orchestration for Claude Code in 2026](https://shipyard.build/blog/claude-code-multi-agent/) — MEDIUM confidence
- [AI Agent Delegation and Team Coordination Patterns — Zylos Research](https://zylos.ai/research/2026-03-08-ai-agent-delegation-team-coordination-patterns) — MEDIUM confidence
- design-peer-autonomous.md (project design, co-authored by peer Claude instances Sam and Mike) — HIGH confidence for project-specific decisions
