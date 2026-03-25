# GSD Plugin for claude-peers

Integrates [claude-peers](https://github.com/ecko95/claude-peers-mcp) with [GSD v1](https://github.com/gsd-build/get-shit-done) so that GSD subagents automatically register as peers and can coordinate in real time.

## What It Does

- **Auto-registration**: Each GSD executor registers with the broker via `/session-heartbeat` on every tool use — one atomic call handles peer registration, session creation, summary sync, and heartbeat
- **Summary sync**: Reads STATE.md and keeps the peer summary updated with the current phase/plan/task
- **Orchestration state**: Waves, task assignments, and file-conflict detection all live in the broker's SQLite — no temp files or markdown parsing for state tracking
- **Conflict detection**: The peer coordinator agent uses `/conflict-check` for structured file-level conflict detection
- **Cross-agent messaging**: Executors can message each other with typed messages (`task_complete`, `task_blocked`, `status_request`, etc.)

## Setup

### 1. Install the PostToolUse Hook

Add to your Claude Code settings (`.claude/settings.json` or global settings):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/claude-peers-mcp/gsd-plugin/hooks/gsd-peers-sync.js"
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/claude-peers-mcp` with the actual path to this repository.

### 2. Enable in GSD Config

Add to your project's `.planning/config.json`:

```json
{
  "hooks": {
    "peers_sync": true
  }
}
```

### 3. Add Peer Instructions to CLAUDE.md

Append the contents of `CLAUDE.md.snippet` to your GSD project's `CLAUDE.md`:

```bash
cat /path/to/claude-peers-mcp/gsd-plugin/CLAUDE.md.snippet >> your-project/CLAUDE.md
```

### 4. (Optional) Copy the Peer Coordinator Agent

If you want the orchestrator to be able to spawn a peer coordinator:

```bash
cp /path/to/claude-peers-mcp/gsd-plugin/agents/gsd-peer-coordinator.md \
   your-project/.claude/agents/gsd-peer-coordinator.md
```

## Requirements

- The claude-peers broker must be running (auto-started by the MCP server, or run `bun broker.ts` manually)
- Node.js or Bun available (the hook uses plain Node.js — no Bun-specific APIs — for compatibility)
- GSD v1 installed and active in the project (`.planning/config.json` must exist)

## How It Works

```
GSD Orchestrator
  │
  ├─ calls /wave-create ──────────────► broker creates wave + task assignments
  │
  ├─ spawns Executor A ──► gsd-peers-sync hook ──► broker /session-heartbeat
  │                         (PostToolUse)           (atomic: register peer + create session
  │                                                  + sync summary + heartbeat)
  │
  ├─ spawns Executor B ──► same flow
  │
  ├─ calls /task-start ───────────────► broker assigns session to task
  │                                      (validates status + checks file conflicts)
  │
  ├─ Executor completes ──► /task-complete ──► broker checks if wave is done
  │
  └─ spawns Peer Coordinator ──► broker /conflict-check  (structured file conflicts)
                                  broker /wave-status     (structured task state)
                                  broker /send-message    (typed messages)
```

The hook communicates directly with the broker's HTTP API — no MCP server needed. This keeps it lightweight and compatible with any GSD runtime (Claude Code, Gemini CLI, etc.).

## Monitoring

```bash
# Check DB size, row counts, retention policy
bun cli.ts stats

# Force cleanup + VACUUM to reclaim disk space
bun cli.ts prune

# Find the database file
bun cli.ts db-path

# Or hit the broker directly
curl -s http://localhost:7899/stats | jq .
```

## Configuration Reference

| Setting | Location | Default | Description |
|---|---|---|---|
| `hooks.peers_sync` | `.planning/config.json` | `true` | Enable/disable the peers sync hook |
| `CLAUDE_PEERS_PORT` | Environment | `7899` | Broker port override |
| `CLAUDE_PEERS_DB` | Environment | `~/.claude-peers.db` | Database path override |
| `CLAUDE_PEERS_RETAIN_MESSAGES_MS` | Environment | `86400000` (24h) | Delivered message retention |
| `CLAUDE_PEERS_RETAIN_SESSIONS_MS` | Environment | `604800000` (7d) | Completed session retention |
| `CLAUDE_PEERS_RETAIN_WAVES_MS` | Environment | `2592000000` (30d) | Completed wave retention |
