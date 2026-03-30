---
phase: 09-slash-commands
plan: "02"
subsystem: slash-commands
tags: [slash-commands, broker-api, peers, messaging, stats]
dependency_graph:
  requires: []
  provides:
    - .claude/commands/comms-peers.md
    - .claude/commands/comms-send.md
    - .claude/commands/comms-stats.md
  affects: []
tech_stack:
  added: []
  patterns:
    - curl POST to broker HTTP API for inline slash commands
    - JSON parsing and formatting by Claude model (no disable-model-invocation)
    - ${CLAUDE_PEERS_PORT:-7899} pattern for port configurability
key_files:
  created:
    - .claude/commands/comms-peers.md
    - .claude/commands/comms-send.md
    - .claude/commands/comms-stats.md
  modified: []
decisions:
  - "/comms-peers, /comms-send, /comms-stats all omit disable-model-invocation so Claude parses JSON and formats output readably"
  - "comms-send uses jq for safe JSON escaping of user-provided message text"
metrics:
  duration_seconds: 75
  completed_date: "2026-03-30"
  tasks_completed: 3
  files_created: 3
  files_modified: 0
---

# Phase 09 Plan 02: Inline Slash Commands (comms-peers, comms-send, comms-stats) Summary

**One-liner:** Three inline slash commands calling broker HTTP API via curl: peer listing with formatted output, message delivery with argument validation, and stats display with DB/retention/row-count sections.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create /comms-peers slash command | bbc4e45 | .claude/commands/comms-peers.md |
| 2 | Create /comms-send slash command | bea2aaa | .claude/commands/comms-send.md |
| 3 | Create /comms-stats slash command | 8aaa0df | .claude/commands/comms-stats.md |

## What Was Built

Three slash command markdown files in `.claude/commands/` that let users query broker state and send messages directly from any Claude Code conversation:

- **`/comms-peers`** — Calls `POST /list-peers` with `scope: machine`. Claude parses the JSON array and formats each peer with ID, PID, cwd, summary (if present), and last_seen. Prints count header and handles empty list and broker-not-running cases.

- **`/comms-send`** — Extracts peer-id and message from user input. Validates both are present (prints usage if not). Uses jq for safe JSON escaping, then calls `POST /send-message` with `from_id: "cli"`. Reports success or failure inline.

- **`/comms-stats`** — Calls `GET /stats`. Claude parses and formats into three sections: Database (path, size, schema version), Retention Policy (messages/sessions/waves), and Row Counts (peers, messages, sessions, waves, tasks).

All three commands:
- Use `allowed-tools: Bash` only
- Do NOT use `disable-model-invocation` (Claude formats JSON output)
- Use `${CLAUDE_PEERS_PORT:-7899}` for port configurability
- Handle broker-not-running with a friendly error message

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None. All commands wire directly to live broker API endpoints.

## Self-Check: PASSED

Files created:
- FOUND: .claude/commands/comms-peers.md
- FOUND: .claude/commands/comms-send.md
- FOUND: .claude/commands/comms-stats.md

Commits:
- FOUND: bbc4e45 (feat(09-02): create /comms-peers slash command)
- FOUND: bea2aaa (feat(09-02): create /comms-send slash command)
- FOUND: 8aaa0df (feat(09-02): create /comms-stats slash command)
