# Phase 9: Slash Commands - Context

**Gathered:** 2026-03-30
**Status:** Ready for planning
**Mode:** Auto-generated (infrastructure phase — discuss skipped)

<domain>
## Phase Boundary

Create 5 Claude Code slash commands in the project's `.claude/commands/` directory: `/comms-watch` (launch TUI in tmux), `/comms-peers` (inline peer list), `/comms-send` (send message), `/comms-stats` (inline stats), `/comms-kill` (stop broker). These are YAML-frontmatter markdown files that Claude Code executes.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion. Key references:
- Design spec: `docs/superpowers/specs/2026-03-30-comms-watch-tui-design.md` (Slash Commands section)
- Existing slash command pattern: `/gsd-watch` at `~/.claude/commands/gsd-watch.md`
- Slash commands are markdown files with YAML frontmatter (name, description, allowed-tools, etc.)

### Command Patterns
- `/comms-watch` follows the exact same pattern as `/gsd-watch` — check binary, check tmux, check duplicate, spawn pane
- `/comms-peers`, `/comms-stats`, `/comms-kill` are inline commands (no tmux) — call broker HTTP API via Bash/fetch and print formatted output
- `/comms-send` takes arguments: peer-id and message text
- Commands go in project `.claude/commands/` directory (not user-level `~/.claude/commands/`)

### Slash Command YAML Format
```yaml
---
name: comms-watch
description: Launch comms-watch TUI in a tmux split pane
allowed-tools: Bash
---
```

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `~/.claude/commands/gsd-watch.md` — template for /comms-watch (tmux split pattern)
- `cli.ts` — existing broker call patterns for peers, stats, kill, send
- `tui/main.ts` — entry point for the TUI

### Established Patterns
- Slash commands use `Bash` as allowed-tool to run shell commands
- Commands check prerequisites before acting (binary exists, tmux available, etc.)
- `disable-model-invocation: true` for commands that don't need Claude to think

### Integration Points
- `.claude/commands/` directory in this project
- Commands reference `bun tui/main.ts` for the TUI launch
- Commands reference broker at `http://127.0.0.1:${CLAUDE_PEERS_PORT:-7899}`

</code_context>

<specifics>
## Specific Ideas

- /comms-watch: 35% width right pane, duplicate detection via pane title prefix "comms-watch:"
- /comms-peers: format like cli.ts peers command but more readable
- /comms-send: validate both args present before sending
- /comms-stats: format like cli.ts stats but concise
- /comms-kill: confirm shutdown with peer count warning

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>
