# Peer-Aware /gsd:autonomous — Executor Protocol (by Mike)

## Overview

This section defines how executor peers receive phase plans, execute them, report progress, and handle edge cases. It complements Sam's orchestrator design by specifying the other side of the protocol.

## Executor Lifecycle

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
  │   ├─ periodic: send "phase_progress"
  │   ├─ on block: send "phase_blocked"
  │   └─ on "status_request": send "status_response"
  │
  ├─ COMPLETING (commit, verify, report)
  │   └─ send "phase_complete"
  │
  └─ IDLE (ready for next assignment)
```

## Message Handling

### Receiving `execute_phase`

When an executor peer receives an `execute_phase` message:

```
Payload:
{
  phase_number: number,
  plan_path: string,           // e.g., ".planning/phases/phase-3/PLAN.md"
  flags: string,               // e.g., "--no-transition --auto"
  wave_id: number,
  task_id: number,
  orchestrator_id: string,     // peer ID to report back to
  context_summary?: string     // optional: what prior phases produced
}
```

**Step 1 — Acknowledge immediately:**

```
send_message(orchestrator_id, {
  msg_type: "status_response",
  payload: {
    task_id: task_id,
    status: "acknowledged",
    message: "Received phase ${phase_number}, starting setup"
  }
})
```

This tells the orchestrator the peer is alive and accepted the work. If the orchestrator doesn't get an ACK within 15s, it should reclaim and reassign.

**Step 2 — Setup:**

```
1. git pull --rebase origin <branch>
   - If rebase fails (conflict): send phase_blocked with reason "git_conflict"
   - If clean: continue

2. Read the plan file at plan_path
   - If missing: send phase_blocked with reason "plan_not_found"
   - If present: parse task list, expected files, verification criteria

3. Validate no file conflicts with local state
   - POST /conflict-check { wave_id, files: plan.expected_files }
   - If conflicts found: send phase_blocked with reason "file_conflict"
   - If clean: continue
```

**Step 3 — Execute:**

Run the phase plan. The executor uses the same execution logic as `gsd:execute-phase` / `gsd-executor` agent, but with these additions:

- **No state transitions**: The executor does NOT update ROADMAP.md or STATE.md (the `--no-transition` flag). Only the orchestrator manages global state.
- **Commit locally**: Each completed task gets an atomic commit (standard GSD behavior).
- **Push after each task**: `git push` after each task commit so the orchestrator and other peers can see progress.

**Step 4 — Progress reporting:**

After each task completion within the phase, send a progress update:

```
send_message(orchestrator_id, {
  msg_type: "phase_progress",
  payload: {
    task_id: task_id,
    wave_id: wave_id,
    phase_number: phase_number,
    tasks_completed: N,
    tasks_total: M,
    last_commit: "<sha>",
    current_task: "task name"
  }
})
```

Frequency: after each task completes (not on a timer). This avoids noise while still giving the orchestrator real-time visibility.

## Completion Protocol

When all tasks in the phase plan are done:

**Step 1 — Run verification:**

Execute the phase's verification criteria (from PLAN.md success_criteria). This is the same as what `gsd:verify-work` does, but scoped to this phase only.

Produce a lightweight verification result:

```
{
  passed: boolean,
  criteria_met: number,
  criteria_total: number,
  gaps: string[]  // list of unmet criteria, if any
}
```

**Step 2 — Final push:**

```
git push origin <branch>
```

Ensure all commits are on the remote before reporting completion.

**Step 3 — Send completion:**

```
send_message(orchestrator_id, {
  msg_type: "phase_complete",
  payload: {
    task_id: task_id,
    wave_id: wave_id,
    phase_number: phase_number,
    verification: {
      passed: true/false,
      criteria_met: N,
      criteria_total: M,
      gaps: []
    },
    commits: ["<sha1>", "<sha2>", ...],
    files_modified: ["path/to/file1.ts", "path/to/file2.ts"]
  }
})
```

**Step 4 — Notify broker:**

```
POST /task-complete { task_id: task_id }
```

This allows the broker to auto-complete the wave if all tasks are done.

**Step 5 — Return to IDLE:**

Update peer summary: `set_summary("Idle — completed phase ${phase_number}, ready for next assignment")`

## Blocked Protocol

When the executor hits a blocker it can't resolve:

```
send_message(orchestrator_id, {
  msg_type: "phase_blocked",
  payload: {
    task_id: task_id,
    wave_id: wave_id,
    phase_number: phase_number,
    reason: "category",         // see categories below
    detail: "human-readable explanation",
    tasks_completed: N,         // how much was done before the block
    tasks_total: M,
    recoverable: boolean        // can the orchestrator fix this?
  }
})

