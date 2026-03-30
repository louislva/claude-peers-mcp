# Phase 02: Executor Protocol - Research

**Researched:** 2026-03-25
**Domain:** Autonomous peer executor agent for GSD phase execution
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
All implementation choices are at Claude's discretion — pure infrastructure phase. No locked decisions from the user.

### Claude's Discretion
- Executor agent file structure (single file vs modular)
- Message handler dispatch pattern (switch, map, class methods)
- Git operation error handling strategy
- Push jitter implementation (setTimeout, crypto random)
- How to intercept/enforce --no-transition (file guard, flag check, or wrapper)
- Whether to use server.ts MCP message handlers or a separate executor module
- Test structure for executor protocol flows

### Deferred Ideas (OUT OF SCOPE)
None
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| EXEC-01 | Executor peer acknowledges `execute_phase` within 15 seconds or task is reclaimed | ACK flow fully specified in design doc; send `status_response` with `status: "acknowledged"` immediately on message receipt |
| EXEC-02 | Executor runs git pull, reads plan file, validates via conflict-check before starting execution | Three-step setup sequence documented: git pull --rebase, read plan_path, POST /conflict-check; each has a specific blocked reason on failure |
| EXEC-03 | Executor sends `phase_progress` after each task completion with tasks_completed, tasks_total, last_commit | `PhaseProgressPayload` interface fully typed in shared/types.ts; send after each task, not on a timer |
| EXEC-04 | Executor sends `phase_complete` with verification result, commit list, and files_modified on completion | `PhaseCompletePayload` interface defined; verification is scoped phase-only check of PLAN.md success_criteria |
| EXEC-05 | Executor sends `phase_blocked` with categorized reason from seven defined literals | `BlockedReason` type and `PhaseBlockedPayload` interface in shared/types.ts; seven categories: git_conflict, file_conflict, plan_not_found, test_failure, dependency_missing, permission_denied, unknown |
| EXEC-06 | Executor responds to `status_request` immediately, interrupting current work | `StatusResponsePayload` interface defined; must be asynchronous interrupt to current work; channel push delivery ensures it arrives |
| EXEC-07 | Executor handles `reclaim_task` by committing WIP, pushing, and returning to idle | `ReclaimTaskPayload` interface defined; WIP commit message format: `"WIP: reclaimed by orchestrator — ${reason}"` |
| EXEC-08 | Executor uses push jitter (random 0-3s delay) to avoid git push collisions between parallel peers | Random delay before each `git push`; `Math.random() * 3000` ms using `setTimeout` or `await new Promise(r => setTimeout(r, jitter))` |
| EXEC-09 | Executor runs with `--no-transition` flag so it never modifies ROADMAP.md or STATE.md | Flag passed via `execute_phase` payload `flags` field; executor must guard writes to these specific files |
</phase_requirements>

---

## Summary

Phase 2 implements the executor agent — a peer that receives `execute_phase` messages from an orchestrator and runs a GSD phase plan on its behalf. The full protocol is already designed in `design-peer-autonomous.md` (Part 2, lines 344-500) and `design-peer-autonomous-executor.md`. All message payload types and broker endpoint signatures are implemented and verified in Phase 1.

The implementation domain is a new agent file (or agent files) in `gsd-plugin/agents/` that handles the executor lifecycle state machine: IDLE → ACK_RECEIVED → SETUP → EXECUTING → COMPLETING → IDLE. The agent dispatches on incoming message type (`execute_phase`, `status_request`, `reclaim_task`), calls broker endpoints (`/conflict-check`, `/task-start`, `/task-complete`, `/task-blocked`), runs git operations, and reports back to the orchestrator via `send_message`.

