# Peer-Aware /gsd:autonomous — Orchestrator Design (by Sam)

## Problem

`/gsd:autonomous` runs discuss→plan→execute per phase **sequentially in a single session**. Even though `execute-phase` can parallelize tasks within a phase via subagents, the phases themselves are serial. With gsd-comms-mcp, we have multiple Claude instances that could execute independent phases concurrently — but the autonomous loop doesn't know they exist.

## Design Principle: One Planner, Many Executors

The orchestrator session owns the planning pipeline. Peer sessions are executors. This avoids:
- Two peers planning conflicting approaches for related phases
- Race conditions on ROADMAP.md / STATE.md updates
- Dependency violations between phases

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

## Changes to /gsd:autonomous

### New Step: `discover_peers` (after init, before phase loop)

```
<step name="discover_peers" priority="after_init">
Call list_peers with scope "machine" (or "repo" if you want tighter scoping).

Filter for peers that:
- Are NOT the current session (exclude own ID)
- Have status indicating availability (summary doesn't contain "busy" or active phase work)
- Are in the same repo OR are idle sessions willing to help

Store as `available_executors[]` with their peer IDs.

If no peers found:
  → Fall back to standard sequential autonomous (no change from today)

If peers found:
  → Log: "Found {N} available executor peers. Enabling parallel phase execution."
  → Continue to dependency_analysis
</step>
```

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

Group phases into **execution waves** (borrowing the existing wave concept):
- Wave 1: All phases with no dependencies (can run in parallel)
- Wave 2: Phases that depend only on Wave 1 phases
- Wave N: Phases that depend only on completed waves

Output: ordered list of waves, each containing parallelizable phases.

Example:
  Wave 1: [Phase 1 (DB schema), Phase 2 (Auth library)]
  Wave 2: [Phase 3 (API endpoints — depends on 1+2), Phase 4 (CLI tool — depends on 2)]
  Wave 3: [Phase 5 (Frontend — depends on 3)]
</step>
```

### Modified Step: Phase Loop (replaces sequential loop)

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
           name: `phase-${p.number}`,
           files: p.plan.expected_files  // from PLAN.md
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
             plan_path: `.planning/phases/phase-${p.number}/PLAN.md`,
             flags: "--no-transition --auto",
             wave_id: wave_id,
             task_id: task_id
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

### New Step: `executor_death_handling`

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

### Decision Logic: Delegate vs Execute Locally

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

## Broker Changes Needed

### New message types

Add to the existing `msg_type` enum:

| msg_type | Direction | Purpose |
|---|---|---|
| `execute_phase` | orchestrator → executor | "Run this phase plan" |
| `phase_complete` | executor → orchestrator | "Phase done, here's verification status" |
| `phase_blocked` | executor → orchestrator | "I'm stuck, here's why" |
| `phase_progress` | executor → orchestrator | "Currently on task N of M" |
| `status_request` | orchestrator → executor | "Are you alive? What's your status?" |
| `status_response` | executor → orchestrator | "I'm on task N, estimated completion soon" |
| `reclaim_task` | orchestrator → executor | "Stop work, I'm reassigning this" |

These use the existing `msg_type` + `payload` fields on `/send-message` — no schema changes needed.

### New endpoint: `/peer-availability`

```
POST /peer-availability
Request: { repo: string, exclude_ids: string[] }
Response: {
  available: [{ peer_id, session_id, cwd, summary, idle_since }],
  busy: [{ peer_id, session_id, current_task, wave_id }]
}
```

Combines list-peers + session-status + wave-status into a single call for the orchestrator. Avoids N+1 queries.

## Executor Peer Behavior

(Mike's section — how the executor receives, runs, and reports back)

## Orchestrator State Machine

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

## Backwards Compatibility

- If no peers are available, the workflow is identical to today's sequential autonomous
- The dependency_analysis step is additive — it doesn't change planning or execution logic
- Existing wave/task broker endpoints are reused, not modified
- New message types use the existing msg_type field (string, not enum)
- The gsd-plugin PostToolUse hook continues to work unchanged for executor sessions

## Open Questions

1. **Branch strategy**: Should each executor peer work on a separate branch and merge, or all commit to the same phase branch? Same branch is simpler but risks merge conflicts. Separate branches need a merge step.

2. **Plan interdependence within a wave**: What if two "independent" phases both want to modify `package.json`? The conflict-check catches this, but what's the resolution — serialize them, or let the second one rebase?

3. **Executor peer setup**: Does the executor peer need GSD installed, or just gsd-comms-mcp? If it needs GSD, the setup instructions expand significantly.

4. **Context handoff size**: The `execute_phase` message includes a plan path. Should it also include a summary of completed phases for context, or does the executor just read the filesystem?
