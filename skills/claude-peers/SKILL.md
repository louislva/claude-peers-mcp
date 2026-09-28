---
name: claude-peers
description: "Discover, message, and coordinate AI coding agents (Claude Code, Codex CLI) running on the same machine via a shared Unix socket broker backed by SQLite. The broker wakes recipients natively (Claude inbox socket, codex queue) and turn-boundary hooks catch missed wakes. Supports cross-session task delegation, peer summaries, and session lifecycle management. Triggers on 'peer agents', 'cross-session communication', 'message Codex', 'inter-agent messaging', 'coordinate agents'."
user-invocable: false
---

# claude-peers

Peer discovery and messaging network for AI coding agents on the same machine. A shared broker daemon listens on a Unix domain socket (`~/.claude/run/claude-peers.sock`), backed by SQLite (`~/.claude/claude-peers.db`), routing messages between Claude Code and Codex CLI sessions.

**Claude-to-Claude:** prefer Claude Code's native `SendMessage` / `ListAgents` (v2.1.224+). Use claude-peers whenever a Codex session is involved.

## Native Wake

When a message is sent, the broker wakes the recipient instead of waiting for it to poll:

| Client | Wake transport | Endpoint source | Idle session | Busy session |
|--------|---------------|-----------------|--------------|--------------|
| **claude-code** | Inbox socket (`CLAUDE_CODE_MESSAGING_SOCKET` + token) | MCP server registers it from its environment | Starts a turn | Reads it between tool calls |
| **codex** | `codex queue --thread <id>` | Codex hook sends `session_id` to `/set-wake` | Starts a turn | Receives it after the current turn |
| **cli** | none | — | — | — |

The wake is a fixed, body-free nudge: `[claude-peers] New message from <peer> (<client>, <dir>). Call check_messages to read and reply.` On receiving it, call `check_messages` right away and reply with `send_message`. `check_messages` is the only place messages are acknowledged; a message stays unread (and re-deliverable) until then. `send_message` reports the wake result: queued, coalesced (a wake is already pending), failed, ambiguous, or none.

## Turn-Boundary Hooks

`~/tools/claude-peers-mcp/hooks/peers-hook.ts --harness claude|codex` is the safety net for wakes that fail. It fails open and logs quiet failures to `~/.claude/run/claude-peers-hook.log`.

| Event | Behavior while messages are unread |
|-------|------------------------------------|
| `Stop` | Blocks finishing once: "N unread peer message(s) from X. Call check_messages and reply before finishing." |
| `PreToolUse` (Bash) | Before `git add/commit/push`, adds context to check peer messages first (non-blocking) |
| `UserPromptSubmit` | Adds the unread count as context |
| `SessionStart` (Codex) | Registers the thread ID for `codex queue`; reports unread messages |

Codex `UserPromptSubmit` and `Stop` repeat the thread registration, because Codex `SessionStart` can run before the MCP server registers.

## Workflow Patterns

**Task delegation:** Send a focused task description to a Codex or Claude peer via `send_message`. Include file paths, acceptance criteria, and which branch to work on. The broker wakes the receiving agent; no need to promise to poll for its reply.

**Code review handoff:** After completing work, message a peer with the diff summary and ask for review. The peer can respond with findings via `send_message`.

**Parallel exploration:** Multiple agents working the same repo can use `set_summary` to advertise what they're investigating, preventing duplicate work. Use `list_peers` with scope `repo` to see who else is in the same codebase.

**Session lifecycle:** Use `kill_peer` to terminate a stuck, unresponsive, or completed peer's agent session. This kills the parent process (e.g., the Codex CLI), not just the MCP subprocess, and cleans up the peer record.

## CLI Reference

```bash
bun ~/tools/claude-peers-mcp/cli.ts status          # Broker health + all peers (with orphan warnings)
bun ~/tools/claude-peers-mcp/cli.ts peers            # Quick peer listing
bun ~/tools/claude-peers-mcp/cli.ts orphans          # List orphaned server.ts processes (PPID=1)
bun ~/tools/claude-peers-mcp/cli.ts cleanup          # Kill orphaned processes and remove from broker
bun ~/tools/claude-peers-mcp/cli.ts send <id> <msg>  # Send from terminal (tagged as unverified)
bun ~/tools/claude-peers-mcp/cli.ts kill <id>         # Kill a peer's agent session (SIGTERM to parent)
bun ~/tools/claude-peers-mcp/cli.ts kill-broker       # Stop the broker daemon
```

## Message History

`check_messages` returns recent messages (sent and received), newest first, with enrichment:
- `[claude-code]` or `[codex]` client-type tags
- ISO timestamps
- `[NEW]` marker for unread messages, which the call then acknowledges
- Direction indicator (From/To) with peer summary or CWD

Messages persist across reads — calling `check_messages` multiple times still shows history. Unread messages survive an MCP server restart: the broker hands them to the agent's new server (same parent process), and a sender's unread messages stay deliverable after it exits.

## Orphan Management

MCP server processes detect parent death via stdin close (immediate) and PPID monitoring (30s fallback). The broker's stale-peer sweep (every 30s) also detects orphaned processes (PPID=1) and terminates them.

For manual cleanup: `bun cli.ts orphans` lists and `bun cli.ts cleanup` kills orphaned processes.

## Gotchas

- **Codex sandbox:** Codex's macOS seatbelt sandbox blocks socket `connect()` in `workspace-write` mode. Codex sessions currently require `--dangerously-bypass-approvals-and-sandbox` or `danger-full-access` sandbox to reach the broker. This is a Codex sandbox limitation, not a peers issue — tracked at Codex issue #11095.
- **Tool name collision:** Claude Code's built-in `SendMessage` reaches only Claude sessions. To message a Codex peer, call `mcp__claude-peers__send_message` explicitly — models reach for the built-in first.
- **Codex hooks need trust:** after installing or changing `~/.codex/hooks.json`, run `/hooks` in Codex and trust the `peers-hook.ts` entries, or the thread never registers and Codex is not woken.
- **Codex wake limits:** `codex queue` does not wake an interrupted or unloaded thread; its hooks report unread messages when it resumes.
- **Older Claude Code (no inbox socket):** delivery falls back to `claude/channel` push, which never acknowledges, so the `Stop` hook blocks once per turn until the agent calls `check_messages`.
- **Claude inbound refused:** `crossSessionInbound: "refuse"` silently drops the wake; the `Stop` hook still catches unread messages.
- **Diagnose a stuck wake:** `list_peers` shows each peer's wake transport and last wake status/time. A wake that was never answered re-arms after 5 minutes.
- **Permission allow-list:** `mcp__claude-peers__send_message` may not be in the auto-allow list. The user may need to approve it on first use or add it to `settings.json` permissions.
- **Broker must be running:** The broker is managed by launchd (`com.minoan.claude-peers-broker`). If peers can't connect, check: `launchctl list | grep claude-peers`.
- **Stale socket:** If the broker crashes, the socket file persists. On restart, the broker detects and removes it automatically.
- **TCP fallback:** Set `CLAUDE_PEERS_TCP=1` in the broker's env to also listen on TCP port 7899. Clients use TCP when `CLAUDE_PEERS_URL` is set (e.g., `CLAUDE_PEERS_URL=http://127.0.0.1:7899`).
