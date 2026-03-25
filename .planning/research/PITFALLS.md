# Domain Pitfalls

**Domain:** Peer-aware autonomous multi-agent orchestration layered on existing peer messaging system
**Researched:** 2026-03-25
**Focus:** Mistakes when ADDING autonomous orchestration to gsd-comms-mcp (existing wave/task/messaging primitives)

---

## Critical Pitfalls

Mistakes that cause rewrites, corrupted state, or complete pipeline failure.

---

### Pitfall 1: Parallel Executors on a Single Branch Without Worktree Isolation

**What goes wrong:**
The design calls for all executors in a wave to push to the same wave branch. When two executors push within seconds of each other, the second push is rejected (non-fast-forward). The executor rebases and retries — but if both executors modified overlapping files (even files not in their declared file list, like `package.json` lock files or auto-generated indexes), the rebase itself produces a conflict that an autonomous agent cannot resolve. The executor sends `phase_blocked (git_conflict)`, and if both executors hit this simultaneously, the entire wave stalls.

**Why it happens:**
The conflict-check compares declared file lists in `task_assignments.files`, but real execution produces side-effect writes. Lock file updates (`bun.lockb`, `package-lock.json`), barrel index regeneration (`index.ts`), `.planning/STATE.md` touches, and any file that two phases both import-and-modify will conflict even when the declared lists are disjoint.

**Consequences:**
Both tasks blocked, orchestrator in recovery loop, partial git state is unclear, context window burns on retry/diagnosis.

**Prevention:**
- Add side-effect file categories to conflict-check: always flag `*.lock`, `**/index.ts`, `package.json` as potential conflicts regardless of declared plan files.
- Use `git worktrees` per executor: each executor gets an isolated working directory pointing to the same `.git`. They work on separate branches and the orchestrator merges them. This is the community-established pattern for parallel agents (HIGH confidence, per current 2026 practice).
- If single-branch is kept, implement exponential backoff with jitter on push retry (not just one rebase attempt) and treat repeated push failures as a signal to serialize that task.

**Detection:**
`phase_blocked` with reason `git_conflict` from two tasks in the same wave within 60 seconds of each other. Also: watch for `bun.lockb` appearing in multiple task file lists at planning time.

**Phase:** Executor protocol implementation (Phase where `execute_phase` message handling is built)

---

### Pitfall 2: Stale Peer Detection via PID Is Insufficient for Stuck Agents

**What goes wrong:**
The broker's `cleanStalePeers()` uses `process.kill(pid, 0)` to verify liveness. A Claude Code instance that is alive (PID exists) but has entered a stuck state — waiting for a tool permission prompt, looping on the same tool call, or burning its context window — registers as healthy. The orchestrator polls `/wave-status` and sees the task is `running`, with a live peer, so it waits indefinitely.

Real stuck states include:
- Agent waiting for a `bash` permission dialog it cannot dismiss in autonomous mode
- Agent in a reasoning loop calling the same read tool repeatedly without progress
- Agent's context window nearing exhaustion causing increasingly degraded outputs that still produce commits but accomplish nothing

**Why it happens:**
PID liveness is a necessary but not sufficient liveness signal. There is no heartbeat on progress, only on peer existence. The 120-second `status_request` timeout in the design is a step in the right direction but does not distinguish a genuinely active agent from one that responds to `status_request` but is looping.

**Consequences:**
Wave stalls. Orchestrator waits 120s, sends `status_request`, gets a plausible response ("on task 2 of 5"), waits another 120s, gets the same response, never declares the executor dead. Pipeline freezes with no human intervention hook.

**Prevention:**
- Require progress monotonicity: if `tasks_completed` in consecutive `status_response` messages is identical after two cycles, treat the executor as stuck regardless of PID liveness.
- Track `last_commit` SHA in `status_response`. If the SHA has not changed for two status cycles (240 seconds total), trigger reclaim.
- Set a hard wall-clock timeout per task based on estimated complexity (e.g., `max_minutes` field in the task assignment). Orchestrator reclaims at deadline regardless of progress reports.
- Log a warning and notify the user when an executor is reclaimed due to stuck detection, not just dead-peer detection.

