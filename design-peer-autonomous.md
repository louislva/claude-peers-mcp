# Peer-Aware /gsd:autonomous — Design Document

> Co-authored by **Sam** (orchestrator design) and **Mike** (executor protocol) via gsd-comms-mcp peer collaboration.

---

## Problem

`/gsd:autonomous` runs discuss→plan→execute per phase **sequentially in a single session**. Even though `execute-phase` can parallelize tasks within a phase via subagents, the phases themselves are serial. With gsd-comms-mcp, we have multiple Claude instances that could execute independent phases concurrently — but the autonomous loop doesn't know they exist.

## Scope & Integration

**GSD stays untouched.** This is a separate layer that wraps the existing autonomous loop:

- gsd-comms-mcp = standalone MCP server (this repo)
- Peer-aware autonomous = new workflow (`/gsd:autonomous-peers`) or `--peers` flag on existing `/gsd:autonomous`
- GSD plugin (gsd-plugin/) = optional bridge between the two
- No modifications to core GSD workflows, agents, or tools

## Design Principles

### One Planner, Many Executors

The orchestrator session owns the planning pipeline. Peer sessions are executors. This avoids:
- Two peers planning conflicting approaches for related phases
- Race conditions on ROADMAP.md / STATE.md updates
- Dependency violations between phases

### Decision Proxy Peer

During `/gsd:discuss-phase`, the orchestrator normally pauses for the user to choose between recommended options (e.g., "Use REST or GraphQL?", "Include auth in this phase or defer?"). In fully autonomous mode, this blocks progress.

**Solution:** Designate one peer as the **decision proxy** — a Claude instance that has deep context about the user's decision-making patterns, project preferences, and architectural thinking. When the orchestrator hits a discussion choice point, instead of asking the user, it messages the decision proxy peer to choose on their behalf.

**Why a dedicated peer, not the orchestrator itself:**
- The decision proxy can be a long-running session that has accumulated conversation context with the user across multiple interactions
- It can have access to memory files, past decisions, and user preference patterns
- It separates "planning/coordinating" concerns from "understanding the user" concerns
- The user can prime this peer with their thinking before kicking off the autonomous run

```
User primes decision proxy:
  "I prefer simple REST over GraphQL, always defer auth to later phases,
   choose the approach with fewer dependencies, prioritize shipping speed
   over extensibility for this project"

Orchestrator hits discuss-phase choice:
  → messages decision proxy: "Phase 3 discuss: REST vs GraphQL for the API?"
  ← decision proxy responds: "REST — user prefers simplicity and fewer deps"
  → orchestrator continues with REST, no user interruption
```

```
Orchestrator (Sam)                    Executor Peers (Mike, etc.)
─────────────────                     ──────────────────────────
discover peers
analyze phase dependencies
  │
  ├── Phase 1 (no deps) ──────────── → Mike: execute phase 1
  │      │
  ├── Phase 2 (no deps) ──────────── → [another peer or self]
  │      │                                    │
  │   [wait for both]  ←──────────── ← completion signals
  │      │
  ├── Phase 3 (depends on 1+2) ───── → execute locally or delegate
  │      │
  └── Phase 4 (depends on 3) ─────── → execute locally or delegate
```

---

## Part 1: Orchestrator Design (Sam)

### New Step: `discover_peers` (after init, before phase loop)

```
<step name="discover_peers" priority="after_init">
Call list_peers with scope "machine" (or "repo" for tighter scoping).

Filter for peers that:
- Are NOT the current session (exclude own ID)
- Have status indicating availability (summary doesn't contain active phase work)
- Are in the same repo OR are idle sessions willing to help

Classify peers by role:
- decision_proxy: Peer whose summary contains "decision proxy" or was designated
  by the user. At most one. This peer answers discussion-phase choices on
  behalf of the user.
- executor: All other available peers. These run phase plans.

Store as:
  decision_proxy = peer or null
  available_executors[] = remaining peers

If no executors found AND no decision proxy:
  → Fall back to standard sequential autonomous (no change from today)

If executors or decision proxy found:
  → Log: "Found {N} executor peers, decision proxy: {yes/no}. Enabling parallel phase execution."
  → Continue to dependency_analysis
</step>
```

