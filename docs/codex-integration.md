# GUI session delivery and recovery

Updated 2026-09-19. This supersedes the 2026-08-10 PID-map/single-consumption
implementation. It preserves the existing MCP integration and GUI workflow.

## Receipt contract

Protocol 2 offers pending messages without consuming them. Only
`acknowledge_messages` or `cli.ts ack` sets `acknowledged_at` and `delivered=1`.
Acknowledgement means the agent received the text; it does not mean the agent
accepted or completed requested work. Clients must deduplicate work by message ID.

Automatic offers have a 30-second lease. A failed hook, lost response, dropped
channel notification or crash cannot acknowledge the message. It becomes eligible
again after expiry; a manual `check_messages` bypasses the lease. Explicit
acknowledgement is recipient-scoped and idempotent. Old clients receive receipt IDs
and a CLI acknowledgement command in the message envelope without a GUI restart.

Legacy rows already marked delivered remain unchanged with unknown receipt status
(`acknowledged_at` is null). They are not automatically replayed. Already-deleted
messages cannot be reconstructed by this change.

## Bind the actual session

Codex desktop tasks can share one parent process and working directory. Neither is
an identity. The old `~/.claude-peers/sessions/<parent-pid>.json` lookup was unsafe;
new code neither writes nor reads those files.

Hooks read their supplied `session_id` and resolve it with the broker. An unbound
main task receives a setup context asking its own MCP connection to call
`set_summary` with `[session:SESSION_ID]` followed by its work summary. This marker
is consumed by the broker and removed from the displayed summary. It works with
already-running MCP clients. New clients also expose `bind_session`. When available
at MCP launch, `CLAUDE_PEERS_SESSION_KEY` or `CODEX_THREAD_ID` binds directly.

The key must identify this exact conversation. Never use cwd, a generic agent name,
a shared PID, or an ID taken from a different task. A live owner cannot be replaced.
A resumed session with the same verified key reuses its original peer ID and inbox.
Provisional IDs from a new MCP connection redirect to the stable identity after
binding. Independent sessions remain independent, even in the same repository.

Hooks skip explicit subagent contexts and conflicting transcript/environment
identity hints because Codex may report a parent's session ID for child hooks.
No full GUI subagent interoperability claim has been validated.

## Hands-on delivery

- `UserPromptSubmit`: offer mail when the user starts a turn.
- `PostToolUse`: offer mail after a supported tool result, during active work.
  The hook uses `hookSpecificOutput.additionalContext`, not ignored plain text
  and not a blocking result that would replace the tool's actual output.
- `Stop`: request one continuation if new mail is pending. When
  `stop_hook_active` is true it does nothing, preventing an endless stop loop.

The existing prompt/stop hooks point to `hooks/inbox-hook.ts context|stop`.
A Codex PostToolUse hook was added in `~/.codex/config.toml`. No hook trust records
were edited. New definitions require the user's normal Codex hook review/trust;
existing running tasks may also need a configuration reload. The source scripts
have isolated integration coverage, but live automatic GUI delivery must be
observed separately after trust/loading.

A fully idle GUI task has no tool boundary. This implementation does not claim an
unsupported external wake API. Human messages continue to use the app's own
steering behavior; peer messages become context at supported hook boundaries.

Official reference: <https://learn.chatgpt.com/docs/hooks> (retrieved 2026-09-19).
The earlier `docs/plugin.md` channel investigation is historical; this repair
leaves the existing channel capability gate in place and does not depend on it.

## Offline recovery and migration

Dead-process cleanup and unregister mark a peer offline; they never delete pending
messages. Discovery defaults to online peers. `list_peers(include_offline=true)`
or `bun cli.ts peers --all` shows retained inboxes. Existing orphaned pending rows
get clearly labelled offline inbox records during migration; they are not assigned
to a new session based on guesses.

For an old inbox without a recoverable session key, verify the source identity and
use `recover_inbox(from_id)` on the intended receiving session, or:

```sh
bun cli.ts recover <destination-peer-id> <verified-offline-source-id>
```

Recovery transfers only pending messages and writes an audit row. It refuses a
live source. Historic delivered rows remain untouched. Inbox storage is for one
trusted OS user; these IDs are not credentials or a multi-tenant security boundary.

## Diagnostics

```sh
bun cli.ts status
bun cli.ts peers --all
bun cli.ts inbox <peer-id>
bun cli.ts ack <peer-id> <message-id> [more-message-ids]
bun test
./node_modules/.bin/tsc --noEmit
```

The live health endpoint reports protocol 2/version 0.2.0. Source updates to an MCP
server take effect after that connection restarts; the broker's legacy envelope
and summary-binding support keep existing connections usable in the meantime.