**Primary recommendation:** Implement the executor as a standalone agent document in `gsd-plugin/agents/gsd-executor.md` that Claude instances load and follow, with a companion TypeScript helper module for git operations and broker calls that can be imported directly. All type contracts are already in `shared/types.ts` — the executor consumes them, not defines them.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `bun:sqlite` | built-in | No direct use — broker handles all DB | Project mandates bun:sqlite; broker already uses it |
| `@modelcontextprotocol/sdk` | existing | MCP tool registration in server.ts | Already used by server.ts for all tools |
| `bun` built-in | current | `Bun.spawn` for git operations | Project mandates Bun over Node.js APIs |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `bun:test` | built-in | Integration tests for executor protocol flows | All new tests use `bun test` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `Bun.spawn` for git | `execa` | Project mandates `Bun.$` or `Bun.spawn`; no external dep needed |
| `Math.random()` for jitter | `crypto.getRandomValues()` | Math.random() is adequate for 0-3s push jitter; crypto random is overkill |
| Agent `.md` file | TypeScript class | Agent doc is consistent with `gsd-peer-coordinator.md` pattern; Claude reads it as instructions |

**Installation:** No new packages needed. All dependencies already installed.

---

## Architecture Patterns

### Recommended Project Structure

```
gsd-plugin/
├── agents/
│   ├── gsd-peer-coordinator.md    # Existing — read-only broker queries
│   └── gsd-executor.md            # NEW — full executor lifecycle agent doc
├── hooks/
│   └── gsd-peers-sync.js          # Existing — PostToolUse hook (unchanged)
└── CLAUDE.md.snippet              # Existing — unchanged
```

Optionally, for testable git/broker helpers:

```
gsd-plugin/
└── executor/
    └── executor-helpers.ts        # NEW (optional) — git ops + broker calls
```

### Pattern 1: Executor Agent Document

**What:** A markdown agent document in `gsd-plugin/agents/gsd-executor.md` that defines the executor's full lifecycle, state machine, message dispatch, and error handling as Claude instructions. Follows the pattern established by `gsd-peer-coordinator.md`.

**When to use:** When a Claude Code instance is designated as an executor peer. The instance loads the agent document and follows it.

**Example structure:**
```markdown
# GSD Executor Agent

You are an executor peer. When you receive an `execute_phase` message, follow this protocol exactly:

## State Machine
IDLE → ACK_RECEIVED → SETUP → EXECUTING → COMPLETING → IDLE

## Receiving execute_phase
...
```

### Pattern 2: Message Dispatch on msg_type

**What:** When the MCP channel delivers a message, the executor dispatches on `msg_type` from the parsed `payload` field. This is the core reactive pattern.

**When to use:** All incoming message handling.

**Example (from design doc):**
```typescript
// Source: design-peer-autonomous-executor.md
const payload = JSON.parse(message.payload);
switch (message.msg_type) {
  case "execute_phase":
    await handleExecutePhase(payload as ExecutePhasePayload);
    break;
  case "status_request":
    await handleStatusRequest(payload as StatusRequestPayload);
    break;
  case "reclaim_task":
    await handleReclaimTask(payload as ReclaimTaskPayload);
    break;
}
```

### Pattern 3: Broker HTTP Call Pattern

**What:** All broker calls follow the existing `brokerFetch` pattern from server.ts — fetch to localhost:7899 with JSON body.

**When to use:** Every executor→broker interaction.

**Example (from server.ts lines 45-56):**
```typescript
// Source: server.ts brokerFetch
async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}
```

### Pattern 4: Git Operations via Bun.spawn

**What:** Git pull, push, and commit operations use `Bun.spawn` for subprocess execution. Exit code 0 = success, non-zero = error.

**When to use:** All git operations in the executor setup and completion steps.

**Example:**
```typescript
// Source: server.ts getGitRoot pattern (lines 101-117)
const proc = Bun.spawn(["git", "pull", "--rebase", "origin", branch], {
  cwd: workingDir,
  stdout: "pipe",
  stderr: "pipe",
});
const code = await proc.exited;
if (code !== 0) {
  // send phase_blocked with reason: "git_conflict"
}
```

### Pattern 5: Push Jitter

**What:** Random delay before each `git push` to reduce collision probability between parallel executors on the same wave branch.

**When to use:** Before every `git push` in the executor.

**Example (from design doc):**
```typescript
// Source: design-peer-autonomous.md Part 3 branch strategy
const jitterMs = Math.random() * 3000; // 0-3 seconds
await new Promise((r) => setTimeout(r, jitterMs));
// then: git push
```

### Pattern 6: Push Conflict Recovery