### New Step: `discuss_via_proxy` (replaces user prompts in discuss-phase)

```
<step name="discuss_via_proxy" condition="decision_proxy is set">
When the orchestrator runs smart discuss for a phase and encounters a
choice point that would normally prompt the user:

1. Format the question with full context:
   send_message(decision_proxy.peer_id, {
     msg_type: "discuss_choice",
     payload: {
       phase_number: N,
       phase_goal: "description from ROADMAP.md",
       question: "the actual choice being presented",
       options: ["Option A: ...", "Option B: ...", "Option C: ..."],
       recommended: "Option B",
       context: "relevant context about why this choice matters"
     }
   })

2. Wait for response (timeout: 60s):
   The decision proxy responds with:
   {
     msg_type: "discuss_answer",
     payload: {
       phase_number: N,
       chosen: "Option B",
       reasoning: "User prefers X because Y, consistent with past decisions on Z"
     }
   }

3. If response received:
   → Use the chosen option, log the reasoning
   → Continue planning with this choice

4. If timeout or no decision proxy:
   → Use the recommended default (same as --auto behavior today)
   → Log: "Decision proxy unavailable, used recommended default"

The decision proxy is NOT an executor — it stays available throughout
the entire autonomous run to answer questions as they arise. It should
be a session the user has primed with their preferences and context.
</step>
```

**How the user sets up a decision proxy:**

Before kicking off the autonomous run, start a Claude session and tell it:

```
You are my decision proxy for autonomous GSD runs. Here's how I think:
- [project-specific preferences]
- [architectural biases]
- [risk tolerance]
- [shipping priorities]

Set your summary to "decision proxy" so the orchestrator can find you.
```

The proxy peer then calls `set_summary("Decision proxy — answering discuss-phase choices for autonomous runs")` and waits for incoming questions.

### New Step: `dependency_analysis` (before phase loop)

```
<step name="dependency_analysis">
Read ROADMAP.md and extract all phase definitions.

Build a dependency graph:
- Parse each phase for explicit dependencies (e.g., "depends on phase 1")
- Infer implicit dependencies:
  - DB schema phases must complete before phases that query those tables
  - API phases must complete before frontend phases that consume them
  - Shared library phases must complete before consumer phases
- Use file overlap heuristics from plan files (if plans exist) to detect conflicts

Group phases into execution waves:
- Wave 1: All phases with no dependencies (can run in parallel)
- Wave 2: Phases that depend only on Wave 1 phases
- Wave N: Phases that depend only on completed waves

Example:
  Wave 1: [Phase 1 (DB schema), Phase 2 (Auth library)]
  Wave 2: [Phase 3 (API endpoints — depends on 1+2), Phase 4 (CLI tool — depends on 2)]
  Wave 3: [Phase 5 (Frontend — depends on 3)]
</step>
```

### Modified Step: Parallel Phase Loop

```
<step name="parallel_phase_loop">
For each wave in execution_waves:

  1. PLAN ALL PHASES IN THIS WAVE (sequential — orchestrator only)
     For each phase in wave:
       - Run smart discuss (if no CONTEXT.md)
       - Run plan-phase via Skill()
       - Produce PLAN.md
     Planning stays sequential because:
       - It's fast (mostly LLM reasoning, not file edits)
       - It needs the orchestrator's full context of prior phases
       - Plans may need to reference outputs from earlier waves

  2. EXECUTE ALL PHASES IN THIS WAVE (parallel — distributed to peers)
     Create a broker wave:
       POST /wave-create {
         repo: git_root,
         phase: wave_number,
         wave_number: wave_number,
         tasks: phases.map(p => ({
           name: "phase-{p.number}",
           files: p.plan.expected_files
         }))
       }

     For each phase in wave:
       IF available_executors.length > 0:
         executor = available_executors.shift()
         POST /task-start { task_id, session_id: executor.session_id }
         send_message(executor.peer_id, {
           msg_type: "execute_phase",
           payload: {
             phase_number: p.number,
             plan_path: ".planning/phases/phase-{p.number}/PLAN.md",
             flags: "--no-transition --auto",
             wave_id: wave_id,
             task_id: task_id,
             orchestrator_id: self.peer_id
           }
         })
       ELSE:
         Execute locally via Skill("gsd:execute-phase")

  3. WAIT FOR WAVE COMPLETION
     Poll /wave-status every 10 seconds.

     For each task status change:
       - "completed" →
           POST /task-complete { task_id }
           Return executor to available_executors[]
           Read VERIFICATION.md for that phase
           If verification failed → handle inline (retry or skip)

       - "blocked" →
           Read block reason
           Attempt resolution:
             - If file conflict → reassign to different executor or serialize
             - If dependency issue → defer to next wave
             - If unknown → message the blocked peer for details

       - No progress for 120s →
           send_message(executor, { msg_type: "status_request" })
           If no response in 30s → mark task blocked, reclaim

     When all tasks in wave complete → advance to next wave

  4. POST-WAVE SYNC
     git pull (peers committed to same branch)
     Re-read ROADMAP.md (catch dynamically inserted phases)
     Update STATE.md with completed phases
     Refresh available_executors via list_peers
</step>
```

