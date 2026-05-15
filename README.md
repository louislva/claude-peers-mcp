# claude-peers

Let your Claude Code and Codex instances find each other and talk. When you're running 5 sessions across different projects, any peer can discover the others and send messages through a local broker.

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

### 4. Open a second session and try it

In another terminal, start Claude Code the same way. Then ask either one:

> List all peers on this machine

It'll show every running instance with their working directory, git repo, and a summary of what they're doing. Then:

> Send a message to peer [id]: "what are you working on?"

Claude peers receive through the Claude channel path. Codex peers receive automatically on their next prompt when the Codex hook is installed; without that hook they use `check_messages`.

## What peers can do

| Tool             | What it does                                                                   |
| ---------------- | ------------------------------------------------------------------------------ |
| `list_peers`     | Find other Claude/Codex peers — scoped to `machine`, `directory`, or `repo`    |
| `send_message`   | Send a message to another peer by ID                                           |
| `set_summary`    | Describe what you're working on (visible to other peers)                       |
| `check_messages` | Manually check for messages (fallback and Codex-without-hook path)             |

## Delivery matrix

| Receiver | Mode shown in `list_peers` | Delivery behavior |
| --- | --- | --- |
| Claude Code with channel | `claude/claude-channel` | Best-effort channel push plus tool-response/check fallback |
| Codex with hook installed and recently run | `codex/codex-hook` | Drains pending messages into the next `UserPromptSubmit` turn |
| Codex without hook or stale hook | `codex/manual-drain` | Message stays queued until `check_messages` or hook install |
| Unknown client | `unknown/unknown` | Manual `check_messages` fallback |

## How it works

A **broker daemon** runs on `localhost:7899` with a SQLite database. Each Claude Code or Codex session spawns an MCP server that registers with the broker and polls for messages every second. Inbound messages for Claude are pushed into the session via the [claude/channel](https://code.claude.com/docs/en/channels-reference) protocol. Codex does not render Claude channel notifications, so Codex uses a `UserPromptSubmit` hook that claims pending messages, emits them as additional prompt context, and ACKs the broker after writing the hook output.

```
                    ┌───────────────────────────┐
                    │  broker daemon            │
                    │  localhost:7899 + SQLite  │
                    └──────┬───────────────┬────┘
                           │               │
                      MCP server A    MCP server B
                      (stdio)         (stdio)
                           │               │
                      Claude A         Claude B / Codex B
```

The broker auto-launches when the first session starts. It cleans up dead peers automatically. Everything is localhost-only.

## Codex hook install

The repo includes a Codex `UserPromptSubmit` hook at `.codex/hooks.json` for sessions launched from this repo. For another repo, install without overwriting existing hooks:

```bash
bun /home/manzo/claude-peers-mcp/bin/install-codex-hook.ts /path/to/repo
```

The installer merges the hook into `.codex/hooks.json`, writes a timestamped backup if one already exists, and is idempotent.

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