**What:** If `git push` fails (non-fast-forward), executor performs `git pull --rebase` then retries push once. If second push fails, send `phase_blocked` with `reason: "git_conflict"`.

**When to use:** After every `git push` attempt.

### Pattern 7: --no-transition Guard

**What:** Before any file write, check if target path is `ROADMAP.md` or `STATE.md`. If yes, and if executor is running with `--no-transition` flag, skip the write and log it. This is enforced by the executor agent following instructions, not by a filesystem hook.

**When to use:** Every file modification during execution.

**Implementation approach:** The `flags` field in `ExecutePhasePayload` will contain `"--no-transition"`. The executor agent checks this flag before the execution loop begins and sets a module-level `noTransition = true` guard. When GSD's execute-phase would write STATE.md or ROADMAP.md, the executor skips those writes.

### Anti-Patterns to Avoid

- **Double-booking:** Executor must check if already executing before accepting `execute_phase`. If busy, send `phase_blocked` with `reason: "unknown"` and a clear detail message.
- **Message payload as command:** Never execute arbitrary commands from message payloads. Only read plan files from the filesystem (path traversal guard: plan_path must start with `.planning/phases/`).
- **Fire-and-forget git push:** Always await push result and handle non-zero exit codes. Never ignore push errors.
- **Status response delays:** `status_request` handling MUST interrupt current work. It cannot wait until the current task finishes — that would trigger the orchestrator's 30s death detection.
- **Blocking without notifying broker:** Always call `POST /task-blocked { task_id, reason }` in addition to sending `phase_blocked` message. Broker state and message state must be kept in sync.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Git operations | Shell escape, command builder | `Bun.spawn(["git", ...])` | Direct args array eliminates injection; already used in server.ts |
| Random jitter | Custom PRNG | `Math.random() * 3000` | Sufficient entropy for 0-3s delay; no crypto needed |
| HTTP broker calls | Raw `http.request` | `fetch` via `brokerFetch` pattern | Established pattern in server.ts; handles errors, JSON |
| Message serialization | Custom encoding | `JSON.stringify(payload)` | Broker API expects JSON string in `payload` field |
| Payload typing | Runtime validators | TypeScript type imports from `shared/types.ts` | All types verified and exported from Phase 1 |

**Key insight:** Every infrastructure component this phase needs is already built. Phase 2 is about wiring them together into a coherent state machine, not building new primitives.

---

## Common Pitfalls

### Pitfall 1: ACK Before Setup Completion
**What goes wrong:** Executor sends ACK then fails during setup (git pull, plan read, conflict check) without sending `phase_blocked`. Orchestrator thinks work is proceeding normally.
**Why it happens:** ACK is sent eagerly on message receipt, but error handling for setup steps is incomplete.
**How to avoid:** Each setup step MUST have an explicit failure path that sends `phase_blocked`. The design doc shows: `if rebase fails → send phase_blocked(git_conflict)`, `if plan missing → send phase_blocked(plan_not_found)`, `if conflicts → send phase_blocked(file_conflict)`.
**Warning signs:** Tests show orchestrator waiting indefinitely after executor receives `execute_phase`.

### Pitfall 2: Forgetting to call /task-blocked in Broker
**What goes wrong:** Executor sends `phase_blocked` message to orchestrator but forgets to call `POST /task-blocked { task_id }` on the broker. Wave never advances because the broker still shows the task as `running`.
**Why it happens:** Two separate calls needed for the same logical event — easy to miss one.
**How to avoid:** Always pair every `phase_blocked` message with `POST /task-blocked`. Template: send message first, then notify broker.
**Warning signs:** `/wave-status` shows tasks stuck in `running` after executor returns to IDLE.

### Pitfall 3: Forgetting to call /task-complete in Broker
**What goes wrong:** Executor sends `phase_complete` message but forgets `POST /task-complete { task_id }`. Orchestrator thinks the phase is done but the broker wave never auto-completes. The orchestrator's wave-status poll keeps seeing the task as running.
**Why it happens:** Same as above — two calls for one logical completion.
**How to avoid:** Always pair `phase_complete` message with `POST /task-complete`. The broker returns `{ ok: true, wave_completed: boolean }` — the executor can log this.

