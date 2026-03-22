# Bridging Peer Messages to Chat Platforms

The claude-peers broker handles peer-to-peer messaging between agents.
To surface these messages in Telegram, Slack, Discord, or any chat platform,
build a bridge that polls the broker and forwards messages to your platform's
API.

This guide shows the pattern using the `PeersClient` SDK. The bridge runs
as a background process (sidecar, systemd service, cron, etc.) alongside
your agent.

## How It Works

```
Claude Code session
  └→ send_message [channel] text
       └→ broker stores message
            └→ bridge polls broker
                 └→ posts to Telegram/Slack/Discord
                      └→ agent sees message in chat
                           └→ agent responds + sends reply via peers CLI
```

The bridge:
1. Registers as a peer with the broker
2. Polls for new messages every few seconds
3. Parses a `[channel]` prefix to determine which chat group to post to
4. Posts the message to the chat platform via its API
5. Optionally triggers the agent to respond

## Example Bridge

This Node.js script polls the broker and posts to Telegram. Adapt for
Slack, Discord, or any platform with an HTTP API.

```javascript
import { PeersClient } from 'claude-peers/client';

// --- Config ---
const peers = new PeersClient({
  brokerUrl: process.env.CLAUDE_PEERS_URL,
  token: process.env.CLAUDE_PEERS_TOKEN,
  hostname: 'my-agent',
  summary: 'My agent — bridged to Telegram',
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Channel name → chat platform ID
const CHANNELS = {
  general: { chatId: '-100xxxxxxxxxx' },
  dev:     { chatId: '-100xxxxxxxxxx' },
};
const DEFAULT_CHANNEL = 'general';

// --- Routing ---
function parseMessage(text) {
  const match = text.match(/^\[([a-zA-Z0-9_-]+)\]\s*([\s\S]*)/);
  return match
    ? { channel: match[1].toLowerCase(), text: match[2] }
    : { channel: DEFAULT_CHANNEL, text };
}

// --- Telegram ---
async function sendTelegram(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

// --- Main ---
await peers.register({ cwd: process.cwd() });
peers.startHeartbeat();

peers.startPolling(async (msg) => {
  const { channel, text } = parseMessage(msg.text);
  const target = CHANNELS[channel];
  if (!target) {
    console.error(`Unknown channel: ${channel}`);
    return;
  }

  // Look up sender info
  const allPeers = await peers.listPeers('network');
  const sender = allPeers.find(p => p.id === msg.from_id);
  const senderName = sender
    ? `${sender.hostname}/${sender.summary || sender.id}`
    : msg.from_id;

  // Post to Telegram
  const formatted = `📨 <b>Peer message from ${senderName}</b>\n\n${text}`;
  await sendTelegram(target.chatId, formatted);
});

console.log('Bridge running — polling for messages');
```

## Adapting for Other Platforms

### Slack

Replace the Telegram `sendMessage` call with Slack's `chat.postMessage`:

```javascript
async function sendSlack(channel, text) {
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, text }),
  });
}
```

### Discord

Use Discord's webhook URL:

```javascript
async function sendDiscord(webhookUrl, text) {
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text }),
  });
}
```

## Channel Routing

Messages use a `[channel-name]` prefix to target specific chat groups:

```
[dev] Hey, the build is broken — can you check?
[general] Status update: deployment complete
```

If no prefix, messages go to the default channel. The channel map is
configured in the bridge — map friendly names to platform-specific IDs.

Only route to group channels. Never route to private/DM sessions to
avoid hidden agent-to-agent conversations that the operator can't see.

## Deployment

Run the bridge alongside your agent:

- **Kubernetes:** sidecar container in the agent pod
- **Docker:** additional service in docker-compose
- **Systemd:** background service on the agent's machine
- **Screen/tmux:** `node bridge.js &` in a background session

The bridge needs:
- `CLAUDE_PEERS_URL` and `CLAUDE_PEERS_TOKEN` to reach the broker
- Chat platform API token (Telegram bot token, Slack bot token, etc.)
- Network access to both the broker and the chat platform API

## Security

- Route all chat platform API calls through a scanning proxy for DLP
- Only allow group channels — block private/direct sessions
- Make all peer messages visible to the operator in the chat platform
- See [Pipelock Integration Guide](pipelock.md) for scanning setup
