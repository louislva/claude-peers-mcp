---
phase: 09-slash-commands
plan: 01
subsystem: ui
tags: [slash-commands, tmux, tui, broker, cli]

# Dependency graph
requires:
  - phase: 06-tui-core
    provides: tui/main.ts entry point for comms-watch TUI
  - phase: 08-broker-tabs-and-endpoint
    provides: broker /health endpoint used by comms-kill
provides:
  - /comms-watch slash command (.claude/commands/comms-watch.md)
  - /comms-kill slash command (.claude/commands/comms-kill.md)
affects: [09-slash-commands]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Slash command markdown files with disable-model-invocation: true for pure automation"
    - "tmux split-window -h -p 35 -d for 35%-width right-pane spawning"
    - "printf pane title trick for duplicate detection via tmux list-panes"
    - "curl /health + lsof + xargs kill -TERM for broker lifecycle management"

key-files:
  created:
    - .claude/commands/comms-watch.md
    - .claude/commands/comms-kill.md
  modified: []

key-decisions:
  - "/comms-watch follows exact /gsd-watch pattern: 4 steps, same prose style, same tmux flags"
  - "Pane title set via printf so duplicate detection works on comms-watch: prefix"
  - "/comms-kill checks /health first to get peer count before killing, matching cli.ts kill-broker logic"
  - "Both commands use disable-model-invocation: true — no LLM reasoning, pure Bash automation"

patterns-established:
  - "Slash command pattern: YAML frontmatter + numbered steps instructing Claude what Bash to run"
  - "Duplicate guard pattern: set pane title on spawn, check title prefix before spawning again"

requirements-completed: [CMD-01, CMD-05]

# Metrics
duration: 22min
completed: 2026-03-30
---

# Phase 09 Plan 01: Slash Commands Summary

**Two slash commands for comms-watch TUI: /comms-watch launches TUI in a 35%-width tmux split with duplicate guard; /comms-kill stops the broker daemon after checking peer count via /health**

## Performance

- **Duration:** 22 min
- **Started:** 2026-03-30T20:06:47Z
- **Completed:** 2026-03-30T20:08:52Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- `/comms-watch` slash command with 4-step guard sequence: bun availability, tmux presence, duplicate pane detection, then spawn via `tmux split-window -h -p 35 -d` with pane title set for dedup
- `/comms-kill` slash command with 2-step sequence: health check to retrieve peer count, then `lsof + xargs kill -TERM` to stop the broker process
- Both commands follow `disable-model-invocation: true` pattern — executed as pure Bash automation with no LLM reasoning required

## Task Commits

Each task was committed atomically:

1. **Task 1: Create /comms-watch slash command** - `d0ed49e` (feat)
2. **Task 2: Create /comms-kill slash command** - `d1a0b42` (feat)

**Plan metadata:** (docs: complete plan) — added after state updates

## Files Created/Modified
- `.claude/commands/comms-watch.md` - Slash command: launches comms-watch TUI in tmux 35%-width right pane with bun/tmux/duplicate guards
- `.claude/commands/comms-kill.md` - Slash command: stops broker via lsof + SIGTERM, reports peer count from /health first

## Decisions Made
- Followed `/gsd-watch` pattern exactly: same 4-step structure, same prose style, same tmux flags (`-h -p 35 -d`)
- Used `printf '\\033]2;comms-watch: %s\\033\\\\'` to set pane title on spawn — enables duplicate detection on re-invoke
- `/comms-kill` checks `/health` before killing to report peer count in confirmation message, matching `cli.ts kill-broker` behavior
- Both use `${CLAUDE_PEERS_PORT:-7899}` for port configurability via env var

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Both slash commands are ready for use in Claude Code sessions
- Phase 09 Plan 02 can proceed (remaining slash commands: /comms-peers, /comms-send, /comms-stats)
- No blockers

---
*Phase: 09-slash-commands*
*Completed: 2026-03-30*