POST /task-blocked { task_id, reason: "detail string" }
```

**Block categories:**

| reason | meaning | orchestrator action |
|---|---|---|
| `git_conflict` | Rebase/merge conflict on pull | Resolve conflict and resend, or serialize |
| `file_conflict` | Another peer modified files this phase needs | Wait for other task to complete, then retry |
| `plan_not_found` | Plan file missing at expected path | Re-plan and resend |
| `test_failure` | Tests failing that block further progress | Orchestrator inspects, may fix or skip |
| `dependency_missing` | Phase depends on output that doesn't exist yet | Defer to next wave |
| `permission_denied` | Tool permission rejected by user | Orchestrator notifies user |
| `unknown` | Unexpected error | Orchestrator reclaims and investigates |

**After sending blocked:** The executor stops work on this phase and returns to IDLE. It does NOT attempt to fix the issue — that's the orchestrator's job. Any partial work already committed stays in git.

## Handling `status_request`

When the executor receives a `status_request`:

```
send_message(orchestrator_id, {
  msg_type: "status_response",
  payload: {
    task_id: task_id,
    status: "executing",        // or "idle", "setup", "blocked"
    tasks_completed: N,
    tasks_total: M,
    current_task: "task name",
    last_activity: "<ISO timestamp>"
  }
})
```

This must be handled **immediately** — interrupt current work to respond. The orchestrator uses this as a heartbeat/liveness check. No response within 30s = assumed dead.

## Handling `reclaim_task`

When the executor receives a `reclaim_task`:

```
Payload:
{
  task_id: number,
  reason: string  // e.g., "reassigning to faster executor", "dependency changed"
}
```

**Executor behavior:**
1. Stop work on the current phase immediately
2. Commit any in-progress work with message: `"WIP: reclaimed by orchestrator — ${reason}"`
3. Push the WIP commit
4. Send acknowledgment:

```
send_message(orchestrator_id, {
  msg_type: "status_response",
  payload: {
    task_id: task_id,
    status: "reclaimed",
    last_commit: "<sha>",
    tasks_completed: N,
    tasks_total: M
  }
})
```

5. Return to IDLE

## Branch Strategy (addressing Sam's open question #1)

**Recommendation: Single branch per wave, push after each task.**

Rationale:
- Phases within a wave are independent by definition (no file conflicts per conflict-check)
- Each executor pushes after each task commit, so conflicts are caught early
- If a conflict does occur on push, the executor rebases and retries once
- If rebase fails, send `phase_blocked` with reason `git_conflict`
- This avoids the complexity of per-executor branches + merge step

```
main
  └── wave-1  (all wave 1 executors push here)
       ├── executor A: commit task 1, push, commit task 2, push
       └── executor B: commit task 3, push, commit task 4, push
  └── wave-2  (created after wave 1 merges to main)
```

After wave completion, the orchestrator merges the wave branch to main (or the working branch).

## Context Handoff (addressing Sam's open question #4)

**Recommendation: Filesystem-first, message-summary as fallback.**

The executor should:
1. Read the plan file directly from the filesystem (it was committed by the orchestrator)
2. Read `.planning/STATE.md` for overall project context
3. Read prior phase VERIFICATION.md files if they need to understand what was built

The `context_summary` field in `execute_phase` payload is optional — used only when the orchestrator knows the filesystem isn't up to date yet (e.g., between the plan commit and the executor's git pull).

## Executor Requirements (addressing Sam's open question #3)

**Minimum requirements for an executor peer:**
- Claude Code with gsd-comms-mcp installed (for messaging)
- GSD installed (for `gsd:execute-phase` / `gsd-executor` agent)
- Access to the same git repository
- Same branch checked out (or ability to checkout the wave branch)

**Nice-to-have:**
- Same working directory (simplifies relative paths)
- PostToolUse hook for auto-session sync (gsd-peers-sync.js)

## Plan Interdependence Within a Wave (addressing Sam's open question #2)

**Recommendation: Conflict-check catches it, orchestrator serializes.**

If two "independent" phases both modify `package.json`:
1. The orchestrator calls `/conflict-check` before dispatching
2. If overlap detected, the orchestrator moves one phase to a synthetic "wave N+0.5" (execute after the first completes)
3. The dependency graph is adjusted dynamically — no re-planning needed
4. The second phase does `git pull --rebase` before starting, picking up the first phase's changes

This keeps the wave model clean while handling the edge case.

## Error Recovery Summary

| Scenario | Executor Action | Orchestrator Action |
|---|---|---|
| Git pull fails | Send `phase_blocked` (git_conflict) | Resolve or serialize |
| Plan not found | Send `phase_blocked` (plan_not_found) | Re-plan and resend |
| Test failures | Send `phase_blocked` (test_failure) | Inspect, fix, or skip |
| Peer dies mid-task | Nothing (it's dead) | Detect via PID check, reclaim task |
| Push conflict | Rebase once, retry push | If retry fails, reclaim |
| Permission denied | Send `phase_blocked` (permission_denied) | Notify user |
| Reclaim received | WIP commit, push, return to IDLE | Reassign to another peer |
| Status request timeout | Nothing (may be dead) | Reclaim after 30s |

## Security Considerations

- Executors should validate that `execute_phase` messages come from a known orchestrator peer (check `from_id` against discovered peers)
- Executors should never execute arbitrary commands from messages — only read plan files from the filesystem
- The plan path in the payload must be within the project directory (no path traversal)
- Executors should reject `execute_phase` if they're already executing a phase (no double-booking)