### Executor Death Handling

```
<step name="executor_death_handling">
When an executor peer disappears (PID death detected by broker, or
message delivery fails):

1. Check /wave-status for their assigned task
2. If task was "running":
   - Check git log for their commits (they may have partially completed)
   - If partial work exists:
     - Assess completeness from SUMMARY.md if it exists
     - If >80% done → complete locally
     - If <80% done → reset task, reassign to another executor or self
   - If no work exists:
     - Reset task to "pending"
     - Reassign to next available executor
3. Log the failure for the session report
4. Continue — never block the whole pipeline on one dead peer
</step>
```

### Delegation Decision Logic

```
<step name="delegation_decision">
For each phase, decide: delegate to peer or execute locally?

DELEGATE when:
- Phase has no dependencies on currently-running phases
- An executor peer is available and idle
- Phase plan's file list doesn't conflict with other running tasks
  (verified via POST /conflict-check)
- Phase is "standard" execution (no human_action checkpoints expected)

EXECUTE LOCALLY when:
- Phase has unresolved dependencies on in-progress work
- No executor peers available
- Phase requires human interaction (has human_action checkpoints)
- Phase is small enough that delegation overhead isn't worth it
  (heuristic: <3 tasks in plan → just do it locally)
- Phase modifies core shared files (ROADMAP.md, STATE.md, config)
  that could conflict with orchestrator operations
</step>
```

### Orchestrator State Machine

```
INIT
  │
  ├─ discover_peers → no peers found → SEQUENTIAL (today's behavior)
  │
  └─ discover_peers → peers found → PARALLEL
      │
      ├─ dependency_analysis → build wave graph
      │
      └─ for each wave:
          │
          ├─ PLAN (sequential, orchestrator only)
          │
          ├─ EXECUTE (parallel, distributed)
          │   ├─ delegate to peers
          │   ├─ execute locally (overflow)
          │   └─ monitor via wave-status + messages
          │
          ├─ SYNC (pull commits, update state)
          │
          └─ VERIFY (read verification results, route)
              ├─ all passed → next wave
              ├─ gaps found → retry once → next wave
              └─ human needed → pause, ask user
```

---

## Part 2: Executor Protocol (Mike)

### Executor Lifecycle

```
IDLE
  │
  ├─ receive "execute_phase" message
  │
  ├─ ACK_RECEIVED (send acknowledgment)
  │
  ├─ SETUP (pull latest, read plan, validate)
  │
  ├─ EXECUTING (run plan, report progress)
  │   ├─ after each task: send "phase_progress"
  │   ├─ on block: send "phase_blocked"
  │   └─ on "status_request": send "status_response"
  │
  ├─ COMPLETING (commit, verify, report)
  │   └─ send "phase_complete"
  │
  └─ IDLE (ready for next assignment)
```

### Receiving `execute_phase`

Payload:
```json
{
  "phase_number": 3,
  "plan_path": ".planning/phases/phase-3/PLAN.md",
  "flags": "--no-transition --auto",
  "wave_id": 1,
  "task_id": 5,
  "orchestrator_id": "abc123",
  "context_summary": "(optional) Prior phases produced auth library and DB schema"
}
```

**Step 1 — Acknowledge immediately:**