**Detection:**
Two consecutive `status_response` messages with identical `tasks_completed` and `last_commit`. Wall-clock time since `started_at` exceeds the task's expected duration.

**Phase:** Orchestrator monitoring loop / executor death handling

---

### Pitfall 3: Decision Proxy as Single Point of Failure in Autonomous Mode

**What goes wrong:**
The design delegates all `discuss-phase` choices to a designated decision proxy peer. If that peer crashes, loses its session, or simply gives poor answers due to shallow context, the consequences are asymmetric: an upstream bad decision in Phase 1's planning propagates into every downstream phase that was planned against it. Unlike a failed executor (work can be reclaimed and restarted), a bad proxy decision produces corrupted plans that look correct but are architecturally wrong.

Failure modes:
1. **Proxy dies mid-run**: Orchestrator falls back to recommended defaults. Fine if the fallback is good, but the fallback is the LLM's own default — which may contradict preferences the user expressed to the proxy.
2. **Proxy gives inconsistent answers**: No state machine prevents the proxy from contradicting itself across phases (e.g., "use REST" in Phase 1, "use GraphQL" in Phase 3 when asked about an API that feeds into Phase 3).
3. **Proxy context degrades**: A proxy session that has handled 20+ discuss-choice queries during a long run may have accumulated enough context to start producing answers that diverge from the user's expressed preferences, particularly if the proxy's context window is large but the key preference statements were made early in the conversation ("lost in the middle" effect).

**Why it happens:**
The proxy is a stateless message-response peer with no persistence of its own decision history. Each `discuss_choice` is answered independently. The design acknowledges "persistent decision proxy memory" is out of scope.

**Consequences:**
Architectural mismatch between phases. Expensive replanning mid-wave. Worse: silent bad decisions that complete execution and only fail at integration/testing phases.

**Prevention:**
- Include prior decisions in each `discuss_choice` payload: `"prior_decisions": [{"phase": 1, "question": "...", "answer": "REST"}]`. This keeps the proxy consistent even if its context has grown.
- Implement a decision log file (`.planning/DECISIONS.md`) written by the orchestrator after each proxy response. This serves as audit trail and re-priming context.
- Add decision validation: if two proxy answers in the same wave contradict a detectable invariant (e.g., different database technologies for phases in the same service), warn the orchestrator before continuing.
- Set proxy timeout to 30s (design says 60s — this is too long for something that should be near-instant for a primed LLM).
- Do NOT make the proxy responsible for high-stakes architectural decisions in unattended runs. If the orchestrator detects a choice that affects more than two downstream phases, escalate to the user rather than delegating to the proxy.

**Detection:**
Contradictions between `prior_decisions` and the new `discuss_answer`. Proxy response time exceeding 45 seconds (proxy may be processing too much context).

**Phase:** Decision proxy protocol implementation

---

### Pitfall 4: Dependency Graph Cycles from Inferred Dependencies

**What goes wrong:**
The orchestrator builds a dependency graph by parsing ROADMAP.md and inferring implicit dependencies ("DB schema phases must complete before phases that query those tables"). LLM-based inference is not guaranteed to produce a DAG. If the inference generates a cycle (Phase 3 depends on Phase 4, Phase 4 depends on Phase 3), the wave-grouping algorithm enters an infinite loop or produces an empty wave. This is particularly likely for:
- Phases with circular descriptions ("the auth service that uses the user model, and the user model that references auth roles")
- Phases where the LLM infers "A uses B" and also "B uses A" from different parts of ROADMAP.md
- Dynamically added phases (inserted mid-run) that reference phases already in a running wave

**Why it happens:**
The dependency analysis step uses heuristic inference ("infer implicit dependencies: DB schema phases must complete before phases that query those tables"). Unlike a deterministic build system's explicit dep declarations, LLM inference has no correctness guarantee. Cycle detection is not mentioned in the design.

**Consequences:**
Wave grouping produces empty waves, pipeline stalls before execution even begins, or worse: the orchestrator silently drops phases that appear in a cycle (if the wave algorithm fails open instead of fail closed).

