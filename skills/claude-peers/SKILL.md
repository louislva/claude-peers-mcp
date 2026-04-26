---
name: claude-peers
description: "Peer discovery, messaging, and lifecycle management for AI coding agents (Claude Code, Codex CLI) on the same machine. This skill should be used when coordinating work across multiple agent sessions, delegating tasks between Claude and Codex, killing or stopping peer sessions, or when the user mentions peers, agents, cross-session communication, or inter-agent messaging."
user-invocable: false
---

# claude-peers

Peer discovery and messaging network for AI coding agents on the same machine. A shared broker daemon listens on a Unix domain socket (`~/.claude/run/claude-peers.sock`), backed by SQLite, routing messages between Claude Code and Codex CLI sessions.

## Client Types

| Client | Push notifications | Message delivery | Config |
|--------|-------------------|-----------------|--------|
| **claude-code** | Yes (`claude/channel`) | Instant — messages pushed into session | `settings.json` MCP entry |
| **codex** | No | Poll — must call `check_messages` each turn | `~/.codex/config.toml` MCP entry |
| **cli** | No | Manual via `bun ~/tools/claude-peers-mcp/cli.ts send <id> <msg>` | N/A |

## Workflow Patterns

**Task delegation:** Send a focused task description to a Codex or Claude peer via `send_message`. Include file paths, acceptance criteria, and which branch to work on. The receiving agent picks it up on its next turn.

**Code review handoff:** After completing work, message a peer with the diff summary and ask for review. The peer can respond with findings via `send_message`.

**Parallel exploration:** Multiple agents working the same repo can use `set_summary` to advertise what they're investigating, preventing duplicate work. Use `list_peers` with scope `repo` to see who else is in the same codebase.

**Session lifecycle:** Use `kill_peer` to terminate a stuck, unresponsive, or completed peer's agent session. This kills the parent process (e.g., the Codex CLI), not just the MCP subprocess, and cleans up the peer record.

## CLI Reference

```bash
bun ~/tools/claude-peers-mcp/cli.ts status        # Broker health + all peers with [type] tags
bun ~/tools/claude-peers-mcp/cli.ts peers          # Quick peer listing
bun ~/tools/claude-peers-mcp/cli.ts send <id> <msg> # Send from terminal (tagged as unverified)
bun ~/tools/claude-peers-mcp/cli.ts kill <id>       # Kill a peer's agent session (SIGTERM to parent)
bun ~/tools/claude-peers-mcp/cli.ts kill-broker     # Stop the broker daemon
```

## Gotchas

- **Codex sandbox:** Codex's macOS seatbelt sandbox blocks socket `connect()` in `workspace-write` mode. Codex sessions currently require `--dangerously-bypass-approvals-and-sandbox` or `danger-full-access` sandbox to reach the broker. This is a Codex sandbox limitation, not a peers issue — tracked at Codex issue #11095.
- **Codex has no push:** Codex agents must call `check_messages` proactively — messages are invisible until polled.
- **Permission allow-list:** `mcp__claude-peers__send_message` may not be in the auto-allow list. The user may need to approve it on first use or add it to `settings.json` permissions.
- **Broker must be running:** The broker is managed by launchd (`com.minoan.claude-peers-broker`). If peers can't connect, check: `launchctl list | grep claude-peers`.
- **Stale socket:** If the broker crashes, the socket file persists. On restart, the broker detects and removes it automatically.
- **TCP fallback:** Set `CLAUDE_PEERS_TCP=1` in the broker's env to also listen on TCP port 7899. Clients use TCP when `CLAUDE_PEERS_URL` is set (e.g., `CLAUDE_PEERS_URL=http://127.0.0.1:7899`).