Send `status_response` with `status: "acknowledged"`. If the orchestrator doesn't get an ACK within 15s, it reclaims and reassigns.

**Step 2 — Setup:**

1. `git pull --rebase origin <branch>` — if rebase fails, send `phase_blocked` (git_conflict)
2. Read the plan file at plan_path — if missing, send `phase_blocked` (plan_not_found)
3. Validate no file conflicts: `POST /conflict-check { wave_id, files }` — if conflicts, send `phase_blocked` (file_conflict)

**Step 3 — Execute:**

Run the phase plan using `gsd:execute-phase` / `gsd-executor` logic with:
- `--no-transition` flag: executor does NOT update ROADMAP.md or STATE.md (orchestrator manages global state)
- Atomic commits per task (standard GSD behavior)
- `git push` after each task commit so orchestrator and peers see progress

**Step 4 — Progress reporting:**

After each task completion:
```json
{
  "msg_type": "phase_progress",
  "payload": {
    "task_id": 5,
    "wave_id": 1,
    "phase_number": 3,
    "tasks_completed": 2,
    "tasks_total": 5,
    "last_commit": "<sha>",
    "current_task": "Implement auth middleware"
  }
}
```

### Completion Protocol

1. **Verify** — run phase success criteria, produce verification result
2. **Push** — `git push origin <branch>` (ensure all commits on remote)
3. **Send completion:**
```json
{
  "msg_type": "phase_complete",
  "payload": {
    "task_id": 5,
    "wave_id": 1,
    "phase_number": 3,
    "verification": {
      "passed": true,
      "criteria_met": 7,
      "criteria_total": 7,
      "gaps": []
    },
    "commits": ["<sha1>", "<sha2>"],
    "files_modified": ["src/auth/middleware.ts", "src/auth/index.ts"]
  }
}
```
4. **Notify broker:** `POST /task-complete { task_id }`
5. **Return to IDLE:** Update summary to "Idle — completed phase N, ready for next assignment"

### Blocked Protocol

```json
{
  "msg_type": "phase_blocked",
  "payload": {
    "task_id": 5,
    "wave_id": 1,
    "phase_number": 3,
    "reason": "category",
    "detail": "human-readable explanation",
    "tasks_completed": 2,
    "tasks_total": 5,
    "recoverable": true
  }
}
```

| reason | meaning | orchestrator action |
|---|---|---|
| `git_conflict` | Rebase/merge conflict on pull | Resolve conflict and resend, or serialize |
| `file_conflict` | Another peer modified files this phase needs | Wait for other task, then retry |
| `plan_not_found` | Plan file missing at expected path | Re-plan and resend |
| `test_failure` | Tests failing that block progress | Inspect, fix, or skip |
| `dependency_missing` | Phase depends on output that doesn't exist | Defer to next wave |
| `permission_denied` | Tool permission rejected by user | Notify user |
| `unknown` | Unexpected error | Reclaim and investigate |

After sending blocked: executor stops work and returns to IDLE. Does NOT attempt to fix — that's the orchestrator's job. Partial work stays in git.

### Handling `status_request`

Respond **immediately** — interrupt current work. No response within 30s = assumed dead.

```json
{
  "msg_type": "status_response",
  "payload": {
    "task_id": 5,
    "status": "executing",
    "tasks_completed": 2,
    "tasks_total": 5,
    "current_task": "Implement auth middleware",
    "last_activity": "2026-03-25T10:30:00.000Z"
  }
}
```

### Handling `reclaim_task`

1. Stop work immediately
2. Commit WIP: `"WIP: reclaimed by orchestrator — {reason}"`
3. Push the WIP commit
4. Send acknowledgment with `status: "reclaimed"`, last_commit, progress
5. Return to IDLE

---

## Part 3: Shared Decisions

### Branch Strategy

**Single branch per wave, push after each task.**

- Phases within a wave are independent by definition (no file conflicts per conflict-check)
- Each executor pushes after each task commit, so conflicts are caught early
- If a conflict occurs on push, the executor rebases and retries once
- If rebase fails, send `phase_blocked` with reason `git_conflict`

