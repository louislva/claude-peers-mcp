---
name: comms-peers
description: "List active claude-peers instances inline"
allowed-tools: Bash
---

List active claude-peers instances by querying the broker. Follow these steps using the Bash tool:

**Step 1 — Fetch peer list from broker:**

Run: `curl -s --max-time 3 -X POST -H 'Content-Type: application/json' -d '{"scope":"machine","cwd":"/","git_root":null}' http://127.0.0.1:${CLAUDE_PEERS_PORT:-7899}/list-peers`

If curl exits with a non-zero exit code or the output is empty (broker is not running or unreachable), print exactly:

`Broker is not running. Start it with: bun cli.ts status`

Then stop. Do not continue to step 2.

**Step 2 — Format and display:**

Parse the JSON array response.

If the array is empty, print: `No peers registered.`

Otherwise, print a header: `N peer(s) active:` (where N is the count), then for each peer display:

- **ID:** the `id` field (bold in markdown)
- **PID:** the `pid` field
- **Directory:** the `cwd` field
- **Summary:** the `summary` field (if non-empty)
- **Last seen:** the `last_seen` field

Format as a clean readable list. Do not print raw JSON.
