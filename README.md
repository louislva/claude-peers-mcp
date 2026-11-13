# claude-peers

Local peer discovery and messaging for Claude Code, Codex CLI, Gemini CLI, and OpenCode.

This is the maintained Manzo downstream of [Louis Arge's upstream project](https://github.com/louislva/claude-peers-mcp). The supported clone and issue/release surface for this contract is `manuel-goepfi/claude-peers-mcp`. It runs one stdio MCP adapter per client session and one loopback-only SQLite broker for the current Linux user. Peers can discover live sessions, route by exact identity or human-facing seat, exchange untrusted coordination messages, and inspect tmux context only when explicitly requested.

## Supported boundary

- Linux with `/proc`, one operating-system user, and loopback networking.
- Bun 1.3.11, pinned by `packageManager`, `engines`, and CI. Node >=22.6 is
  required only for the optional shared Codex Desktop relay described below.
- At least one supported client: Claude Code, Codex CLI, Gemini CLI, or OpenCode.
- Git for installation. `tmux` is optional and only needed for pane identity or explicit pane inspection. A systemd user manager is optional.
- Remote brokers, multi-user authorization, Windows/macOS support, and shared-process multiplexing are not part of this release.

The isolation boundary is the current UID. A malicious process running as the broker owner can impersonate process metadata and is outside the security guarantee.

## Architecture

```text
Claude / Codex / Gemini / OpenCode session
          │ stdio MCP (one adapter per session)
          ▼
      server.ts ───────────────┐
                               ▼
                    broker.ts on 127.0.0.1
                    SQLite + database owner lock
```

The broker owns both the configured loopback listener and a lifetime lock for the canonical database. Operational routes remain unavailable while storage is starting or migrating. The first adapter can start the broker directly; a hardened systemd user service is available for managed ownership.

### Seat identity

A peer row is anchored to a **seat** — the operator-visible place an agent lives — not to the process that registered it. The seat key is `pane:<session>:<pane_id>` when the client is in tmux, `tty:<tty>` otherwise; a headless lane has no seat key and keeps per-process identity, since two anonymous background lanes are genuinely different seats.

One seat is one row with one id. Several processes legitimately register for the same seat — a Claude session registers its MCP server pid *and*, from the SessionStart hook, its TUI pid — so registration **merges** onto the existing seat instead of minting a second identity: the newest row's id survives, the duplicate's undelivered mail migrates to it, and every registering pid is recorded in `seat_pids`. The seat counts as alive while any of those pids is alive, so an MCP server killed at compact/resume does not make an occupied pane look dead. Merging replaces superseding for co-registrants: nothing is told to step down and no mail is dropped.

Each open tmux pane receives one visible `session.number` name. Proven legacy Codex reconnects and heartbeats also repair a stale broker display name to that pane name, preserving the peer ID and mailbox. The number stays
with that pane while it remains open, even when panes move or layout indexes
change. Renaming the tmux session changes the prefix and pane numbers. Closing a
pane releases its number; no permanent seat registry survives the pane.

Native Claude and its MCP companion may share one runtime-scoped mailbox after
the hook proves the exact conversation, account, process lifetime, and pane.
The original peer IDs remain intact for history and correlation. An alias cannot
be selected as a second seat, inherit a display name, or survive a native
process replacement without fresh proof.

## Clean installation

```bash
git clone https://github.com/manuel-goepfi/claude-peers-mcp.git "$HOME/claude-peers-mcp"
cd "$HOME/claude-peers-mcp"
bun install --frozen-lockfile
```

The clone and user configuration must be owned by the current UID. User-scope installers reject symlink targets, group/world-writable clone path components, unsafe config modes, malformed JSON, and concurrent operator edits.

### Register the MCP server

Use the native client command for the clients you run:

```bash
# Claude Code: user scope
claude mcp add --scope user --transport stdio claude-peers -- bun "$HOME/claude-peers-mcp/server.ts"

# Codex CLI: its MCP configuration is user-level
codex mcp add claude-peers -- bun "$HOME/claude-peers-mcp/server.ts"

# Gemini CLI: user scope
gemini mcp add --scope user --transport stdio claude-peers bun "$HOME/claude-peers-mcp/server.ts"

# OpenCode: user scope, installed atomically into ~/.config/opencode/opencode.jsonc
bun bin/install-opencode-mcp.ts install
bun bin/install-opencode-mcp.ts --check
```

User scope is the canonical configuration so the peer bus works across repositories. `examples/claude-mcp.json` is an inert project-scope Claude template; copy and adapt it to `.mcp.json` only when deliberately choosing project scope instead of the user registration above. Codex stores MCP servers in `.codex/config.toml`; Gemini stores them under `mcpServers` in `.gemini/settings.json`; OpenCode stores local MCP servers under top-level `mcp` in `.config/opencode/opencode.jsonc`. The OpenCode installer preserves unrelated keys, creates a 0600 backup before a material edit, and sets `CLAUDE_PEERS_CLIENT_TYPE=opencode`. Restart OpenCode after installation.

### Install receive hooks

Claude receive hooks require `bash`, `curl`, `flock`, `jq`, `ps`, `awk`, `sed`, and `tail`; the installer fails closed when any are missing instead of installing an inert receiver.

User scope is the default so hooks work across repositories:

```bash
cd "$HOME/claude-peers-mcp"
bun bin/install-claude-hook.ts install
bun bin/install-codex-hook.ts install
bun bin/install-gemini-hook.ts install

bun bin/install-claude-hook.ts --check
bun bin/install-codex-hook.ts --check
bun bin/install-gemini-hook.ts --check
```

For an alternate Claude profile, point both install and check at its configuration directory:

```bash
CLAUDE_CONFIG_DIR="$HOME/.claude-b" bun bin/install-claude-hook.ts install
CLAUDE_CONFIG_DIR="$HOME/.claude-b" bun bin/install-claude-hook.ts --check
```

Codex profiles use the same pattern through `CODEX_HOME`:

```bash
CODEX_HOME="$HOME/.codex-b" bun bin/install-codex-hook.ts install
CODEX_HOME="$HOME/.codex-b" bun bin/install-codex-hook.ts --check
```

- Claude: `SessionStart` registration, `UserPromptSubmit` drain, `PostToolBatch` drain between tool batches, and a `Stop` `asyncRewake` standby watcher. The watcher polls every 30 seconds for the first hour after activity, then every 120 seconds while the Claude process remains alive; later Stop events refresh the fast window without spawning duplicate watchers.
- Codex: proven root-session hooks register and drain at `SessionStart`, drain at `UserPromptSubmit`, drain after each local `PostToolUse`, and drain at `Stop`. The hook proves the root by matching `session_id` to the rollout transcript filename; transcript-less drains use only the exact thread join and never mint identity. Unproven internal or child hooks leave mail queued for `check_messages` or the next proven root hook.

The post-tool hooks are the supported mid-turn receive path. They inject queued mail before the next model request without typing into a busy pane. A tool-free model call cannot be interrupted and receives mail at its next supported hook boundary.
- Gemini: `SessionStart` registration and `BeforeAgent` drain. The installer also renders its supported `mcpServers` entry.

### Shared Codex Desktop seats

`bin/codex-shared-seat` attaches an interactive tmux Codex TUI to the shared
Desktop app-server through a private pane-local relay. The relay forwards the
protocol unchanged. It observes only successful root `thread/start` and
`thread/resume` responses, then publishes that exact thread/pane join to the
loopback broker. This path does not depend on pane width, status-line text, or
cwd uniqueness.

When an operator installs `~/bin/codexr`, bare `resume` and `resume --all`
use its `--desktop` indexed picker before starting a relay. An exact selected
UUID re-enters this shared launcher. Other resume flags keep the native path.
`CLAUDE_PEERS_CODEX_RESUME_PICKER` overrides that optional executable; set it
to `native` to retain the native picker. Custom upstream socket overrides
keep the native path rather than silently changing the selected socket.

Ephemeral `thread/start` helpers are ignored. The native TUI creates these
for structured background work on the same connection; they must not replace
the displayed task's peer binding.

Headless shared-server registration hooks use exact thread identity when they
have no proved inherited pane. The presence of a single visible TUI elsewhere
on the host is not an identity proof and is never adopted by that hook.

For the standard A/B/C account homes, the launcher also enables automatic
`[A]`, `[B]`, or `[C]` task-title prefixes. The relay preserves client messages
and adds a scoped `thread/name/set` request when the displayed task receives a
descriptive name, including names changed by another UI subscriber. Existing
names are labeled on resume. Already labeled names do not trigger another
write. Empty names, other tasks, and ephemeral helpers are ignored. Unknown
homes or a socket override pointing outside the selected home disable labeling
rather than guessing an account. There is no polling or model call for labels.

The wrapper requires a verified `TMUX_PANE` for pane binding. Outside tmux it
still performs the Desktop co-attach without inventing a terminal seat. Desktop
MCP messaging can use an exact hook-owned thread identity only when its PID
matches the adapter's independently discovered app-server host, its receiver is
`codex-hook`, and all terminal/seat fields are null. Such identities are not
tmux wake targets. Both paths connect to the exact verified account socket,
including an explicit socket override. The relay creates a 0700
runtime directory under `$XDG_RUNTIME_DIR` or `/tmp`, a 0600 Unix socket and
readiness file, and an owner-only log at
`$CODEX_HOME/logs/codex-shared-relay-<pane>.log`. The wrapper removes its socket
and readiness artifacts and terminates the relay when the TUI exits.

The relay is the one documented Node runtime exception. Bun 1.3.11 can serve a
Unix WebSocket but its client cannot connect to the Codex app-server's
`ws+unix` endpoint. The relay therefore runs on Node >=22.6 with the pinned
upstream `ws` package. `tests/codex-appserver-relay.test.ts` proves lifecycle
forwarding, bind retry/idempotence, and owner-only artifact modes.

Project scope is explicit:

```bash
bun bin/install-codex-hook.ts --scope project /path/to/project
```

The installer warns when the same managed hook exists in user and project scope, but installs only the scope you named. It never removes the other scope automatically. Choose one owner by explicitly uninstalling the scope you no longer want:

```bash
bun bin/install-codex-hook.ts --scope project /path/to/project
bun bin/install-codex-hook.ts --scope user --uninstall
```

Correct configurations are byte- and mtime-stable no-ops. A material edit creates a unique 0600 backup. `--uninstall` removes only managed entries; `--restore <backup-path>` restores a generated sibling backup only when the installed bytes have not been edited since installation.

After hook or MCP changes, restart the client session. Codex hook files are trust-sensitive: open `/hooks` and confirm the changed configuration before expecting automatic drain.

### Closing a Codex lane

A shared seat runs the lane as a thread inside the account's shared app-server.
Closing the tmux pane ends the TUI and the relay, not the thread. A loaded
thread can keep running headless, and its hooks could previously claim queued
peer mail and turn it into more work. Stop the thread first, then close the
pane:

```bash
bin/codex-thread-stop --pane %28803 --dry-run   # show the plan, change nothing
bin/codex-thread-stop --pane %28803             # stop exactly that thread
tmux kill-pane -t %28803                        # only then close the pane
```

`--thread UUID` selects a thread directly (for example a task the pane drove
before `/new`). `--socket PATH` names the app-server socket when the binding
predates socket recording; it must agree with any recorded socket.

What it does, in order:

1. Reads the binding the relay published (`/codex-thread-binding`): the
   pane's current thread and the app-server socket the relay forwarded to.
   It refuses when the pane maps to more than one thread, when no socket is
   known, or when `--socket` contradicts the record.
2. Connects to that socket and proves the endpoint is a Codex app-server
   (`initialize`). It refuses if the socket is unreachable. It then reads the
   thread's own status with `thread/read` and `thread/loaded/list`, and
   refuses if the server answers for a different thread id.
3. Sets the intermediate `stopping` gate in the broker (`/codex-thread-gate`)
   before touching the turn, so peer mail is already held.
4. Sends `turn/interrupt` for each in-progress turn listed by
   `thread/turns/list`. It then sends `thread/archive` to each loaded
   subagent of the thread, deepest first, and then to the thread itself.
   Subagents are found by reading every loaded thread with `thread/read`
   and following `parentThreadId`. The server is never restarted, and no
   thread outside that tree is archived.
5. Verifies with `thread/read` and `thread/loaded/list` that neither the
   thread nor any of its subagents is still loaded. Only then does it raise
   the gate to the permanent `stopped`. `--dry-run` sends only read-only
   status calls and lists the subagents it would archive.

A thread that the chosen server does not have loaded is not assumed dead.
This matters because the socket may be wrong: there is one app-server per
account, and a binding made before the deploy has no recorded socket. The tool
marks such a thread `stopped` only when it can prove the thread is absent from
`thread/loaded/list` on every known app-server socket. Known sockets are every
socket a relay has recorded, plus the account homes' control sockets
(`~/.codex*/app-server-control/app-server-control.sock`), or
`CLAUDE_PEERS_CODEX_APP_SERVER_SOCKETS` (colon-separated) when that is set. It
refuses, changing nothing, in these cases:

- the thread is loaded on another server (the message names that socket);
- any known server is unreachable;
- `--socket` is not a known app-server socket.

Exit codes: `0` stopped (or dry run), `3` already gone (proven absent
everywhere, or already stopped), `2` refused (nothing changed), `1` acted but
did not finish, `64` usage. Method names come from the installed Codex CLI's
generated app-server protocol (`codex app-server generate-ts`, 0.160.1).

Failed or partial stop. If the interrupt, archive, verification or final
broker write fails, the gate stays at `stopping`. Mail stays held, the thread
is not labelled stopped, and a pane bind cannot reopen it. Either rerun the
same `codex-thread-stop` command to retry (a `stopping` thread is still the
pane's target), or undo the stop.

Recovering from a stop:

```bash
bin/codex-thread-stop --unstop --thread UUID --dry-run
bin/codex-thread-stop --unstop --thread UUID                      # thread must be loaded again
bin/codex-thread-stop --unstop --thread UUID --operator-override  # lift it anyway
```

`--unstop` lifts a `stopping` or `stopped` gate only in two cases: the thread
is loaded again on its recorded app-server (or the `--socket` you name), and
that server answers for the same thread id; or you pass
`--operator-override`. The broker then makes the thread's peer rows
targetable again, so its queued mail is deliverable. It also writes a row to
`codex_thread_gate_audit` with the proof and the restored peer ids. Every gate
change (stop, lifted pane-closed, unstop) is recorded in that table. Nothing
else ever lowers a `stopping` or `stopped` gate.

Mail gating. A gate makes every Codex row bound to the thread non-targetable
and records those peer ids. While any gate is set:

- `/claim-by-thread`, `/ack-by-thread`, `/hook-heartbeat-by-thread` and
  `/identity-by-thread` answer `410`. The drain hook treats that as terminal:
  no delivery and no self-registration.
- `/poll-messages`, `/poll-by-pid` and `/claim-by-pid` return no mail.
- `/register` and `/reconcile-pane-thread` for that thread answer `410`.
- New sends to the gated ids fail as not found.
- The autodrain poller never wakes a non-targetable row.

Queued mail is not moved or acknowledged. It stays queued under the gated ids
until normal dead-seat retention removes it.

The relay also applies a softer `pane-closed` gate when it shuts down (pane
closed or TUI exited), for the thread its pane last bound. Only a later proven
relay bind of the same thread (an explicit resume in a live pane) lifts
`pane-closed`. Gates only rise (`pane-closed` < `stopping` < `stopped`), so a
pane-closed notice never weakens a stop.

Deployment status: this ships in the repository only. The live clone moves
through `bin/deploy-live` after merge, which restarts the broker for the new
routes, gates and the `codex_thread_controls` table. Running relays keep their
old code until their `codex-shared-seat` pane is relaunched; until then they
record no app-server socket and send no pane-closed gate, so use `--socket`
for panes bound before the deploy.

### Reaping orphaned Codex subagents

A subagent thread stays loaded after its work is done, and it can outlive its
parent. Each loaded subagent holds managed network proxy listeners and session
fds, so on a long-lived shared app-server they add up until the server runs
out of file descriptors. `bin/codex-subagent-reaper` archives the ones that
are safe to archive:

```bash
bin/codex-subagent-reaper                 # dry run: list what would be archived
bin/codex-subagent-reaper --apply         # archive them
bin/codex-subagent-reaper --grace-min 60  # change the grace period (default 30)
```

It archives a thread only when all of these hold: it is a subagent (it has a
`parentThreadId`); its status is `idle`; its parent is absent from
`thread/loaded/list` on every known app-server socket; and its `updatedAt` is
older than the grace period. Just before each archive it reads the thread
again and re-checks the parent on every server. After the archive it confirms
the thread has left `thread/loaded/list`. It never archives a lane thread
(no parent), an active subagent, or a subagent whose parent is loaded
anywhere. A lane thread or orphan in `systemError` is only reported, for its
owning lane to handle. Any thread it cannot classify is kept and reported.
That covers a thread it cannot read, a source that is neither a client nor
a subagent, a subagent-typed source with no parent id, an unknown status,
and a missing `updatedAt`. A thread counts as a lane thread only when its
source says a client started it. Known sockets are the same set `codex-thread-stop`
uses. If any of them is unreachable, the run is refused and nothing changes.

Exit codes: `0` dry run, or every candidate archived; `1` an archive failed
or did not verify; `2` refused (nothing changed); `64` usage.

### Verify the installation

```bash
bun bin/peers-doctor.ts
bun bin/peers-doctor.ts --json
bun run smoke:install
```

The doctor performs one `GET /health`, then uses same-user read-only process, config, and SQLite evidence. It never polls, claims, acknowledges, heartbeats, sends, or otherwise changes broker state. While the broker reports `starting` or `migrating`, schema queries are skipped. If health is unreachable while a live or ambiguous database owner exists, schema reads are refused.

In JSON output, `processes.adapters` always contains the complete diagnostic key set: `claude`, `codex`, `gemini`, `cursor`, `agy`, `kimi`, `grok`, `opencode`, and `unknown`. Cursor, agy, Kimi, Grok, and OpenCode are process-classification entries. OpenCode has the managed MCP installer above; authenticated release-host smoke remains Claude, Codex, and Gemini until a separately armed OpenCode account is added to that gate.

Start two client sessions and ask one to call `list_peers`, then send with `send_to_peer` or `send_message`.

## MCP tools

| Tool | Contract |
| --- | --- |
| `list_peers` | List targetable peers by `machine`, exact `directory`, or worktree-aware `repo` scope; optional tmux filter. |
| `send_message` | Send to one live broker ID. Returns a caller-scoped `request_id`; an optional stable ID makes retries idempotent. |
| `send_to_peer` | Resolve one exact selector and send with the same request/retry contract. Ambiguity returns candidates and sends nothing. |
| `get_reply_status` | Check one caller-owned `request_id`; an available reply is claimed and acknowledged through the same exclusive inbox lease as `check_messages`. |
| `inspect_peer_pane` | Explicitly capture 1–200 lines from a peer pane, read-only, capped at 8 KiB. Does not claim or ack the caller's inbox. |
| `broadcast_message` | Fan out to a bounded tmux/repo/name scope. At least one filter is required and filters combine with AND. |
| `set_summary` | Set an explicit operator/agent summary visible to peers. There is no LLM or API-key auto-summary dependency. |
| `set_name` | Set or clear the seat's explicit name; it outranks the pane auto label and survives re-registration, and a name another live seat holds is refused with the holder named. |
| `find_peer` | Filter by exact name, name substring, tmux session, or tmux presence. |
| `check_messages` | Explicitly poll and acknowledge messages rendered into the tool result. Required fallback without an active receive hook. |
| `whoami` | Return this adapter's broker identity, client/receiver mode, working directory, repository, and mirror status. |

Idle wakes are batched. A seat that is idle when mail arrives is woken at most once per `CLAUDE_PEERS_WAKE_BATCH_MS` (10 minutes by default), counted from its last delivery, and that wake carries everything queued since. Start the message text with `URGENT:` (any case) to wake the seat at once. Held mail stays `queued`: `check_messages`, prompt-time drains, and message status see it as usual.

### Selector and tmux rules

Human names are not assumed unique. Prefer `resolved_name`, `seat_key`, live `id`, visible `tmux_target`, or `tmux_session` plus `tmux_pane_id` when more than one candidate exists.

Tmux capture is always explicit through `inspect_peer_pane` or `include_tmux_context: true`. It uses `capture-pane`, strips controls, and never calls `send-keys`. Captured text is returned only to the caller; it is never inserted into message text, SQLite, broker logs, bridge output, `/health`, or doctor JSON.

## Delivery model

| State | Meaning |
| --- | --- |
| `queued` | The broker inserted the sender-owned row. No receiver claim or display is implied. |
| `claimed` | A hook holds a temporary lease, but acknowledgement has not completed. |
| `acknowledged` | The receiver explicitly acknowledged after rendering; `delivered_at` exists. |
| `unknown` | The sender cannot prove a current row/state, including legacy delivered rows without an acknowledgement timestamp. |

`expired` is retention telemetry only; the broker does not keep message tombstones. A missing row is never guessed to be queued or expired.

Every current 1:1 send returns `request_id`. Callers may provide a stable value matching `[A-Za-z0-9._:-]{1,128}`; an identical retry returns the original row and a changed retry fails with `REQUEST_ID_CONFLICT`. To correlate a reply, send to the authenticated `from` route and pass the inbound `request_id` as `reply_to_id`. The broker enforces exact requester/responder direction and accepts only the first reply. `get_reply_status` reports `pending` or `replied`; reply bodies are returned only to the session that wins the ordinary claim lease, so racing `check_messages` cannot render the same body twice.

Queue insertion is not receipt, so every send also returns the recipient's live delivery health in `recipient` (and a human `warning` when there is something to say). This is read from the recipient's actual queue at send time, not inferred from its configuration:

| `recipient.state` | Meaning |
| --- | --- |
| `healthy` | Draining normally, or the queue is too young to judge. |
| `undrained` | Has a drain path but has not used it while mail waits — older than `UNDRAINED_WARN_MS` (the wake batch window plus 2 minutes, so 12 minutes by default). The sender is told to treat the message as undelivered. |
| `no_drain_path` | No tmux pane for the autodrain poller to nudge and no client hook. Delivery depends entirely on the recipient calling `check_messages`. |

`recipient` also carries `pending` (queue depth including the message just sent), `oldest_pending_ms`, `last_drain_at`, and `nudgeable`.

| Client | Receiver mode | Receipt path |
| --- | --- | --- |
| Claude Code | `claude/claude-channel` | Prompt-time hook claim and acknowledgement plus a refreshable idle `asyncRewake` watcher; explicit `check_messages` remains the safety net. |
| Codex with current hooks | `codex/codex-hook` | Prompt/start/post-tool/turn-end hook claim and acknowledgement. |
| Gemini with current hooks | `gemini/gemini-hook` | `BeforeAgent` hook claim and acknowledgement. |
| Codex or Gemini without a proven hook | `*/manual-drain` | `check_messages` until the hook registers and heartbeats successfully. |
| OpenCode | `opencode/manual-drain` | The tmux auto-drain poller wakes an idle, empty composer; the lane calls `check_messages`. |
| Unknown/send-only | `unknown/unknown` | Not a normal automatic receiver; bounded retention applies. |

Every current client disables the MCP background observation poll. A consumer claims a batch only when it can render that batch into a hook result or an explicit `check_messages` tool response, then acknowledges the same claim. A failed acknowledgement leaves the claim available for redelivery after its lease expires. The compatibility scheduler remains configurable for benchmark and future-client work, but it never caches or renders a polled body.

## Limits and retention

- Message body: 32 KiB. Request body: 64 KiB. Summary: 1 KiB. Name: 128 bytes.
- Per peer: 600 protected requests and 60 message slots per rolling minute. Heartbeats are exempt from request throttling.
- Broadcast: at most 60 targets. Hook claim: at most 25 messages and 64 KiB. Claim lease: 30 seconds.
- Tmux capture: default 80 lines, maximum 200 lines and 8 KiB.
- Delivered history: seven days by default, anchored at acknowledgement or migration retention time. An open correlated request is retained; after its reply arrives, the request remains at least as long as that reply.
- Undelivered mail to an `unknown` receiver: seven days by default.
- A dead recoverable seat keeps undelivered mail for 24 hours by default, with a one-hour floor.

History intentionally outlives ephemeral peer rows. Schema version 2 has no message-to-peer foreign keys. Startup migration creates and verifies a restricted backup, preserves IDs/claims/correlation/high-water state, commits the version last, and restores atomically after post-commit verification failure. When an older verified migration backup already occupies the configured path, the next migration creates a versioned sibling and leaves the retained pair byte-identical.

| Stored state | Retention behavior |
| --- | --- |
| `queued` to a live draining receiver | Retained until claimed/acknowledged, or until the universal `CLAUDE_PEERS_STALE_UNDELIVERED_TTL_MS` age cap (default 48h) — coordination mail unread that long is dead context; rows inside an active claim lease are never purged. |
| `claimed` | Lease returns to claimable after 30 seconds if it is not acknowledged. |
| Undelivered to an `unknown` receiver | Purged after `CLAUDE_PEERS_UNDELIVERED_MSG_TTL_MS`. |
| Undelivered to a dead recoverable seat | Row and inbox remain inheritable until `CLAUDE_PEERS_DEAD_MAIL_TTL_MS`, never less than one hour, then both are reaped. |
| `acknowledged` | Retained until `CLAUDE_PEERS_DELIVERED_MSG_TTL_MS` from its retention anchor, even if the peer row is gone. |
| Missing row / `unknown` delivery status | No tombstone is invented; absence does not establish why or when the row disappeared. |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_PEERS_PORT` | `7899` | Loopback broker port. |
| `CLAUDE_PEERS_CODEX_APP_SERVER_SOCKET` | `$CODEX_HOME/app-server-control/app-server-control.sock` | Upstream socket used by the optional shared Codex Desktop relay. |
| `CLAUDE_PEERS_CODEX_RELAY` | `<clone>/bin/codex-appserver-relay.ts` | Explicit relay implementation override for testing or packaging. |
| `CLAUDE_PEERS_REAL_CODEX` | `codex` from `PATH` | Real Codex executable used by `bin/codex-shared-seat`. |
| `CLAUDE_PEERS_HOST` / `CLAUDE_PEERS_HOSTNAME` | unset | Optional loopback-only bind assertions; non-loopback values are rejected. |
| `CLAUDE_PEERS_DB` | `$HOME/.claude-peers.db` | SQLite database. |
| `CLAUDE_PEERS_BACKUP` | `<db>.backup` | Verified migration/rollback backup. |
| `CLAUDE_PEERS_BROKER_LOG` | `$HOME/.claude-peers-broker.log` | Owner-only append log. |
| `CLAUDE_PEERS_OWNER_MODE` | direct or inferred systemd | Ownership/shutdown contract; the service installer sets `systemd`. |
| `CLAUDE_PEERS_BRIDGE_ENABLED` | `true` | Compatibility-on bridge cursor. Set `false` to remove its token and endpoint completely. |
| `CLAUDE_PEERS_BRIDGE_TOKEN_FILE` | `$HOME/.claude-peers-bridge.token` | 0600 bearer token for privileged history reads. |
| `CLAUDE_PEERS_METRICS_ENABLED` | `true` | Authenticated aggregate route and latency metrics; never content or IDs. |
| `CLAUDE_PEERS_ADAPTIVE_POLLING` | `true` | Compatibility observation-poll scheduler; inactive for every current client. |
| `CLAUDE_CONFIG_DIR` | `$HOME/.claude` | Claude profile directory used by the hook installer and hook logs. |
| `CLAUDE_PEERS_STANDBY_ACTIVE_SECONDS` | `3600` | Fast standby-poll window after each Claude Stop event. |
| `CLAUDE_PEERS_STANDBY_POLL_INTERVAL_SECONDS` | `30` | Poll cadence during the fast standby window. |
| `CLAUDE_PEERS_STANDBY_IDLE_INTERVAL_SECONDS` | `120` | Reduced cadence after the fast window while Claude remains alive. |
| `CLAUDE_PEERS_STANDBY_LOCK_WAIT_SECONDS` | `2` | Bounded takeover wait for a prior watcher. |
| `CLAUDE_PEERS_STANDBY_MAX_RENDER_FAILURES` | `3` | Consecutive render failures after which a watcher releases its claim and exits, freeing the session lock. Each failed claim is released at once, never held until the claim TTL lapses. |
| `CLAUDE_PEERS_WAKE_BATCH_MS` | `600000` | Minimum gap between idle wakes for non-urgent mail, from the seat's last delivery; read by the standby watcher, the wake poller, and the broker (whose undrained warning is this window plus 2 minutes). Each reads its own environment, and this repository does not set environment for Claude sessions: set the same value for Claude sessions (for example the `env` block of Claude settings), the wake poller unit, and the broker unit. `0` wakes on every arrival. Mail starting with `URGENT:` always wakes at once. |
| `CLAUDE_PEERS_STANDBY_RUNTIME_DIR` | `$XDG_RUNTIME_DIR` or `$HOME/.cache` | Owner-only watcher lock and atomic session state root. |
| `CLAUDE_PEERS_TMUX_UNCHANGED_WRITE_SUPPRESSION` | `true` | Skip unchanged identity stamps; failed stamps receive three bounded retries. |
| `CLAUDE_PEERS_HEARTBEAT_PHASE_SPREAD` | `true` | Deterministically de-phase fleet heartbeats. |
| `CLAUDE_PEERS_HEARTBEAT_MS` | `15000` | Adapter heartbeat interval. |
| `CLAUDE_PEERS_TMUX_REDETECT_EVERY` | `8` | Full tmux re-detect every N heartbeats. |
| `CLAUDE_PEERS_ORPHAN_EXIT_GRACE_MS` | `300000` | Continuous auth/churn grace before orphan self-exit; floored at 60000. |
| `CLAUDE_PEERS_DEAD_MAIL_TTL_MS` | `86400000` | Recoverable dead-seat mail lifetime; floored at one hour. |
| `CLAUDE_PEERS_DELIVERED_MSG_TTL_MS` | `604800000` | Acknowledged-history retention. |
| `CLAUDE_PEERS_UNDELIVERED_MSG_TTL_MS` | `604800000` | Undelivered retention for unknown receivers. |
| `CLAUDE_PEERS_STALE_UNDELIVERED_TTL_MS` | `172800000` | Universal undelivered age cap, any receiver; active claim leases excluded. |
| `CLAUDE_PEERS_CLI_TIMEOUT_MS` | `3000` | CLI operation timeout. |
| `CLAUDE_PEERS_NO_AUTOSTART` | unset | Set `1` to make the CLI refuse broker auto-start. |
| `CLAUDE_PEER_NAME` | unset | Optional operator-facing seat label captured at session registration. It is not required to be unique. |

The broker always binds literal `127.0.0.1`; host assertions never enable a remote bind.

## CLI and diagnosis

```bash
bun cli.ts status
bun cli.ts peers
bun cli.ts send <live-peer-id> <message>
bun cli.ts kill-broker

bun bin/peers-doctor.ts --json
```

CLI commands use a short-lived authenticated, globally non-targetable identity and remove it in `finally` and handled signal paths. Failures are classified as usage, transport, timeout, malformed response, compatibility, authentication, rate limit, target, partial, cleanup, or unsafe shutdown and return nonzero.

`GET /health` is public loopback evidence and exposes only readiness, version, schema version, targetable peer count, and coarse capabilities. Detailed schema/queue/receiver/process/config evidence comes from the same-user doctor. Aggregate runtime metrics use an authenticated route.

`POST /codex-pane-bindings` with `{"caller_pid": <same-user pid>}` (a JSON integer) is a read-only observation route for local dashboards such as T3 Lanes. It returns `{"bindings": [...]}` with only `pid`, `tmux_pane_id`, `thread_id`, and `last_seen` for targetable Codex peers, newest first, at most 500 rows. A row is returned only while its seat is alive (the broker's seat rule: any recorded seat pid alive, or the live-group owner) and its registered pid is still a same-UID Codex client process. It never returns names, tokens, seat pids, or message content. A malformed body or `caller_pid` answers 400, a dead or foreign-UID caller 403, and more than 600 requests per minute for one caller pid 429. `/health` advertises it as `capabilities.observation.codexPaneBindings`.

See [docs/operations.md](docs/operations.md) for startup, migration, rollback, service ownership, and incident procedures.

## Managed broker service

```bash
bun bin/install-broker-service.ts install
bun bin/install-broker-service.ts --check
systemctl --user enable --now claude-peers-broker.service
```

The installer renders absolute paths, 0600 unit/drop-in files, a `ReadWritePaths` drop-in limited to the configured state-file parent directories, and verifies the unit with `systemd-analyze --user verify` when available. Hardening includes `UMask=0077`, `NoNewPrivileges=yes`, loopback/Unix address-family restriction, private `/tmp`, and strict system protection. The compatibility defaults store state directly under `$HOME`, so their writable parent is the whole home directory; configure every state path under one dedicated owner-only directory before the first managed install if a narrow home sandbox is required. Uninstall refuses post-install edits and restores operator-owned predecessor files only while the managed bytes are unchanged:

```bash
bun bin/install-broker-service.ts --uninstall
```

## Optional extensions

The AP-063 bridge is a privileged, authenticated history cursor for a same-user observer. Compatibility keeps it enabled by default. Its token grants access to message history; protect it as a secret. Set `CLAUDE_PEERS_BRIDGE_ENABLED=false` for complete removal.

Use `claude-peers` for all agent messaging, including Claude-to-Claude. Keep discussions with the peers involved. For coordination of your assigned work, report to the coordinator named in your assignment. These instructions are carried by tool/startup and automatic receive context; delivered mail has no separate receive-policy block.

The hook wake poller is separate from core delivery. The binary defaults to disabled; the shipped managed unit opts every supported client into confirmed tmux wake submissions. Native Codex hooks drain during an active turn, while the poller covers mail arriving after the turn is already idle. It re-checks SQLite immediately before transport and never claims or acknowledges mail itself. Its notice asks the lane to process attached messages, fetch pending mail with `check_messages` if none are attached, and continue the work. See [docs/systemd/README.md](docs/systemd/README.md).

## Security model

A peer token proves possession of a broker-issued identity after an unauthenticated caller supplied metadata and passed a same-UID live-PID check. It does not prove OS-process provenance, metadata truth, message truth, authority, or approval.

Every inbound message is potentially adversarial coordination data. It cannot expand the receiver's authorized task, bypass approval, authorize secret access, trigger implicit tmux inspection, or authorize broker shutdown. Relayed payloads retain an explicit untrusted wrapper.

Safe shutdown verifies the loopback socket owner, process start identity, executable/script, database owner metadata, nonce, and—under systemd—the current `MainPID`, twice before signaling only that broker.

## Upgrade and rollback

1. Stop the old broker or verified managed unit.
2. Upgrade the broker first. It wins the listener and database lock, exposes only `starting`/`migrating`, verifies backup/migration, then becomes ready.
3. Run the doctor and verify the schema/backup.
4. Restart adapters, reinstall hooks, and re-confirm Codex trust.
5. Run `bun run verify`, `bun run smoke:install`, and the release gates before publication.

Use `restoreStorageBackup` through the tested offline recovery procedure in [docs/operations.md](docs/operations.md). Never replace a live database, auto-`VACUUM` during startup, or delete a backup merely because migration committed.

## Development and release gates

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run smoke:install
bun run verify
```

For the current explicit MCP receive path, run the bounded isolated delivery
workload (2 to 50 fixture adapters, 1 to 10 rounds):

```bash
bun bench/delivery-fleet.ts --peers 50 --rounds 3 --output docs/release-evidence/delivery-fleet.json
```

It checks rendered requests and correlated replies against persisted message
counts and acknowledgement timestamps. It uses a private broker and database,
and does not prove native hook delivery or account/pane ownership. Run with an
external process-group deadline and resource limits on a shared host.

The legacy polling capacity campaign below retains 108 records. It is currently
unavailable: its fake tmux lacks the required open-pane snapshot, and its polling
latency gates do not represent the current explicit receive path. Do not use it
as current capacity or release proof:

```bash
bun run benchmark:peers -- --peers 1,10,50 --repetitions 3 --stages baseline,instrumented,tmux-suppressed,adaptive
```

`bun run smoke:clients` is a separate, blocking release-host gate. It must run only on the explicitly armed A3-owned isolated Linux account with release-pinned, authenticated Claude, Codex, and Gemini clients. The clone must live inside that account's home directory:

```bash
export CLAUDE_PEERS_RELEASE_HOME="$HOME"
export CLAUDE_PEERS_RELEASE_SMOKE=1
export CLAUDE_PEERS_RELEASE_TIMEOUT_MS=180000
export CLAUDE_PEERS_RELEASE_CLAUDE_VERSION=2.1.207
export CLAUDE_PEERS_RELEASE_CODEX_VERSION=0.144.1
export CLAUDE_PEERS_RELEASE_GEMINI_VERSION=0.47.0
bun run smoke:clients
```

The gate records client versions, installs user-scope MCP and receive-hook configuration, proves noninteractive authentication, then runs three clients concurrently through a cyclic discovery, `send_to_peer`, `check_messages`, and acknowledgement journey. It removes the managed MCP and hook configuration in `finally`, retains no client transcript, and emits only structured phase evidence. Missing prerequisites return blocked status; a client or journey failure returns nonzero. The A3 operator must rotate or revoke temporary credentials after the run.

## License

MIT. Copyright (c) 2026 Louis Arge. See [LICENSE](LICENSE).

Generic Read/Execute/Follow/Implement TASK.md task titles are replaced by the first descriptive TASK.md heading in the task cwd, retaining the account prefix. Lane headings omit account metadata and date suffixes. Missing or oversized files preserve the original title. Descriptive task names are preserved; task file content is never executed. New relay processes load this behavior.
