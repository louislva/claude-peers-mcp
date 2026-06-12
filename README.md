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

The other Claude receives it immediately and responds.

## What Claude can do

| Tool             | What it does                                                                   |
| ---------------- | ------------------------------------------------------------------------------ |
| `list_peers`     | Find other Claude Code instances — scoped to `machine`, `directory`, or `repo` |
| `send_message`   | Send a message to another instance by ID (arrives instantly via channel push)  |
| `set_summary`    | Describe what you're working on (visible to other peers)                       |
| `check_messages` | Manually check for messages (fallback if not using channel mode)               |

## Sessions without channel support (daemon/background sessions)

Channel push only reaches sessions launched with the
`--dangerously-load-development-channels` flag. Sessions started other ways —
notably daemon-hosted "claude agents" sessions — load the MCP server fine but
silently drop channel notifications. For those, install the delivery hook,
which delivers pending messages at turn boundaries (and knows from the session
transcript which messages already arrived via channel, so nothing is ever
delivered twice or lost):

```jsonc
// ~/.claude/settings.json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command",
      "command": "bun /path/to/claude-peers-mcp/hooks/claude-peers-hook.ts" }] }],
    "Stop": [{ "hooks": [{ "type": "command",
      "command": "bun /path/to/claude-peers-mcp/hooks/claude-peers-hook.ts" }] }]
  }
}
```

Delivery is ack-based end to end: a message is only marked delivered once a
consumer that can actually confirm it (the hook, `check_messages`, or the
opencode plugin) takes it. An unheard push is always recoverable.

## How it works

A **broker daemon** runs on `localhost:7899` with a SQLite database. Each Claude Code session spawns an MCP server that registers with the broker and polls for messages every second. Inbound messages are pushed into the session via the [claude/channel](https://code.claude.com/docs/en/channels-reference) protocol, so Claude sees them immediately.

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

The broker auto-launches when the first session starts. It cleans up dead peers automatically. Everything is localhost-only.

## Auto-summary

If you set `OPENAI_API_KEY` in your environment, each instance generates a brief summary on startup using `gpt-5.4-nano` (costs fractions of a cent). The summary describes what you're likely working on based on your directory, git branch, and recent files. Other instances see this when they call `list_peers`.

Without the API key, Claude sets its own summary via the `set_summary` tool.

## opencode support

opencode can join the peer network too, with full two-way messaging. Sending
works out of the box (tools are plain MCP), but opencode can't receive
`claude/channel` notifications — inbound delivery is handled by a small
opencode plugin instead, which polls the broker and injects messages into the
active session via opencode's server API (queued while the agent is mid-turn,
flushed when it goes idle).

### 1. Register the MCP server

In `~/.config/opencode/opencode.jsonc`:

```jsonc
"mcp": {
  "claude-peers": {
    "type": "local",
    "command": ["bun", "/path/to/claude-peers-mcp/server.ts"],
    "enabled": true
  }
}
```

### 2. Install the plugin

```bash
mkdir -p ~/.config/opencode/plugins
ln -s /path/to/claude-peers-mcp/opencode-plugin.ts ~/.config/opencode/plugins/claude-peers.ts
```

That's it — restart opencode. The plugin finds this session's peer identity by
matching the broker's registered PIDs against opencode's process tree, so no
ports or IDs need configuring. Messages arrive formatted exactly like Claude
Code's channel messages. Without the plugin, the agent can still receive by
calling `check_messages` manually (the MCP server detects non-Claude clients
and leaves the queue intact for them).

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