```
main
  └── wave-1  (all wave 1 executors push here)
       ├── executor A: commit task 1, push, commit task 2, push
       └── executor B: commit task 3, push, commit task 4, push
  └── wave-2  (created after wave 1 merges to main)
```

After wave completion, the orchestrator merges the wave branch to main.

### Context Handoff

**Filesystem-first, message-summary as fallback.**

Executors should:
1. Read the plan file directly from the filesystem (committed by orchestrator)
2. Read `.planning/STATE.md` for overall project context
3. Read prior phase VERIFICATION.md files if needed

The `context_summary` field in `execute_phase` is optional — used only when the filesystem isn't up to date yet.

### Plan Interdependence Within a Wave

**Conflict-check catches it, orchestrator serializes.**

If two "independent" phases both modify `package.json`:
1. Orchestrator calls `/conflict-check` before dispatching
2. If overlap detected, one phase moves to a synthetic "wave N+0.5"
3. Dependency graph adjusts dynamically — no re-planning needed
4. Second phase does `git pull --rebase` before starting

### Executor Requirements

**Minimum:**
- Claude Code with gsd-comms-mcp installed (for messaging)
- GSD installed (for `gsd:execute-phase` / `gsd-executor` agent)
- Access to the same git repository
- Same branch checked out (or ability to checkout the wave branch)

**Nice-to-have:**
- Same working directory (simplifies relative paths)
- PostToolUse hook for auto-session sync (gsd-peers-sync.js)

---

## Part 4: Broker Changes

### New Message Types

Uses existing `msg_type` + `payload` fields — no schema changes needed.

| msg_type | Direction | Purpose |
|---|---|---|
| `execute_phase` | orchestrator → executor | "Run this phase plan" |
| `phase_complete` | executor → orchestrator | "Phase done, here's verification status" |
| `phase_blocked` | executor → orchestrator | "I'm stuck, here's why" |
| `phase_progress` | executor → orchestrator | "Currently on task N of M" |
| `status_request` | orchestrator → executor | "Are you alive? What's your status?" |
| `status_response` | executor → orchestrator | "I'm on task N, estimated completion soon" |
| `reclaim_task` | orchestrator → executor | "Stop work, I'm reassigning this" |
| `discuss_choice` | orchestrator → decision proxy | "Here's a choice point, pick for the user" |
| `discuss_answer` | decision proxy → orchestrator | "User would choose X because Y" |

### New Endpoint: `/peer-availability`

```
POST /peer-availability
Request: { repo: string, exclude_ids: string[] }
Response: {
  available: [{ peer_id, session_id, cwd, summary, idle_since }],
  busy: [{ peer_id, session_id, current_task, wave_id }]
}
```

Combines list-peers + session-status + wave-status into a single call.

---

## Part 5: Error Recovery Matrix

| Scenario | Executor Action | Orchestrator Action |
|---|---|---|
| Git pull fails | Send `phase_blocked` (git_conflict) | Resolve or serialize |
| Plan not found | Send `phase_blocked` (plan_not_found) | Re-plan and resend |
| Test failures | Send `phase_blocked` (test_failure) | Inspect, fix, or skip |
| Peer dies mid-task | Nothing (it's dead) | Detect via PID check, reclaim task |
| Push conflict | Rebase once, retry push | If retry fails, reclaim |
| Permission denied | Send `phase_blocked` (permission_denied) | Notify user |
| Reclaim received | WIP commit, push, IDLE | Reassign to another peer |
| Status request timeout | Nothing (may be dead) | Reclaim after 30s |
| Partial completion (>80%) | N/A | Complete locally |
| Partial completion (<80%) | N/A | Reset task, reassign |

---

## Part 6: Security Considerations

- Executors validate `execute_phase` messages come from a known orchestrator peer
- Executors never execute arbitrary commands from messages — only read plan files from filesystem
- Plan path in payload must be within the project directory (no path traversal)
- Executors reject `execute_phase` if already executing a phase (no double-booking)

---

## Part 7: Backwards Compatibility

- If no peers available, workflow is identical to today's sequential autonomous
- The dependency_analysis step is additive — doesn't change planning or execution logic
- Existing wave/task broker endpoints are reused, not modified
- New message types use the existing msg_type string field
- The gsd-plugin PostToolUse hook continues working unchanged for executor sessions
