---
name: comms-kill
description: "Stop the gsd-comms broker daemon"
disable-model-invocation: true
allowed-tools: Bash
---

Stop the gsd-comms broker daemon. Follow these steps exactly using the Bash tool:

**Step 1 — Check broker status and get peer count:**

Run: `curl -s --max-time 3 http://127.0.0.1:${GSD_COMMS_PORT:-${CLAUDE_PEERS_PORT:-7899}}/health`

If the command exits with a non-zero exit code or returns no output (broker is not running or unreachable), print exactly:

`Broker is not running.`

Then stop. Do not continue to step 2.

Parse the JSON response to extract the peer count from the `peers` field (e.g. `{"status":"ok","peers":2}`).

**Step 2 — Kill the broker process:**

Run: `lsof -ti :${GSD_COMMS_PORT:-${CLAUDE_PEERS_PORT:-7899}} | xargs -r kill -TERM`

Then print: `Broker stopped. (N peer(s) were connected)` — substituting N with the peer count extracted in Step 1.