**Prevention:**
- Run explicit cycle detection (DFS or Kahn's algorithm) on the inferred dependency graph before constructing waves. If a cycle is found, fail loudly and present the cycle to the user for manual resolution rather than proceeding with a wrong graph.
- Prefer explicit dep declarations in ROADMAP.md (a structured format the planner produces) over purely inferred deps. Implicit inference is a fallback, not the primary source.
- For dynamically inserted phases, validate that the new phase does not introduce a cycle before inserting it into the graph.
- Limit inference depth: if a transitive dependency chain exceeds N hops (e.g., 5), flag it for human review rather than trusting the inference.

**Detection:**
Wave-grouping algorithm produces zero tasks in a wave but pending tasks remain. Topological sort produces nodes with non-zero in-degree after all "no dependency" nodes are removed.

**Phase:** Dependency analysis step (before phase loop)

---

### Pitfall 5: Partial Wave Failure Blocking Subsequent Waves Indefinitely

**What goes wrong:**
If one task in a wave fails and enters `blocked` status, the orchestrator's "wait for wave completion" poll loop checks whether all tasks are `completed`. A `blocked` task is not `completed`, so the wave never advances. If the orchestrator's recovery logic (reassign, serialize, retry) also fails or times out, the entire pipeline stops.

The current `taskCompleteTxn` only sets wave status to `completed` when `status NOT IN ('completed', 'failed')` reaches zero — but `blocked` is neither. A task stuck in `blocked` forever means the wave never completes.

**Why it happens:**
The task state machine has four states: `pending`, `running`, `blocked`, `completed`. There is no `failed` state that signals "give up and advance". The design says "never block the whole pipeline on one dead peer" but the implementation path from `blocked` to wave advancement is not fully specified.

**Consequences:**
A single unrecoverable task (e.g., a phase that requires a file that genuinely doesn't exist) freezes the entire downstream dependency chain. All subsequent waves cannot execute. The user must manually intervene even in supposedly unattended mode.

**Prevention:**
- Add a `failed` terminal state to `task_assignments`. After N retries (suggest: 2), transition `blocked` → `failed`.
- In `taskCompleteTxn`, treat `failed` alongside `completed` as a terminal state that counts toward wave completion.
- Orchestrator should have a policy per failure reason: `plan_not_found` → `failed` immediately (no retry will help until replanned); `git_conflict` → retry up to 2 times; `test_failure` → retry once then `failed`.
- When a wave completes with failed tasks, log a warning and continue to the next wave if the failed task's outputs are not depended on by downstream phases. If they are, escalate to the user.
- Add a maximum wave age (e.g., 30 minutes). If a wave has not completed within this period, force-fail all running/blocked tasks and advance.

**Detection:**
Wave age in `waves.created_at` vs current time. Tasks with `status = 'blocked'` and `started_at` more than 2x the expected task duration.

**Phase:** Orchestrator monitoring loop + broker task state machine

---

## Moderate Pitfalls

---

### Pitfall 6: Message Ordering and Duplicate Delivery Issues

**What goes wrong:**
The broker's poll-then-ACK model means messages are delivered at-least-once. If the executor crashes between receiving `execute_phase` and sending the ACK, the orchestrator never marks the message delivered. On recovery, the orchestrator may resend `execute_phase` to the same (restarted) executor or a new executor — potentially causing a duplicate execution of a phase that was partially completed.

Additionally, if `phase_complete` is received by the orchestrator before the executor's final `git push` has propagated to the remote (network lag or push failure), the orchestrator proceeds to `git pull` for post-wave sync and finds the commits missing.

**Why it happens:**
ACK-based messaging provides delivery ordering within a peer's message queue but does not enforce causal ordering between message delivery and external side effects (git pushes). The executor protocol says "push, then send completion" — but if push fails after the completion message is sent, the orchestrator has a phantom completion.

**Prevention:**
- Treat `phase_complete` as provisional. Orchestrator verifies commits listed in `phase_complete.payload.commits` are visible on the remote before marking the task complete in the broker.
- Executors must include the final push result (success/failure) in the `phase_complete` message. If push failed, send `phase_blocked (git_conflict)` instead of `phase_complete`.
- Add idempotency guard in executor: check if a wave task is already in `running` or `completed` state before re-executing. If already `running` and assigned to this session, this is a re-delivery — skip and re-send the original `phase_complete`.
- For `execute_phase` messages, executors should immediately ACK the message (step 1 of the protocol) before beginning work. This prevents re-delivery to the same executor but does not prevent re-delivery if the executor died before ACKing.

**Detection:**
Duplicate `phase_complete` messages for the same `task_id`. Git log showing commits from a previous executor session arriving after a new executor starts on the same task.

**Phase:** Executor protocol implementation + orchestrator completion handling

---

### Pitfall 7: Context Window Exhaustion in the Orchestrator Session

**What goes wrong:**
The orchestrator is a long-running Claude Code session. It runs discuss-phase, plan-phase, monitors multiple executors, handles recovery, does post-wave sync, and repeats for each wave. In a project with 10+ phases and 3 waves, the orchestrator session accumulates:
- All phase planning outputs
- All executor status messages
- All recovery dialogues
- ROADMAP.md and STATE.md re-reads after each wave

Research (2025-2026) shows that at 100K+ tokens, models begin "lost in the middle" degradation: key decisions made early in context (which phase depends on what, what the user's architectural preferences were) are less reliably recalled. At 200K+ tokens, agents show a tendency to repeat earlier patterns rather than synthesizing new plans.

**Why it happens:**
An orchestrator that does not externalize its working state depends on the LLM's context window to remember what has been decided. A project with 15 phases, each with a 3K token plan, plus monitoring traffic, exceeds 100K tokens well before completion.

**Prevention:**
- Filesystem-first state: write decisions, wave graphs, and executor assignments to files (`.planning/waves/wave-N.json`) and re-read them rather than keeping them in context.
- Summarize completed waves in a structured file after each wave completes. The orchestrator's context should contain a summary, not full history.
- Set a context budget alert: if the orchestrator detects its session has processed more than 80K tokens (estimable from turn count × average), save full state to disk, instruct the user to start a fresh session that re-reads the state files, and continue.
- Cap the amount of per-message logging in the monitoring loop. Status poll responses should be structured (JSON to a file) rather than narrated into the chat context.

**Detection:**
Orchestrator starts re-planning phases that were already planned. Orchestrator forgets executor assignments it made earlier. Planning outputs begin contradicting earlier wave outputs.

**Phase:** Orchestrator workflow design (affects all phases of development)

---

### Pitfall 8: Security — Agent-to-Agent Instruction Injection

**What goes wrong:**
Executors receive `execute_phase` messages and are instructed to read plan files from the filesystem. The security section of the design says "executors validate `execute_phase` messages come from a known orchestrator peer" and "plan path must be within the project directory." However:

1. **Peer identity is not authenticated.** Peer IDs are 8-character random strings. Any process that knows a valid peer ID can send a message that appears to be from the orchestrator.
2. **Plan files could contain injected instructions.** If a plan file at the specified path contains injected content (e.g., from a prior phase that wrote to a file that was later used as a plan path), the executor will follow those instructions with full tool permissions.
3. **Path traversal in plan_path.** The design says "must be within the project directory" but this must be enforced code, not documentation. Without enforcement, `"plan_path": "../../.env"` would cause the executor to read sensitive files.

Research confirms: 100% of multi-agent LLM systems tested were vulnerable to inter-agent trust exploits (OWASP 2025 Top 10: LLM01 is prompt injection, appearing in 73% of production AI deployments).

**Why it happens:**
The messaging system is a local broker, which reduces external attack surface but does not eliminate trust issues from compromised or misconfigured sessions sharing the same machine. Claude Code itself has broad filesystem and shell access — a misdirected executor can cause significant unintended changes.

**Prevention:**
- Validate `plan_path` against an allowlist of expected paths at plan time. Store expected paths in the wave/task record in the broker when the orchestrator creates the task. Executor validates that `plan_path` from the message matches the broker record.
- Implement simple source verification: executors check `from_id` in the message payload against the known orchestrator peer ID (stored when the executor registers for a wave). Reject `execute_phase` from any other peer.
- Validate plan file content is structured PLAN.md format before executing (not a security guarantee but a sanity check against accidentally processed files).
- Path traversal: normalize and assert that `realpath(plan_path)` starts with `git_root`.

**Detection:**
`execute_phase` message with `from_id` not matching the registered orchestrator for the wave. `plan_path` containing `..` segments or pointing outside the git root.

**Phase:** Executor protocol implementation (security validation step)

---

### Pitfall 9: Git Rebase Retry Loop Producing Divergent History

**What goes wrong:**
The executor protocol specifies: "git pull --rebase origin <branch> — if rebase fails, send `phase_blocked (git_conflict)`." The design also says executors push after each task commit. If executor A and executor B are both on the same wave branch and both push commit X simultaneously, one succeeds and one gets rejected. The rejected executor rebases, incorporating the other's commits. This is correct.

However, if the rebase modifies files the executor's own commits touched (not a conflict, just a reorder), the rebase changes the executor's commit SHAs. If the executor then pushes and another executor has also pushed in the same window, the second rebase will rewrite SHAs again. Under sustained contention with 3+ executors, this SHA-churn can produce a history that is technically correct but where `last_commit` fields in `phase_progress` messages become stale references, causing the orchestrator to misinterpret task state.

**Prevention:**
- Add push jitter: randomize the delay between task-completion commit and push (0–5 seconds). This reduces simultaneous push probability dramatically.
- Use `git push --force-with-lease` instead of `git push` for executor branches. This fails if the remote has moved beyond what the executor last fetched, making the failure explicit rather than silent.
- The orchestrator should verify commits by content (check that key files in `files_modified` exist and have the expected content) not just by SHA presence.

**Detection:**
Orchestrator `git log` shows SHAs from `phase_complete` messages that do not appear in remote history after pull. Multiple `phase_blocked (git_conflict)` events from the same executor within a single task.

**Phase:** Executor protocol / branch strategy implementation

---

## Minor Pitfalls

---

### Pitfall 10: Executor Availability Snapshot Goes Stale Between Dispatch and Execution

**What goes wrong:**
The orchestrator calls `list_peers` (or the planned `/peer-availability`), gets a list of idle executors, and dispatches tasks to them. Between the list call and the `send_message` delivery, an executor may have received a different task from a different orchestrator, or its Claude Code session may have been interrupted by the user. The executor receives `execute_phase` but is no longer idle, causing it to reject with "already executing" or start executing a conflicting task.

**Prevention:**
- Executors must reject `execute_phase` if they have an active task (design already mentions this). Ensure the rejection generates a `phase_blocked` or explicit decline message back to the orchestrator so it can reassign immediately rather than waiting for a timeout.
- Add a minimum freshness check: the orchestrator only dispatches to peers whose `last_seen` timestamp is less than 30 seconds old at dispatch time.

**Phase:** Orchestrator dispatch logic

---

### Pitfall 11: `--no-transition` Flag Causing STATE.md Drift

**What goes wrong:**
Executors run with `--no-transition` so they do not update ROADMAP.md or STATE.md. This is correct — the orchestrator owns global state. However, if the orchestrator crashes mid-wave and a new orchestrator session is started, it reads STATE.md to determine which phases are complete. Phases executed by executors that completed successfully but whose STATE.md entries were never written (because the original orchestrator crashed before post-wave sync) will be re-executed in the recovery session.

**Prevention:**
- Orchestrator writes STATE.md atomically at wave completion, not at session end. Use a wave-completion file (`.planning/waves/wave-N-complete.json`) as an intermediate checkpoint that a recovery orchestrator can use to skip re-execution.
- Before executing a phase, executors check whether a phase result already exists (VERIFICATION.md for that phase) and skip if found.

**Phase:** Post-wave sync + orchestrator state management

---

### Pitfall 12: Decision Proxy Not Deregistering Gracefully

**What goes wrong:**
The decision proxy is designed to stay alive throughout the entire autonomous run. If the user closes the proxy's terminal session without explicitly calling `session-end`, the broker keeps the proxy peer record alive until the next `cleanStalePeers` pass (every 30 seconds). During this window, the orchestrator may send `discuss_choice` messages to the proxy, they sit undelivered, and the 60-second timeout fires — causing the orchestrator to fall back to defaults silently without logging that the proxy became unavailable.

**Prevention:**
- Proxy should set its summary to indicate when it receives each `discuss_choice` and when it responds. This makes proxy liveness visible in `list_peers` output.
- Orchestrator should proactively check proxy liveness (via `list_peers`, checking PID) before each `discuss_choice`, not just on timeout. If proxy is dead, log explicitly and continue with defaults.

**Phase:** Decision proxy integration

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Executor protocol — git setup | Concurrent push conflicts (Pitfall 1) | Implement push jitter + worktree option + expanded conflict-check |
| Orchestrator monitoring loop | Stuck agent not detected via PID alone (Pitfall 2) | Progress monotonicity check on consecutive status_response |
| Decision proxy implementation | Bad decisions cascading into downstream plans (Pitfall 3) | Include prior_decisions in each query; decision log file |
| Dependency analysis | Cycle in inferred graph (Pitfall 4) | Mandatory cycle detection (DFS) before wave construction |
| Wave state machine | Blocked task freezing entire pipeline (Pitfall 5) | Add `failed` terminal state; max wave age timeout |
| Message delivery | Phantom completion before git push lands (Pitfall 6) | Orchestrator verifies commits on remote before marking complete |
| Long autonomous runs | Orchestrator context window degradation (Pitfall 7) | Filesystem-first state; context budget monitoring |
| Executor security | Plan path injection / peer impersonation (Pitfall 8) | Validate plan_path vs broker record; verify from_id |
| Branch strategy | SHA-churn under push contention (Pitfall 9) | Push jitter + force-with-lease |
| Dispatch timing | Executor no longer idle at task receipt (Pitfall 10) | Explicit rejection message; 30s freshness check |
| Orchestrator crash recovery | STATE.md drift from --no-transition executors (Pitfall 11) | Wave-completion checkpoint files |

---

## Integration-Specific Warnings

These pitfalls arise specifically from layering on top of existing gsd-comms-mcp, not from building from scratch.

### Existing Conflict-Check Is File-List-Only

The broker's `/conflict-check` and `taskStartTxn` compare `task_assignments.files` arrays. These are set at wave-create time from plan files. Real execution frequently creates side-effect writes not in the declared list. The new layer must expand this to include lock files and generated files, or accept that the existing check is not sufficient alone.

### Wave Create Is Idempotent but Task Reassignment Is Not

`waveCreateTxn` is idempotent (returns existing wave if key matches). But if an executor crashes and the orchestrator resets a task to `pending` and reassigns it, there is no idempotency guard on that reassignment. A recovered executor that comes back online may find its task already assigned to a new executor, but nothing prevents it from calling `/task-start` again if it retained the `task_id`. The new layer needs a session-level ownership check at task-start time.

### Session-End Cascades Delete All Messages

`sessionEndTxn` deletes all messages `FROM` or `TO` the peer. If the orchestrator calls `/session-end` for a completed executor before polling its final `phase_complete` message, that message is gone. The orchestrator should ACK all pending messages before calling session-end for any peer.

---

## Sources

- [Why Do Multi-Agent LLM Systems Fail? (MAST taxonomy)](https://arxiv.org/pdf/2503.13657) — MEDIUM confidence, peer-reviewed research
- [How to Leverage Git Trees for Parallel Agent Workflows](https://elchemista.com/en/post/how-to-leverage-git-trees-for-parallel-agent-workflows) — MEDIUM confidence
- [Context Window Overflow in 2026 — Redis Blog](https://redis.io/blog/context-window-overflow/) — MEDIUM confidence
- [How Long Contexts Fail — dbreunig.com](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html) — MEDIUM confidence
- [OWASP LLM Top 10 2025 — Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) — HIGH confidence
- [Multi-Agent AI Failure Recovery — Galileo](https://galileo.ai/blog/multi-agent-ai-system-failure-recovery) — MEDIUM confidence
- [Agentic AI Security: Threats, Defenses, Evaluation](https://arxiv.org/html/2510.23883v1) — MEDIUM confidence
- [Claude Code issue: agent stuck in working state](https://github.com/anthropics/claude-code/issues/20430) — HIGH confidence (direct source)
- [Claude Code issue: unattended/fail-fast mode](https://github.com/anthropics/claude-code/issues/27172) — HIGH confidence (direct source)
- [Error handling in distributed systems — Temporal](https://temporal.io/blog/error-handling-in-distributed-systems) — MEDIUM confidence
- broker.ts source code analysis — HIGH confidence (direct inspection of existing race condition handling)
- design-peer-autonomous.md — HIGH confidence (primary design document)
