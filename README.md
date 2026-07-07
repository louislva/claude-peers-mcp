# claude-peers

Let your Claude Code, Codex, and Gemini CLI instances find each other and talk. When you're running 5 sessions across different projects, any peer can discover the others and send messages through a local broker.

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

```bash
claude
```

That's it. The broker daemon starts automatically the first time.

### 4. Open a second session and try it

In another terminal, start Claude Code the same way. Then ask either one:

> List all peers on this machine

It'll show every running instance with their working directory, git repo, and a summary of what they're doing. Then:

> Send a message to peer [id]: "what are you working on?"

Claude peers receive through the MCP poll buffer, tool-response piggyback, `check_messages`, and the optional Claude hook/standby path. Codex and Gemini peers receive automatically on their next prompt when their hook is installed; without that hook they use `check_messages`.

## What peers can do

| Tool             | What it does                                                                   |
| ---------------- | ------------------------------------------------------------------------------ |
| `list_peers`     | Find other Claude/Codex/Gemini peers — scoped to `machine`, `directory`, or `repo` |
| `send_message`   | Send a message to another peer by ID                                           |
| `set_summary`    | Describe what you're working on (visible to other peers)                       |
| `check_messages` | Manually check for messages (fallback and Codex-without-hook path)             |
| `inspect_peer_pane` | Read the last lines from a peer's tmux pane without writing to it           |

## Delivery matrix

| Receiver | Mode shown in `list_peers` | Delivery behavior |
| --- | --- | --- |
| Claude Code | `claude/claude-channel` | MCP poll buffer plus tool-response/check fallback; installed hooks can drain before prompts and wake standby sessions |
| Codex with hooks installed | `codex/codex-hook` | Registers at `SessionStart`; drains pending messages into the next `UserPromptSubmit` turn |
| Codex without hook or stale hook | `codex/manual-drain` | Message stays queued until `check_messages` or hook install |
| Gemini with hooks installed | `gemini/gemini-hook` | Registers at `SessionStart`; drains pending messages into the next `BeforeAgent` turn |
| Gemini without hook or stale hook | `gemini/manual-drain` | Message stays queued until `check_messages` or hook install |
| Unknown client | `unknown/unknown` | Manual `check_messages` fallback |

## How it works

A **broker daemon** runs on `localhost:7899` with a SQLite database. Claude Code sessions register through the MCP server. Codex and Gemini can register immediately from lightweight `SessionStart` hooks, then claim pending messages from prompt/run hooks. Claude sessions keep a local poll buffer and expose `check_messages`; Codex and Gemini do not have a push channel, so their hooks emit queued mail as additional context only when a normal turn starts.

The broker is the only queue and delivery authority. Hooks and standby watchers are thin drain clients; they do not create a second broker or call an LLM while waiting.

```
                    ┌───────────────────────────┐
                    │  broker daemon            │
                    │  localhost:7899 + SQLite  │
                    └──────┬───────────────┬────┘
                           │               │
                      MCP server A    MCP server B
                      (stdio)         (stdio)
                           │               │
                      Claude A         Claude B / Codex / Gemini
```

The broker auto-launches when the first session starts. It cleans up dead peers automatically. Everything is localhost-only. Startup registration makes new Codex/Gemini sessions visible to peers without a first nudge, but it does not wake an idle model or type into tmux.

## Read-only tmux context

When peers are registered from tmux, claude-peers stores their tmux pane id. Use `inspect_peer_pane` to read the last lines from that pane before deciding whether to interrupt or route work there. The tool is read-only: it uses `tmux capture-pane`, strips terminal control sequences, caps output to 8 KB, and never calls `send-keys`.

`send_message` also accepts `include_tmux_context: true`. That captures the target pane before sending and returns the snapshot alongside the send result. The captured text is not inserted into the broker message body.

## Prompt hook install

The repo includes Codex `SessionStart` and `UserPromptSubmit` hooks at `.codex/hooks.json` for sessions launched from this repo. For another repo, install without overwriting existing hooks:

```bash
bun /home/manzo/claude-peers-mcp/bin/install-codex-hook.ts /path/to/repo
```

The installer merges startup registration plus inbox drain hooks into `.codex/hooks.json`, writes a timestamped backup if one already exists, and is idempotent.

For Gemini CLI repos:

```bash
bun /home/manzo/claude-peers-mcp/bin/install-gemini-hook.ts /path/to/repo
```

The Gemini installer merges `SessionStart` registration plus `BeforeAgent` inbox drain hooks into `.gemini/settings.json`, preserves existing MCP server configuration, writes a timestamped backup when needed, and is idempotent.

## Claude standby

Claude Code can also use user-level hooks:

- `UserPromptSubmit` drains before the next prompt.
- `Stop` with `asyncRewake: true` can poll the broker while Claude is idle and wake the session only when mail arrives.

That standby loop is token-efficient because empty polls stay outside the model. The hook emits context only after the broker returns messages.

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
| `CLAUDE_PEERS_DEAD_MAIL_TTL_MS` | `86400000` (24h) | How long a dead seat's undelivered mail is preserved (inheritable by a returning session) before the row + mail are reaped. Floored at 1h. |
| `CLAUDE_PEERS_DELIVERED_MSG_TTL_MS` | `604800000` (7d) | How long delivered messages are retained before the periodic sweep purges them. |

## Diagnosing orphans / "broker down"

A peer reporting "broker is down" is usually **not** a broker outage — check `/health` first (`curl -s http://127.0.0.1:7899/health`); the broker normally runs for days. The two real failure modes:

- **Orphan flood:** a session re-spawned its MCP server without killing the old one, and the old one's token was reclaimed → it 401s on every heartbeat. **The reliable signal is the auth-fail rate in `~/.claude-peers-broker.log`** (`grep -c 'auth fail'`), not a process count. A leftover server now self-reaps after continuous 401s; a same-seat live duplicate is superseded on the next register.
- Do **not** use "live `server.ts` pids not in the peers table" as a ghost count — it over-counts, because one session legitimately spawns several `bun server.ts`-matching processes and only one is the registered pid.

## Requirements

- [Bun](https://bun.sh)
- Claude Code v2.1.80+
- Codex CLI or Gemini CLI for non-Claude peers
