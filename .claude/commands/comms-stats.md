---
name: comms-stats
description: "Show gsd-comms broker stats inline"
allowed-tools: Bash
---

Show broker database statistics inline. Follow these steps using the Bash tool:

**Step 1 — Fetch stats from broker:**

Run: `curl -s --max-time 3 http://127.0.0.1:${GSD_COMMS_PORT:-${CLAUDE_PEERS_PORT:-7899}}/stats`

If curl exits with a non-zero exit code or the output is empty (broker is not running or unreachable), print exactly:

`Broker is not running.`

Then stop. Do not continue to step 2.

**Step 2 — Format and display:**

Parse the JSON response and display in a compact readable format. Do not print raw JSON.

Print the following sections:

**Database:**
- Path: the `db_path` field
- Size: the `db_size_human` field
- Schema: `v` followed by the `schema_version` field

**Retention Policy:**
- Messages: `retention.messages_hours` hours (delivered)
- Sessions: `retention.sessions_days` days (completed)
- Waves: `retention.waves_days` days (completed)

**Row Counts:**
- Peers: `counts.peers` active
- Messages: `counts.messages_total` total (`counts.messages_undelivered` pending, `counts.messages_delivered` delivered)
- Sessions: `counts.sessions_active` active, `counts.sessions_completed` completed
- Waves: `counts.waves_total` total (`counts.waves_running` running, `counts.waves_completed` done)
- Tasks: `counts.tasks_total` total (`counts.tasks_running` running, `counts.tasks_completed` done)
