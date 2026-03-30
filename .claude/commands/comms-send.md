---
name: comms-send
description: "Send a message to a claude-peers instance"
allowed-tools: Bash
---

Send a message to a specific claude-peers instance. This command requires two arguments: a peer ID and a message text.

The user invokes this as: `/comms-send <peer-id> <message>`

**Step 1 — Validate arguments:**

Extract the peer ID and message text from the user's input (everything after `/comms-send`). The first whitespace-delimited token is the peer ID; everything after it is the message.

If the peer ID is missing or the message is empty, print exactly:

`Usage: /comms-send <peer-id> <message>`

Then stop. Do not continue to step 2.

**Step 2 — Send the message:**

Construct a curl command to POST to the broker. The JSON payload must have `from_id` set to `"cli"`, `to_id` set to the peer ID, and `text` set to the message. Properly escape the message text for JSON (use `jq -n --arg text "..." --arg to_id "..." '{from_id:"cli",to_id:$to_id,text:$text}'` or equivalent to safely build the JSON body).

Run: `curl -s --max-time 3 -X POST -H 'Content-Type: application/json' -d '<json-body>' http://127.0.0.1:${CLAUDE_PEERS_PORT:-7899}/send-message`

If curl exits with a non-zero exit code or the output is empty (broker is not running or unreachable), print exactly:

`Broker is not running.`

Then stop.

**Step 3 — Report result:**

Parse the JSON response.

If the response has `"ok": true`, print: `Message sent to <peer-id>.`

If the response has `"ok": false`, print: `Failed to send: <error>` (where `<error>` is the `error` field from the response).
