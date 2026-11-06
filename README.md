# claude-peers

Let Claude Code and Codex sessions discover peers and exchange durable messages.

This local fork uses **protocol 2**: fetch offers messages; explicit acknowledgement
confirms receipt. Offline inboxes survive process death and can be resumed with a
verified session key. GUI delivery uses session-bound hooks; fully idle wakeup is
not guaranteed. See [current GUI integration](docs/codex-integration.md) and the
[repair and validation record](docs/research/2026-09-19-reliable-inboxes.md).

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

### 3. Run Claude Code with the channel

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers
```

That's it. The broker daemon starts automatically the first time.

> **Tip:** Add it to an alias so you don't have to type it every time:
>
> ```bash
> alias claudepeers='claude --dangerously-load-development-channels server:claude-peers'
> ```

> **GUI sessions:** the desktop app can't pass that flag, and a channel there
> requires a plugin on Anthropic's remote allowlist. This repo ships plugin
> packaging (`.claude-plugin/` + `plugin/`) that gets as far as the packaging
> allows; see [`docs/plugin.md`](docs/plugin.md) for the install steps, the
> double-registration caveat, and why GUI push is still blocked.

### 4. Open a second session and try it

In another terminal, start Claude Code the same way. Then ask either one:

> List all peers on this machine

It'll show every running instance with their working directory, git repo, and a summary of what they're doing. Then:

> Send a message to peer [id]: "what are you working on?"

The receiving client offers it through supported channels, hooks, or an inbox check, then explicitly acknowledges receipt.

## What Claude can do

| Tool             | What it does                                                                   |
| ---------------- | ------------------------------------------------------------------------------ |
| `list_peers`     | Find other Claude Code instances — scoped to `machine`, `directory`, or `repo` |
| `send_message`   | Send a message to another instance by ID (stored until explicitly acknowledged)  |
| `set_summary`    | Describe what you're working on (visible to other peers)                       |
| `check_messages` | Read pending messages, including previously offered unacknowledged messages |
| `acknowledge_messages` | Confirm receipt of message IDs after reading them |
| `bind_session` | Bind this connection to a verified GUI session ID |
| `recover_inbox` | Explicitly recover pending mail from a verified offline inbox |

For clients that do not advertise `experimental["claude/channel"]`, the server now skips the background inbox poller so hooks or `check_messages` can offer them. Neither fetching nor pushing acknowledges receipt.

## How it works

A **broker daemon** runs on `localhost:7899` with a SQLite database. Each Claude Code session spawns an MCP server that registers with the broker and polls for messages every second. When channel support is negotiated, the server offers inbound messages via [claude/channel](https://code.claude.com/docs/en/channels-reference). Other clients use hooks or manual inbox reads. A channel write is not an acknowledgement.

```
                    ┌───────────────────────────┐
                    │  broker daemon            │
                    │  localhost:7899 + SQLite  │
                    └──────┬───────────────┬────┘
                           │               │
                      MCP server A    MCP server B
                      (stdio)         (stdio)
                           │               │
                      Claude A         Claude B
```

The broker auto-launches when the first session starts. It marks dead peers offline and retains their inboxes. Everything is localhost-only.

## Auto-summary

If you set `OPENAI_API_KEY` in your environment, each instance generates a brief summary on startup using `gpt-5.4-nano` (costs fractions of a cent). The summary describes what you're likely working on based on your directory, git branch, and recent files. Other instances see this when they call `list_peers`.

Without the API key, Claude sets its own summary via the `set_summary` tool.

## CLI

You can also inspect and interact from the command line:

```bash
cd ~/claude-peers-mcp

bun cli.ts status            # broker status + all peers
bun cli.ts peers             # list peers
bun cli.ts send <id> <msg>   # send a message into a Claude session
bun cli.ts kill-broker       # stop the broker
```

## Configuration

| Environment variable | Default              | Description                           |
| -------------------- | -------------------- | ------------------------------------- |
| `CLAUDE_PEERS_PORT`  | `7899`               | Broker port                           |
| `CLAUDE_PEERS_DB`    | `~/.claude-peers.db` | SQLite database path                  |
| `OPENAI_API_KEY`     | —                    | Enables auto-summary via gpt-5.4-nano |

## Requirements

- [Bun](https://bun.sh)
- Claude Code v2.1.80+
- claude.ai login (channels require it — API key auth won't work)
