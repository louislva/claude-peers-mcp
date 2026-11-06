# Reliable claude-peers inboxes and hands-on GUI delivery

Date: 2026-09-19 America/New_York.
Produced by: Codex, requested by Kiel after the agent-communication research.
Method: source inspection, live configuration/metadata reads, isolated SQLite and
HTTP/MCP/hook tests, backed-up live broker migration and explicit receipt readback.
No replacement messaging product was installed. No other agent was asked to do work.

## Outcome

Protocol 2/version 0.2.0 is deployed in the installed checkout and live broker.
The source branch is `codex/reliable-peer-inboxes`.

1. Fetch now offers messages with an expiring lease; it does not mark them delivered.
   An explicit recipient acknowledgement sets `acknowledged_at` and `delivered=1`.
   A lost response, failed hook or dropped push remains retryable. Manual inbox reads
   can retrieve in-flight unacknowledged offers immediately. Receipt is not task
   acceptance, completion, agreement, or proof of comprehension.
2. Same-process re-registration preserves the peer ID. A verified durable session key
   preserves the original ID and pending inbox across replacement processes. Late GUI
   binding redirects provisional IDs to the canonical ID. A different live owner is
   refused, and different sessions sharing a directory remain separate.
3. Cleanup and unregister mark peers offline without deleting their messages. Explicit
   recovery from verified offline inboxes is audited. Migration exposes existing
   orphaned pending mail instead of silently reassigning it.

The migration does not retroactively establish receipt for historic `delivered=1`
rows, replay their work, or reconstruct messages already deleted by the old code.
The bus remains a trusted-local-user service, not a multi-tenant authorization layer.

## Additional GUI problem corrected

The old hook looked up `~/.claude-peers/sessions/<parent-pid>.json`. Live metadata
showed multiple Codex MCP processes sharing parent 8792. A shared map can overwrite
another task's mapping or be removed by a sibling's cleanup. The new hook resolves
its explicit `session_id` through the broker and never guesses from cwd or PPID.
It does not read or write the old map files.

For already-running clients, the hook supplies a one-time setup context requesting
`set_summary` with `[session:VERIFIED_ID]`; the broker binds and strips the marker.
New clients also expose `bind_session`, `acknowledge_messages`, and `recover_inbox`.
Already-running clients receive IDs and a CLI ACK command in their message envelope.
This keeps the existing GUI MCP connections usable while source updates await their
next natural restart. The current Codex repair task was bound and read back live.

Codex `PostToolUse` is now configured to inject `hookSpecificOutput.additionalContext`
without replacing the real tool output. The existing UserPromptSubmit and Stop hook
commands remain unchanged. Stop handles at most one continuation; explicit subagent
or conflicting transcript identity hints are skipped rather than reading the parent's
mailbox into a child context.

The new hook definition requires user trust in Codex's normal hook-review interface;
no trust hashes, managed-policy settings or bypass flags were altered. At report time
this activation is pending user review. Existing tasks may need configuration reload.
The product's hook requirement is documented at
<https://learn.chatgpt.com/docs/hooks> (retrieved 2026-09-19).

A completely idle GUI task has no tool boundary. No unsupported idle-wakeup mechanism
was added or claimed. The expected improvement after activation is automatic delivery
during active hands-on work and at the next prompt/stop boundary, not arbitrary
interruption of a running tool or guaranteed wakeup of an idle GUI conversation.

## Verification

- `bun test`: **20 passed, 0 failed**, including 81 assertions.
- `./node_modules/.bin/tsc --noEmit`: passed.
- Tests cover loss after fetch, lease expiry, explicit/idempotent/recipient-scoped
  ACK, atomic batch rejection, same-process identity, restart/reconnect, offline sends,
  cleanup retention, explicit audited recovery, legacy migration, orphan discovery,
  concurrent database clients, real stdio MCP calls, legacy receipt envelopes, two
  sibling MCP clients with the same cwd/parent, structured PostToolUse context,
  subagent identity guards and Stop-loop prevention.
- Initial live cutover: **964 messages before and after; all 89 pending preserved**.
  SQLite integrity check: `ok`; schema version: `2`.
- The existing Codex GUI MCP connection retrieved synthetic message **1029** without
  restarting the GUI. Before ACK it remained pending; explicit CLI ACK produced
  `delivered=1` with `acknowledged_at=2026-09-20T00:47:12.313Z` and offer count 1.
  This verifies the live compatibility/receipt path, not automatic GUI hook delivery.

Private backup directory:
`/Users/kielay/.claude-peers/backups/20260919-204535/`.
It contains SQLite-consistent pre-change and cutover databases, the original Codex
configuration, broker log, and cutover/live-probe receipts. Backup database/config
permissions are 0600; the containing directory is private. Sensitive database and
configuration contents were not copied into this repository.

## Remaining acceptance

After trusting/loading the new PostToolUse hook, send a test message into this exact
Codex task while it is using tools and confirm that the hook context arrives without
calling check_messages. Confirm the same in a separate Claude GUI task with its own
binding. These live UI observations are not substitutes for the isolated tests and
have not yet been claimed complete.

New sessions should bind a verified session ID. Legacy orphan inboxes require an
explicit identity decision before recovery; no automatic reassignment or bulk replay
was performed. A later upgrade to native Claude messaging or a different bus is a
separate decision, not required for these reliability repairs.
