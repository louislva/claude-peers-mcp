# Scanning Peer Messages with Pipelock

[Pipelock](https://github.com/luckyPipewrench/pipelock) is an agent firewall
that scans HTTP and MCP traffic for secret exfiltration and prompt injection.

Peer-to-peer messages between AI agents carry natural language that could
contain leaked secrets (API keys, credentials) or injection payloads. Pipelock
scans this traffic at multiple layers depending on your deployment.

## Layer 1: MCP Proxy (Claude Code sessions)

Wrap the claude-peers MCP server through pipelock. Every tool call is scanned:
outbound `send_message` text is checked for secrets, inbound `check_messages`
results are checked for injection.

```bash
claude mcp add claude-peers -- \
  pipelock mcp proxy --config pipelock.yaml \
  --env CLAUDE_PEERS_URL --env CLAUDE_PEERS_TOKEN -- \
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

### MCP Config

```yaml
# pipelock.yaml — MCP proxy scanning
mode: balanced
enforce: true

# Scan tool call arguments (send_message text)
mcp_input_scanning:
  enabled: true
  action: block

# Scan tool results (check_messages responses)
response_scanning:
  action: warn

# Detect tool definition poisoning
mcp_tool_scanning:
  enabled: true
  action: block
```

### What Gets Scanned

| Direction | Tool | Scanning |
|-----------|------|----------|
| Outbound | `send_message` | DLP checks message text for secrets |
| Inbound | `check_messages` | Injection detection on received messages |
| Startup | `list_peers` | Tool definition integrity check |

## Layer 2: Reverse Proxy (Broker)

Run pipelock as a sidecar in front of the broker. All HTTP POST bodies
(message text, registration data) are scanned for DLP patterns before
reaching the broker.

This catches secrets from any client — not just pipelock-wrapped ones.

### Kubernetes

```yaml
containers:
  - name: pipelock
    image: ghcr.io/luckypipewrench/pipelock:latest
    args:
      - "run"
      - "--listen=127.0.0.1:18888"
      - "--reverse-proxy"
      - "--reverse-upstream=http://127.0.0.1:7899"
      - "--reverse-listen=:8888"
      - "--config=/etc/pipelock/pipelock.yaml"
    ports:
      - containerPort: 8888
  - name: broker
    image: ghcr.io/louislva/claude-peers-broker:latest
    env:
      - name: CLAUDE_PEERS_HOST
        value: "127.0.0.1"  # Only accepts traffic from pipelock
      - name: CLAUDE_PEERS_TOKEN
        valueFrom:
          secretKeyRef:
            name: claude-peers-auth
            key: token
```

Point the Service `targetPort` at pipelock (8888), not the broker (7899).
The broker binds to localhost — all external traffic goes through pipelock.

### Docker Compose

```yaml
services:
  pipelock:
    image: ghcr.io/luckypipewrench/pipelock:latest
    command:
      - "run"
      - "--listen=127.0.0.1:18888"
      - "--reverse-proxy"
      - "--reverse-upstream=http://broker:7899"
      - "--reverse-listen=:8888"
    ports:
      - "7899:8888"
    volumes:
      - ./pipelock.yaml:/etc/pipelock/pipelock.yaml:ro
  broker:
    build: .
    environment:
      CLAUDE_PEERS_HOST: "0.0.0.0"
      CLAUDE_PEERS_TOKEN: "${CLAUDE_PEERS_TOKEN}"
    expose:
      - "7899"
```

### Reverse Proxy Config

```yaml
# pipelock.yaml — reverse proxy scanning
mode: balanced
enforce: true

# Scan POST bodies for secrets
request_body_scanning:
  enabled: true
  action: block

# Scan responses for injection
response_scanning:
  action: warn

# DLP patterns (includes API keys, credit cards, etc.)
dlp:
  scan_env: false
  include_defaults: true

# Disable unused proxy modes
fetch_proxy:
  enabled: false
forward_proxy:
  enabled: false
```

## Layer 3: HTTPS Proxy (Non-Claude agents)

For agents that call the broker over HTTPS or make external API calls
(e.g., forwarding messages to Telegram, Slack, Discord), route traffic
through pipelock's forward proxy with TLS interception.

```bash
# Agent environment
export HTTPS_PROXY=http://localhost:8888
export HTTP_PROXY=http://localhost:8888
export NODE_EXTRA_CA_CERTS=/path/to/pipelock-ca.pem  # Trust pipelock's TLS CA
```

This scans all outbound HTTPS traffic from the agent, including:
- Broker API calls (message text in POST bodies)
- Chat platform API calls (Telegram, Slack, Discord)
- Any external HTTP the agent makes

## Full Stack

For maximum coverage, combine all three layers:

```
Claude Code session
  └→ pipelock MCP proxy (Layer 1: DLP on tool calls)
       └→ broker service
            └→ pipelock reverse proxy (Layer 2: DLP on all POST bodies)
                 └→ broker process

Non-Claude agent
  └→ pipelock HTTPS proxy (Layer 3: TLS interception + DLP)
       └→ broker service
            └→ pipelock reverse proxy (Layer 2: DLP on all POST bodies)
                 └→ broker process
```

Every message is scanned at least once (Layer 2). Claude Code sessions get
double scanning (Layer 1 + Layer 2). External agents with HTTPS proxy get
triple scanning (Layer 3 + Layer 2 on broker, plus Layer 3 on outbound
chat platform calls).

## Learn More

- [Pipelock documentation](https://pipelab.org/pipelock/)
- [Pipelock GitHub](https://github.com/luckyPipewrench/pipelock)