### Pitfall 4: Push Jitter Too Short or Skipped
**What goes wrong:** Two parallel executors both finish a task at the same time, both do `git push` simultaneously, one gets a non-fast-forward rejection, triggers `phase_blocked(git_conflict)` unnecessarily.
**Why it happens:** Jitter was implemented but with a too-small range, or push jitter only applied on retry (not initial push).
**How to avoid:** Apply jitter (0-3s) before EVERY push — both first attempt and retry. The design spec says "random 0-3s delay" (EXEC-08).

### Pitfall 5: path traversal in plan_path
**What goes wrong:** A malformed or malicious `execute_phase` message contains `plan_path: "../../.env"`. Executor reads and executes arbitrary files.
**Why it happens:** No validation on plan_path before filesystem read.
**How to avoid:** Validate that `plan_path` starts with `.planning/phases/` before reading. Reject with `phase_blocked(unknown)` if validation fails.
**Warning signs:** Executor reads files outside the expected directory.

### Pitfall 6: status_request Ignored During Long Task
**What goes wrong:** Executor is deeply into a task execution and doesn't process incoming `status_request` messages. After 30s the orchestrator marks it dead and reclaims.
**Why it happens:** The executor agent may not check for messages between tool calls. MCP channel push should interrupt, but only if the agent actively processes it.
**How to avoid:** The MCP server instructions already say "RESPOND IMMEDIATELY" to channel messages. The agent document must reinforce this for `status_request` specifically. Verify that the MCP channel push actually delivers messages during execution.

### Pitfall 7: State Mutation During Reclaim
**What goes wrong:** Executor receives `reclaim_task` but has partially modified files that weren't staged. WIP commit is empty or partial, leaving files in a dirty state.
**Why it happens:** Git add + git commit must be explicit about what to stage.
**How to avoid:** Use `git add -A` before the WIP commit to stage all changes, then commit with the standard WIP message.

---

## Code Examples

Verified patterns from design documents and existing source:

### ACK Immediately on execute_phase Receipt
```typescript
// Source: design-peer-autonomous-executor.md Step 1
async function sendAck(orchestratorId: PeerId, taskId: number, phaseNumber: number) {
  await brokerFetch("/send-message", {
    from_id: myId,
    to_id: orchestratorId,
    text: `Received phase ${phaseNumber}, starting setup`,
    msg_type: "status_response",
    payload: {
      task_id: taskId,
      status: "acknowledged",
      tasks_completed: 0,
      tasks_total: 0,
      current_task: "setup",
      last_activity: new Date().toISOString(),
    } satisfies StatusResponsePayload,
  });
}
```

### Git Pull with Rebase + Block on Failure
```typescript
// Source: design-peer-autonomous-executor.md Step 2
async function gitPullRebase(cwd: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  const proc = Bun.spawn(["git", "pull", "--rebase", "origin", branch], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    return { ok: false, error: stderr };
  }
  return { ok: true };
}
// Usage: if pull fails → send phase_blocked with reason "git_conflict"
```

### Conflict Check via Broker
```typescript
// Source: design-peer-autonomous-executor.md + broker.ts handleConflictCheck signature
const conflictResult = await brokerFetch<{ conflicts: Array<{ task_id: number; task_name: string; conflicting_files: string[] }> }>(
  "/conflict-check",
  { wave_id: waveId, files: planFiles }
);
if (conflictResult.conflicts.length > 0) {
  // send phase_blocked with reason "file_conflict"
}
```

### Progress Report After Each Task
```typescript
// Source: design-peer-autonomous-executor.md Step 4
async function sendProgress(
  orchestratorId: PeerId,
  payload: PhaseProgressPayload
) {
  await brokerFetch("/send-message", {
    from_id: myId,
    to_id: orchestratorId,
    text: `Task ${payload.tasks_completed}/${payload.tasks_total} complete`,
    msg_type: "phase_progress",
    payload,
  });
}
```

