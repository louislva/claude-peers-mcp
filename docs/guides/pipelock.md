# Scanning Peer Messages with Pipelock

[Pipelock](https://github.com/luckyPipewrench/pipelock) is an agent firewall
that scans MCP traffic for secret exfiltration and prompt injection. Wrapping
the claude-peers MCP server through pipelock adds automatic scanning to all
peer messages — outbound messages are checked for leaked secrets, inbound
messages are checked for injection attempts.

## Setup

Wrap the MCP server when registering with Claude Code:

```bash
claude mcp add claude-peers -- \
  pipelock mcp proxy --config pipelock.yaml -- \
  bun ~/claude-peers-mcp/server.ts
```

Or in `.claude.json`:

```json
{
  "claude-peers": {
    "type": "stdio",
    "command": "pipelock",
    "args": [
      "mcp", "proxy",
      "--config", "pipelock.yaml",
      "--env", "CLAUDE_PEERS_URL",
      "--env", "CLAUDE_PEERS_TOKEN",
      "--",
      "bun", "server.ts"
    ],
    "env": {
      "CLAUDE_PEERS_URL": "http://broker-host:7899",
      "CLAUDE_PEERS_TOKEN": "your-token"
    }
  }
}
```

Use `--env` flags to pass broker credentials through to the MCP server.

## Example Config

```yaml
# pipelock.yaml
mode: balanced
enforce: true

dlp:
  action: block

response_scanning:
  action: warn

mcp_input_scanning:
  enabled: true
  action: block

mcp_tool_scanning:
  enabled: true
  action: block
```

## What Gets Scanned

| Direction | Tool | Scanning |
|-----------|------|----------|
| Outbound | `send_message` | DLP checks message text for secrets |
| Inbound | `check_messages` | Injection detection on received messages |
| Startup | `list_peers` | Tool definition integrity check |

## Learn More

- [Pipelock documentation](https://pipelab.org/pipelock/)
- [Pipelock GitHub](https://github.com/luckyPipewrench/pipelock)
