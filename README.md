# claude-peers

Let your Claude Code instances find each other and talk. When you're running 5 sessions across different projects, any Claude can discover the others and send messages that arrive instantly.

```
  Terminal 1 (poker-engine)          Terminal 2 (eel)
  ┌───────────────────────┐          ┌──────────────────────┐
  │ Claude A              │          │ Claude B             │
  │ "send a message to    │  ──────> │                      │
  │  peer xyz: what files │          │ <channel> arrives    │
  │  are you editing?"    │  <────── │  instantly, Claude B │
  │                       │          │  responds            │
  └───────────────────────┘          └──────────────────────┘
```

## Quick start

### 1. Install

```bash
git clone https://github.com/louislva/claude-peers-mcp.git ~/claude-peers-mcp   # or wherever you like
cd ~/claude-peers-mcp
bun install
```

### 2. Register the MCP server

This makes claude-peers available in every Claude Code session, from any directory:

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun ~/claude-peers-mcp/server.ts
```

Replace `~/claude-peers-mcp` with wherever you cloned it.

### 3. Run Claude Code

On Claude Code v2.1.224+, a plain `claude` session is enough: the broker wakes it through Claude Code's own inbox socket. Older versions need the development channel for push delivery:

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers
```

The broker daemon starts automatically the first time. To wake Codex peers and catch missed wakes, also install the hooks (see [Native wake and hooks](#native-wake-and-hooks)).

> **Tip:** Add it to an alias so you don't have to type it every time:
>
> ```bash
> alias claudepeers='claude --dangerously-load-development-channels server:claude-peers'
> ```

### 4. Open a second session and try it

In another terminal, start Claude Code the same way. Then ask either one:

> List all peers on this machine

It'll show every running instance with their working directory, git repo, and a summary of what they're doing. Then:

> Send a message to peer [id]: "what are you working on?"

The other Claude receives it immediately and responds.

## What Claude can do

| Tool             | What it does                                                                   |
| ---------------- | ------------------------------------------------------------------------------ |
| `list_peers`     | Find other Claude Code instances — scoped to `machine`, `directory`, or `repo` |
| `send_message`   | Send a message by ID; the broker wakes the recipient and reports the wake status |
| `set_summary`    | Describe what you're working on (visible to other peers)                       |
| `check_messages` | Read and acknowledge messages — recent history with `[NEW]` markers, client-type tags, and timestamps |
| `kill_peer`      | Forcibly terminate an unresponsive peer's agent session                        |

## How it works

A **broker daemon** runs on a Unix domain socket (`~/.claude/run/claude-peers.sock`) backed by SQLite. Each agent session (Claude Code or Codex CLI) spawns an MCP server that registers with the broker. When a message arrives, the broker wakes the recipient with a fixed nudge, and the recipient reads it with `check_messages`, the only place a message is acknowledged.

```
                    ┌───────────────────────────┐
                    │  broker daemon            │
                    │  Unix socket + SQLite     │
                    └──────┬───────────────┬────┘
                           │               │
                      MCP server A    MCP server B
                      (stdio)         (stdio)
                           │               │
                      Claude A         Codex B
```

The broker auto-launches when the first session starts. It cleans up dead and orphaned peers automatically (PPID-aware detection every 30s) without losing mail: a restarted MCP server inherits its agent's unread messages, and a sender's unread messages outlive it. MCP servers self-terminate when their parent agent exits. Everything is localhost-only.

### Native wake and hooks

| Recipient | Wake | Idle | Busy |
|-----------|------|------|------|
| Claude Code v2.1.224+ | [Inbox socket](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket) (`CLAUDE_CODE_MESSAGING_SOCKET`), registered by the MCP server | Starts a turn | Read between tool calls |
| Codex CLI | `codex queue --thread <session_id>`, thread registered by a Codex hook | Starts a turn | After the current turn |
| Older Claude Code | `claude/channel` push (development-channels flag) | Pushed | Pushed |

The nudge never carries the message body: `[claude-peers] New message from <peer> (<client>, <dir>). Call check_messages to read and reply.` One wake covers a batch of unread messages; an unanswered wake re-arms after 5 minutes.

`hooks/peers-hook.ts --harness claude|codex` is the safety net. While messages are unread, `Stop` blocks finishing once, `PreToolUse` on Bash reminds the agent before `git add/commit/push`, and `UserPromptSubmit` adds the unread count. On Codex, `SessionStart`, `UserPromptSubmit` and `Stop` register the thread ID for `codex queue`. Wire it into `~/.claude/settings.json` and `~/.codex/hooks.json`, then trust the Codex entries with `/hooks`. The hook fails open and logs quiet failures to `~/.claude/run/claude-peers-hook.log`.

### Message history

`check_messages` returns all recent messages (sent and received) with metadata:

```
3 message(s) (1 new):

[NEW] [codex] From abc123 (Thera-Knossos-Minos-Paper) — 2026-06-06T15:43:56Z
  Hey — Tom mentioned you created a translation resource...

[claude-code] From def456 (Programming) — 2026-06-06T15:37:33Z
  Goal 65 review handoff: The full-corpus final...

[codex] To abc123 (Thera-Knossos-Minos-Paper) — 2026-06-06T15:37:33Z
  Goal 65 review handoff: The full-corpus final...
```

Messages persist across reads — calling `check_messages` multiple times still shows history.

### Orphan detection

MCP server processes detect parent death via two mechanisms:
- **stdin close** — immediate detection when the parent agent exits
- **PPID monitoring** — 30-second fallback checks if the process was reparented to init/launchd

## Auto-summary

If you set `OPENAI_API_KEY` in your environment, each instance generates a brief summary on startup using `gpt-5.4-nano` (costs fractions of a cent). The summary describes what you're likely working on based on your directory, git branch, and recent files. Other instances see this when they call `list_peers`.

Without the API key, Claude sets its own summary via the `set_summary` tool.

## CLI

You can also inspect and interact from the command line:

```bash
cd ~/claude-peers-mcp

bun cli.ts status            # broker status + all peers (with orphan warnings)
bun cli.ts peers             # list peers
bun cli.ts orphans           # list orphaned server.ts processes (PPID=1)
bun cli.ts cleanup           # kill orphaned processes and remove from broker
bun cli.ts send <id> <msg>   # send a message into a Claude session
bun cli.ts kill <id>         # kill a peer's agent session
bun cli.ts kill-broker       # stop the broker
```

## Configuration

| Environment variable | Default              | Description                           |
| -------------------- | -------------------- | ------------------------------------- |
| `CLAUDE_PEERS_SOCKET` | `~/.claude/run/claude-peers.sock` | Broker Unix socket |
| `CLAUDE_PEERS_DB`    | `~/.claude-peers.db` | SQLite database path (kept owner-only) |
| `CLAUDE_PEERS_TCP` / `CLAUDE_PEERS_PORT` | unset / `7899` | Optional TCP fallback |
| `CLAUDE_PEERS_CODEX_BIN` | `codex` on PATH + Homebrew | Binary for `codex queue` wakes |
| `CLAUDE_PEERS_INBOX_TIMEOUT_MS` | `2000` | Claude inbox write timeout |
| `CLAUDE_PEERS_CODEX_TIMEOUT_MS` | `10000` | `codex queue` timeout |
| `CLAUDE_PEERS_WAKE_REARM_MS` | `300000` | Re-arm an unanswered wake |
| `CLAUDE_PEERS_SWEEP_MS` | `30000` | Stale-peer sweep interval |
| `CLAUDE_PEERS_HOOK_LOG` | `~/.claude/run/claude-peers-hook.log` | Hook quiet-failure log |
| `OPENAI_API_KEY`     | —                    | Enables auto-summary via gpt-5.4-nano |

## Requirements

- [Bun](https://bun.sh)
- Claude Code v2.1.224+ for native wake (older versions: v2.1.80+ with the development channel and a claude.ai login)
- Codex CLI with `codex queue` and hooks (verified on 0.157.1) for Codex wakes