### Git Push with Jitter and One Retry
```typescript
// Source: design-peer-autonomous.md Part 3 branch strategy + EXEC-08
async function gitPushWithJitter(cwd: string, branch: string): Promise<{ ok: boolean }> {
  const jitterMs = Math.random() * 3000;
  await new Promise((r) => setTimeout(r, jitterMs));

  const push = () => Bun.spawn(["git", "push", "origin", branch], {
    cwd, stdout: "pipe", stderr: "pipe",
  });

  let proc = push();
  let code = await proc.exited;
  if (code === 0) return { ok: true };

  // Rebase and retry once
  const rebase = Bun.spawn(["git", "pull", "--rebase", "origin", branch], {
    cwd, stdout: "pipe", stderr: "pipe",
  });
  const rebaseCode = await rebase.exited;
  if (rebaseCode !== 0) return { ok: false };

  proc = push();
  code = await proc.exited;
  return { ok: code === 0 };
}
```

### Complete Phase Flow with Broker Notification
```typescript
// Source: design-peer-autonomous-executor.md Completion Protocol
async function completePhase(taskId: number, orchestratorId: PeerId, phasePayload: PhaseCompletePayload) {
  // 1. Push all commits (with jitter)
  await gitPushWithJitter(cwd, branch);

  // 2. Notify orchestrator
  await brokerFetch("/send-message", {
    from_id: myId,
    to_id: orchestratorId,
    text: `Phase ${phasePayload.phase_number} complete`,
    msg_type: "phase_complete",
    payload: phasePayload,
  });

  // 3. Notify broker (must happen — broker auto-completes wave when all tasks done)
  await brokerFetch("/task-complete", { task_id: taskId });

  // 4. Return to idle
  await brokerFetch("/set-summary", { id: myId, summary: `Idle — completed phase ${phasePayload.phase_number}, ready for next assignment` });
}
```

