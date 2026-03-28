# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

claude-peers is an MCP (Model Context Protocol) server that enables peer discovery and real-time messaging between Claude Code instances on the same machine. It uses a broker-client architecture where a shared daemon manages peer registration and message routing.

## Commands

```bash
# Install dependencies
bun install

# Run the MCP server (normally spawned by Claude Code, not run directly)
bun server.ts

# Run the broker daemon directly (auto-launched by server.ts if not running)
bun broker.ts

# CLI commands
bun cli.ts status            # Broker status + all peers
bun cli.ts peers             # List peers
bun cli.ts send <id> <msg>   # Send a message to a peer
bun cli.ts kill-broker       # Stop the broker daemon

# Start Claude Code with channel support
claude --dangerously-load-development-channels server:claude-peers

# Run tests
bun test
```

## Architecture

### Broker-Client Model

```
  Claude A ↔ MCP Server A (stdio) ↔ Broker daemon (HTTP + SQLite) ↔ MCP Server B (stdio) ↔ Claude B
```

- **broker.ts** — Singleton HTTP server on `127.0.0.1:7899`. Uses `bun:sqlite` for state (peers table + messages table). Auto-launched by the MCP server via `ensureBroker()`. Cleans stale peers by checking PID liveness every 30s.
- **server.ts** — MCP stdio server, one per Claude Code session. Registers with the broker on startup, polls for messages every 1s, sends heartbeats every 15s. Pushes inbound messages as `notifications/claude/channel` for instant delivery. Unregisters on exit via SIGINT/SIGTERM handlers.
- **shared/types.ts** — All TypeScript interfaces for the broker REST API (RegisterRequest, Peer, Message, etc.).
- **shared/summarize.ts** — Optional auto-summary via OpenAI `gpt-5.4-nano` API. Requires `OPENAI_API_KEY`. Falls back gracefully.
- **cli.ts** — Standalone CLI that talks directly to the broker HTTP API for debugging.
- **index.ts** — Module marker, exports nothing.

### Broker REST API (all POST except /health GET)

| Endpoint          | Purpose                              |
| ----------------- | ------------------------------------ |
| `/register`       | Register a new peer, returns peer ID |
| `/heartbeat`      | Update last_seen timestamp           |
| `/set-summary`    | Update peer's summary text           |
| `/list-peers`     | List peers by scope (machine/directory/repo) |
| `/send-message`   | Queue a message for delivery         |
| `/poll-messages`  | Fetch and mark-delivered unread messages |
| `/unregister`     | Remove peer registration             |
| `/health`         | GET — returns status + peer count    |

### MCP Tools Exposed

`list_peers`, `send_message`, `set_summary`, `check_messages`, `spawn_peers` — defined in server.ts TOOLS array.

- **spawn_peers** — Opens Ghostty terminal splits and starts Claude Code instances with assigned roles. Uses AppleScript API (macOS, Ghostty 1.3+). Spawner logic in `shared/spawner.ts`.

## Key Design Decisions

- **Logging**: MCP stdio servers must use `console.error` (stderr) for logging — stdout is reserved for MCP protocol.
- **Broker auto-launch**: `ensureBroker()` in server.ts spawns the broker as a detached process with `proc.unref()` so it survives MCP server exit.
- **Stale peer cleanup**: Broker uses `process.kill(pid, 0)` to check if peer processes are alive.
- **Channel push**: Messages arrive instantly via `notifications/claude/channel` MCP notification, not tool responses.
- **Summary generation**: Non-blocking on startup — races with a 3s timeout, applies late if slow.

## Runtime & Tooling

- **Bun only** — no Node.js, no npm/yarn/pnpm. Use `bun:sqlite` (not better-sqlite3), `Bun.serve()` (not express), `Bun.spawn()` (not execa).
- Single dependency: `@modelcontextprotocol/sdk`.

## Environment Variables

| Variable            | Default              | Description                           |
| ------------------- | -------------------- | ------------------------------------- |
| `CLAUDE_PEERS_PORT` | `7899`               | Broker port                           |
| `CLAUDE_PEERS_DB`   | `~/.claude-peers.db` | SQLite database path                  |
| `CLAUDE_PEERS_ROLE` | `""`                 | Peer role (e.g. "frontend-dev", "koordinator") |
| `OPENAI_API_KEY`    | —                    | Enables auto-summary via gpt-5.4-nano |
