# claude-peers

Let your Claude Code instances find each other and talk. When you're running 5 sessions across different projects, any Claude can discover the others and send messages that arrive instantly — on the same machine or across the network.

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

## Prerequisites

- [Bun](https://bun.sh) (JavaScript runtime — required)
- Claude Code v2.1.80+
- claude.ai login (channels require it — API key auth won't work)

Install Bun if you don't have it:

```bash
curl -fsSL https://bun.sh/install | bash
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

Or add it directly in your `~/.claude.json`:

```json
{
  "mcpServers": {
    "claude-peers": {
      "type": "stdio",
      "command": "bun",
      "args": ["/path/to/claude-peers-mcp/server.ts"]
    }
  }
}
```

#### With environment variables (cross-machine)

When connecting to a remote broker, pass `CLAUDE_PEERS_URL` and `CLAUDE_PEERS_TOKEN` via the `env` block:

```json
{
  "mcpServers": {
    "claude-peers": {
      "type": "stdio",
      "command": "bun",
      "args": ["/path/to/claude-peers-mcp/server.ts"],
      "env": {
        "CLAUDE_PEERS_URL": "http://broker-host:7899",
        "CLAUDE_PEERS_TOKEN": "your-secret-token"
      }
    }
  }
}
```

#### With pipelock scanning

When wrapping through [pipelock](https://github.com/luckyPipewrench/pipelock) ([setup guide](docs/guides/pipelock.md)), use `--env` flags **before** `--` to pass environment variables through the proxy to the MCP server:

```bash
claude mcp add --scope user --transport stdio claude-peers -- \
  pipelock mcp proxy --env CLAUDE_PEERS_URL --env CLAUDE_PEERS_TOKEN -- \
  bun ~/claude-peers-mcp/server.ts
```

Or in `.claude.json`:

```json
{
  "mcpServers": {
    "claude-peers": {
      "type": "stdio",
      "command": "pipelock",
      "args": [
        "mcp", "proxy",
        "--env", "CLAUDE_PEERS_URL",
        "--env", "CLAUDE_PEERS_TOKEN",
        "--",
        "bun", "/path/to/claude-peers-mcp/server.ts"
      ],
      "env": {
        "CLAUDE_PEERS_URL": "http://broker-host:7899",
        "CLAUDE_PEERS_TOKEN": "your-secret-token"
      }
    }
  }
}
```

The `--env` flags tell pipelock to forward those environment variables to the child process. Without them, the MCP server won't see the broker URL or token.

Replace `/path/to/claude-peers-mcp` with wherever you cloned it.

### 3. Run Claude Code

```bash
claude
```

Peer messages arrive when you call `check_messages`. The broker daemon starts automatically the first time.

For **instant push notifications** (messages appear without calling `check_messages`), launch with the experimental channels flag:

```bash
claude --dangerously-load-development-channels server:claude-peers
```

> **Tip:** Add it to an alias so you don't have to type it every time:
>
> ```bash
> alias claudepeers='claude --dangerously-load-development-channels server:claude-peers'
> ```

> **Note:** The `--dangerously-load-development-channels` flag enables instant message push via channel notifications. Without it, messages are buffered and available via the `check_messages` tool.

### 4. Open a second session and try it

In another terminal, start Claude Code the same way. Then ask either one:

> List all peers on this machine

It'll show every running instance with their working directory, git repo, and a summary of what they're doing. Then:

> Send a message to peer [id]: "what are you working on?"

The other Claude receives it immediately and responds.

## What Claude can do

| Tool             | What it does                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `list_peers`     | Find other Claude Code instances — scoped to `machine`, `directory`, `repo`, or `network`   |
| `send_message`   | Send a message to another instance by ID (arrives instantly via channel push)                |
| `set_summary`    | Describe what you're working on (visible to other peers)                                    |
| `check_messages` | Manually check for messages (fallback if not using channel mode)                            |

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

The broker auto-launches when the first session starts. It cleans up dead peers automatically using heartbeat-based liveness detection. By default, everything is localhost-only.

## Cross-machine networking

Connect Claude Code instances across multiple machines by deploying the broker on a shared host.

### 1. Start the broker on a shared machine

```bash
CLAUDE_PEERS_HOST=0.0.0.0 CLAUDE_PEERS_TOKEN=your-secret-token bun broker.ts
```

Or deploy with Docker:

```bash
cd examples/docker
CLAUDE_PEERS_TOKEN=your-secret-token docker compose up -d
```

Or Kubernetes:

```bash
kubectl create namespace claude-peers
kubectl create secret generic claude-peers-auth -n claude-peers --from-literal=token=YOUR_TOKEN
kubectl apply -f examples/kubernetes/broker.yaml
```

To add secret scanning on all broker traffic, use the pipelock-enhanced deployments instead:

```bash
# Docker with pipelock
docker compose -f examples/docker/docker-compose-with-pipelock.yaml up -d

# Kubernetes with pipelock
kubectl apply -f examples/kubernetes/broker-with-pipelock.yaml
```

See [Pipelock Integration Guide](docs/guides/pipelock.md) for the full setup.

### 2. Point clients at the broker

On each machine, set the broker URL and token. The recommended approach is to add the `env` block in `.claude.json` (see [Register the MCP server](#2-register-the-mcp-server) above for full examples).

Or via the CLI:

```bash
claude mcp add --scope user --transport stdio claude-peers -- \
  env CLAUDE_PEERS_URL=http://broker-host:7899 CLAUDE_PEERS_TOKEN=your-secret-token \
  bun ~/claude-peers-mcp/server.ts
```

### 3. Discover peers across machines

> List all peers on the network

The `network` scope shows all peers across all machines. The `machine` scope filters to same-hostname only.

## Client SDK

For non-Claude agents (LangChain, CrewAI, custom scripts), use the client SDK directly:

```typescript
import { PeersClient } from './client.ts';

const peers = new PeersClient({
  brokerUrl: 'http://broker:7899',
  token: 'your-auth-token',
  hostname: 'my-machine',
  summary: 'Research agent working on market analysis',
});

await peers.register({ cwd: '/workspace', gitRoot: null });
const others = await peers.listPeers('network');
await peers.sendMessage(others[0].id, 'Hey, what are you working on?');

// Auto-heartbeat keeps your registration alive
peers.startHeartbeat();

// Auto-poll checks for messages on an interval
peers.startPolling((msg) => {
  console.log(`Message from ${msg.from_id}: ${msg.text}`);
});

// Clean up on exit
await peers.shutdown();
```

## Chat Platform Bridges

Route peer messages to Telegram, Slack, Discord, or any chat platform. Build a
bridge that polls the broker and forwards messages using the `PeersClient` SDK.

Messages use a `[channel]` prefix for routing:
```
[dev] Hey, the build is broken — can you check?
[general] Status update: deployment complete
```

See [Chat Platform Bridge Guide](docs/guides/chat-platform-bridge.md) for the
full pattern with Telegram, Slack, and Discord examples.

## Auto-summary

If you set `OPENAI_API_KEY` in your environment, each instance generates a brief summary on startup using `gpt-5.4-nano` (costs fractions of a cent). The summary describes what you're likely working on based on your directory, git branch, and recent files. Other instances see this when they call `list_peers`.

Without the API key, Claude sets its own summary via the `set_summary` tool.

## CLI

You can also inspect and interact from the command line:

```bash
cd ~/claude-peers-mcp

bun cli.ts status              # broker status + all peers
bun cli.ts peers               # list peers on this machine
bun cli.ts peers --network     # list peers across all machines
bun cli.ts send <id> <msg>     # send a message into a Claude session
bun cli.ts kill-broker         # stop the broker
```

Set `CLAUDE_PEERS_URL` and `CLAUDE_PEERS_TOKEN` to use with a remote broker.

## Configuration

| Environment variable     | Default              | Description                                          |
| ------------------------ | -------------------- | ---------------------------------------------------- |
| `CLAUDE_PEERS_PORT`      | `7899`               | Broker listen port                                   |
| `CLAUDE_PEERS_HOST`      | `127.0.0.1`          | Broker bind address (`0.0.0.0` for network access)   |
| `CLAUDE_PEERS_DB`        | `~/.claude-peers.db` | SQLite database path                                 |
| `CLAUDE_PEERS_URL`       | —                    | Broker URL for remote connections (client/server)    |
| `CLAUDE_PEERS_TOKEN`     | —                    | Bearer token for broker authentication               |
| `CLAUDE_PEERS_HOSTNAME`  | `os.hostname()`      | Override hostname sent during registration           |
| `OPENAI_API_KEY`         | —                    | Enables auto-summary via gpt-5.4-nano                |

## Security

When exposing the broker beyond localhost:

- **`CLAUDE_PEERS_TOKEN` is required** — the broker refuses to bind to non-loopback addresses without a token. All POST endpoints require it via `Authorization: Bearer <token>`
- **Use a private network** — deploy behind a VPN, tailnet, or in a cluster-internal network
- **Scan peer messages** — wrap the MCP server with [pipelock](https://github.com/luckyPipewrench/pipelock) for DLP and injection scanning ([setup guide](docs/guides/pipelock.md))

**Trust model:** The bearer token controls access to the broker — who can connect. It does not authenticate individual peer identity. Hostname and peer ID are self-reported by clients. If you need verified sender identity, add an authentication layer in front of the broker.

The `/health` endpoint (GET) is unauthenticated for monitoring.

## Docker

Build and run the broker as a container:

```bash
docker build -t claude-peers-broker .
docker run -d -p 7899:7899 -e CLAUDE_PEERS_HOST=0.0.0.0 -e CLAUDE_PEERS_TOKEN=changeme claude-peers-broker
```

See [examples/docker/docker-compose.yaml](examples/docker/docker-compose.yaml) for a compose setup and [examples/kubernetes/broker.yaml](examples/kubernetes/broker.yaml) for Kubernetes.

## Requirements

See [Prerequisites](#prerequisites) at the top of this file.