### WIP Commit on Reclaim
```typescript
// Source: design-peer-autonomous-executor.md Handling reclaim_task
async function handleReclaim(payload: ReclaimTaskPayload, orchestratorId: PeerId, cwd: string, branch: string) {
  // Stage all changes
  await Bun.spawn(["git", "add", "-A"], { cwd }).exited;

  // Commit WIP
  await Bun.spawn(
    ["git", "commit", "-m", `WIP: reclaimed by orchestrator — ${payload.reason}`, "--allow-empty"],
    { cwd }
  ).exited;

  // Push WIP
  await gitPushWithJitter(cwd, branch);

  // Get last commit SHA
  const logProc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe" });
  const lastCommit = (await new Response(logProc.stdout).text()).trim();

  // Acknowledge
  await brokerFetch("/send-message", {
    from_id: myId,
    to_id: orchestratorId,
    text: "Reclaim acknowledged, returning to idle",
    msg_type: "status_response",
    payload: { task_id: payload.task_id, status: "reclaimed", last_commit: lastCommit } as StatusResponsePayload,
  });
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Sequential autonomous (single peer) | Distributed executor protocol (multi-peer) | Phase 2 (this phase) | Parallel phase execution across Claude instances |
| Free-form blocked reason strings | Seven typed `BlockedReason` literals | Phase 1 (complete) | Orchestrator can programmatically route each failure |
| File conflict detection on declared files only | Expanded to include lock files + barrel indexes | Phase 1 (complete) | Catches implicit conflicts from parallel executors |

---

## Open Questions

1. **How does the executor agent handle being mid-task when a `status_request` arrives?**
   - What we know: MCP channel push delivers messages immediately. The CLAUDE.md instruction says "RESPOND IMMEDIATELY." The design doc says no response within 30s = assumed dead.
   - What's unclear: Claude's actual ability to interrupt a running subagent to respond. If the executor spawned a subagent for the task, the main agent loop may be blocked.
   - Recommendation: The executor agent should NOT spawn subagents for individual tasks. It should process tasks sequentially within the same agent context to preserve interrupt capability. Document this constraint explicitly in the agent file.

2. **What is the current git branch when the executor starts?**
   - What we know: The design doc mentions "wave branches" (e.g., `wave-1`), but the branch name is not included in `ExecutePhasePayload`.
   - What's unclear: Does the executor already have the wave branch checked out, or does it need to check it out? The payload has `flags` but not `branch`.
   - Recommendation: Executor should read the current branch via `git branch --show-current` and push to that branch. If orchestrator needs a specific branch, it should either include it in the payload or pre-checkout the executor. For v1, assume executor is already on the correct branch.

3. **What does "run phase plan" mean precisely for the executor?**
   - What we know: The design doc says "use `gsd:execute-phase` / `gsd-executor` logic." The executor agent reads PLAN.md.
   - What's unclear: Does the executor call the GSD `execute-phase` skill directly, or does it re-implement the task execution loop?
   - Recommendation: The executor agent should read the PLAN.md file, then execute each `<task>` element following the same conventions GSD's execute-plan workflow uses — reading `<action>`, running the steps, committing. This is effectively an inline re-implementation scoped to the executor's context.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `bun:test` (built-in) |
| Config file | none — bun auto-discovers `*.test.ts` |
| Quick run command | `bun test broker.test.ts` |
| Full suite command | `bun test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| EXEC-01 | ACK sent within 15s of `execute_phase` receipt | integration | `bun test executor.test.ts -t "ACK"` | ❌ Wave 0 |
| EXEC-02 | git pull + plan read + conflict-check before execution | integration | `bun test executor.test.ts -t "setup"` | ❌ Wave 0 |
| EXEC-03 | `phase_progress` sent after each task with correct fields | integration | `bun test executor.test.ts -t "progress"` | ❌ Wave 0 |
| EXEC-04 | `phase_complete` has verification result + commit list + files_modified | integration | `bun test executor.test.ts -t "complete"` | ❌ Wave 0 |
| EXEC-05 | `phase_blocked` uses one of seven BlockedReason literals | unit | `bun test executor.test.ts -t "blocked"` | ❌ Wave 0 |
| EXEC-06 | `status_request` response sent immediately | integration | `bun test executor.test.ts -t "status_request"` | ❌ Wave 0 |
| EXEC-07 | `reclaim_task` produces WIP commit + push + idle return | integration | `bun test executor.test.ts -t "reclaim"` | ❌ Wave 0 |
| EXEC-08 | Push jitter is 0-3000ms random delay | unit | `bun test executor.test.ts -t "jitter"` | ❌ Wave 0 |
| EXEC-09 | --no-transition prevents ROADMAP.md + STATE.md writes | unit | `bun test executor.test.ts -t "no-transition"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `bun test broker.test.ts` (existing suite must stay green)
- **Per wave merge:** `bun test` (full suite)
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `executor.test.ts` — all EXEC-01 through EXEC-09 unit + integration tests
- [ ] `gsd-plugin/executor/executor-helpers.ts` (if modular approach chosen) — git ops + broker calls

*(Existing `broker.test.ts` already covers broker-side endpoints. New tests cover the executor-side logic.)*

---

## Sources

### Primary (HIGH confidence)
- `design-peer-autonomous.md` (local) — Full executor protocol spec, Part 2 lines 344-500
- `design-peer-autonomous-executor.md` (local) — Executor-specific design, all sections
- `shared/types.ts` (local) — All payload interfaces, verified Phase 1 output
- `broker.ts` (local) — Broker endpoint signatures: `/conflict-check`, `/task-start`, `/task-complete`, `/task-blocked`
- `server.ts` (local) — `brokerFetch` pattern, `send_message` tool, channel push mechanism
- `gsd-plugin/agents/gsd-peer-coordinator.md` (local) — Agent document pattern to follow
- `gsd-plugin/hooks/gsd-peers-sync.js` (local) — PostToolUse hook, broker HTTP call patterns

### Secondary (MEDIUM confidence)
- `.planning/phases/01-foundation/01-VERIFICATION.md` (local) — Confirms all Phase 1 contracts are live

### Tertiary (LOW confidence)
- None

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all dependencies are in-repo with working code
- Architecture: HIGH — design documents are complete and authoritative; Phase 1 type contracts verified
- Pitfalls: HIGH — derived from design doc error recovery matrix + code inspection of existing patterns
- Open questions: MEDIUM — questions about runtime behavior (subagent interruption, branch management) cannot be verified statically

**Research date:** 2026-03-25
**Valid until:** Until design documents or Phase 1 contracts change (stable for this milestone)
