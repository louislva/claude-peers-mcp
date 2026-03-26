# Setting Up Peer-Aware Autonomous Execution

Add multi-session parallel execution to any GSD project. The orchestrator discovers peer Claude Code instances, dispatches phase execution in parallel, routes discuss-phase choices through a decision proxy, and falls back to standard sequential mode when no peers are available.

## Prerequisites

- [Bun](https://bun.sh) installed
- GSD installed in the target project (`.claude/get-shit-done/` exists)
- A `.planning/ROADMAP.md` with phases defined
- This repo cloned somewhere on your machine

## 1. Start the Broker

The broker is a lightweight HTTP daemon on localhost that manages peer discovery and messaging.

```bash
# From this repo
bun /path/to/claude-peers-mcp/broker.ts &
```

Or let the MCP server auto-launch it (see step 2).

Verify it's running:
```bash
curl http://localhost:7899/health
```

## 2. Add the MCP Server to Your Project

In your target project, create or edit `.mcp.json`:

```json
{
  "mcpServers": {
    "claude-peers": {
      "command": "bun",
      "args": ["/absolute/path/to/claude-peers-mcp/server.ts"]
    }
  }
}
```

This gives every Claude Code session in the project access to `list_peers`, `send_message`, `set_summary`, and `check_messages` tools. The MCP server auto-launches the broker if it isn't running.

## 3. Copy the GSD Plugin

Copy the `gsd-plugin/` directory into your target project:

```bash
cp -r /path/to/claude-peers-mcp/gsd-plugin /path/to/your-project/gsd-plugin
```

This includes:
- `executor/executor-helpers.ts` — executor protocol functions
- `proxy/proxy-helpers.ts` — proxy protocol functions
- `orchestrator/orchestrator-helpers.ts` — orchestrator protocol functions
- `autonomous-peers-runtime.ts` — standalone Kahn's sort + wave polling
- `agents/gsd-executor.md` — executor agent instructions
- `agents/gsd-proxy.md` — proxy agent instructions
- `agents/gsd-orchestrator.md` — orchestrator agent instructions
- `workflows/autonomous-peers.md` — workflow reference doc

## 4. Add the Slash Command

Copy the command entry point:

```bash
mkdir -p /path/to/your-project/.claude/commands
cp /path/to/claude-peers-mcp/.claude/commands/autonomous-peers.md \
   /path/to/your-project/.claude/commands/
```

You can now invoke `/autonomous-peers` from Claude Code in the target project.

## 5. Running It

### Solo (Sequential Fallback)

Just run the command — with no peers present, it falls back to standard `/gsd:autonomous`:

```
/autonomous-peers
```

### With Peers (Parallel Execution)

Open 2-3 terminals in the same repo:

**Terminal 1 — Decision Proxy:**
```
claude
> Read gsd-plugin/agents/gsd-proxy.md and follow the instructions
```
The proxy sets its summary to identify itself and waits for discuss-phase questions.

**Terminal 2 — Executor:**
```
claude
> Read gsd-plugin/agents/gsd-executor.md and follow the instructions
```
The executor sets its summary and waits for `execute_phase` messages.

**Terminal 3 — Orchestrator:**
```
claude
> /autonomous-peers
```
The orchestrator discovers the peers, builds execution waves, and dispatches work.

### Verifying Peers Are Connected

```bash
# From any terminal
curl -s http://localhost:7899/health
# Shows: {"status":"ok","peers":3}

curl -s -X POST http://localhost:7899/peer-availability \
  -H 'Content-Type: application/json' \
  -d '{"repo":"/path/to/your-project"}'
# Shows proxy and executor classification
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_PEERS_PORT` | `7899` | Broker HTTP port |
| `CLAUDE_PEERS_DB` | `~/.claude-peers.db` | SQLite database path |

### Broker Management

```bash
bun /path/to/claude-peers-mcp/cli.ts status   # Broker status + peers
bun /path/to/claude-peers-mcp/cli.ts peers     # List all peers
bun /path/to/claude-peers-mcp/cli.ts kill-broker  # Stop the broker
```

## How It Works

1. **Orchestrator** calls `/peer-availability` to discover peers in the same repo
2. Peers with "decision proxy" in their summary → proxy role (at most one)
3. All other available peers → executor role
4. Orchestrator reads `ROADMAP.md`, builds dependency graph (Kahn's algorithm), groups into waves
5. For each wave: plan phases sequentially, then dispatch execution to executors in parallel
6. Discuss-phase choices routed through proxy (60s timeout, falls back to recommended default)
7. Unresponsive executors reclaimed after 120s silence + 30s status request timeout
8. After all waves: verify, complete milestone

If zero peers are found at step 1, the orchestrator runs standard `/gsd:autonomous` instead — same outcome, just sequential.
