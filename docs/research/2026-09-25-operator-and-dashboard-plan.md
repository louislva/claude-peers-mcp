---
date: 2026-09-25
produced_by: Claude Opus 5.5 (peer 9d1d49ec78634d48), with Kiel
method: Design draft. Built on the Codex wake-tools research (~/Developer/research/2026-09-25-codex-native-wake-tools.md), the live broker schema (~/.claude-peers.db), the Claude desktop app's session tools, and inspiration from BuilderIO/skills (agent-watchdog "relay sparingly").
status: DRAFT for Kiel + Astra review. Nothing built.
---

# claude-peers operator, wake-ups, and human dashboard

## Problem
The broker stores messages durably, but an **idle** GUI session never finds out about new mail. The hooks only fire during a turn someone else started. A 5-minute cron heartbeat did wake sessions, but it filled the desktop GUI with "hook blocked your prompt" cards (Kiel, 2026-09-25). Humans also can't see what agents are saying to each other.

## Native wake-up tools (verified or reported)
| Harness | Tool | Who can call it | Status |
|---|---|---|---|
| Claude desktop | `send_message` (session_mgmt), target `local_…` = `CLAUDE_CODE_HOST_SESSION_ID` | only an attended Claude desktop session | tool schema read; says "delivered = turn started" |
| Codex app | `send_message_to_thread` | a Codex task | reported by Codex to Kiel 2026-09-25 ("visible follow-up message, can start or continue that task's work"); params not yet seen |
| Codex CLI | `codex queue --thread <id|name> --message <text>` (v0.153.4, uses app-server `turn/start`) | **any process** | help text verified; waking an idle open GUI thread NOT yet tested |

## Principle: the model is only the wake-up hand
Everything an operator does is deterministic. It needs to be a model session only because some wake-up tools are offered only to model sessions. So:
- **Zero judgment.** The operator sees only `(message id, recipient)`, never message text, and it sends a fixed line: `claude-peers: message #N waiting`. Nothing in its input path can instruct it.
- **The broker is the only record.** A wake-up says "go look"; delivery and ack stay in the hooks and inbox. A lost or duplicate wake-up can never lose or double a message.
- **Waiting is free.** A background watch script (a SQL query on the broker) triggers the operator's turn only when there's something to wake. No polling turns.
- **Codex needs no operator** if `codex queue` wakes idle threads: a plain daemon can do it. Only Claude needs an LLM operator.

## Broker changes (fork)
1. `peers`: add `harness` (claude-desktop | claude-cli | codex-app | codex-cli), `host_session_id` (Claude `local_…` / Codex thread id), `wake_policy` (off | immediate | batched), `display_name` (Astra, Rook, …).
2. `messages`: add `reply_to` (message id) and `thread_id` (conversation) for the dashboard; `woken_at`, `wake_attempts`, `wake_error`; `urgency` (normal | urgent).
3. CLI: `pending-wakes` (unacked, not yet woken, recipient wake_policy != off, rate-limit ok) and `mark-woken`.
4. Loop guard: per-recipient rate limit, plus a cap on the number of wake-driven replies in a row between the same pair.

## Skill suite (proposal)
| Skill | Does |
|---|---|
| `peers-operator start / stop / status` | Starts or stops the operator (Claude session + watch script; Codex daemon). Status shows last run, backlog, failed wakes, and who can be woken. |
| `peers-opt-in / opt-out` | Registers this session's harness and host id and sets its wake policy. Opt-out means messages are still stored but never wake the session. |
| `peers-dnd` | Do-not-disturb for this session until a time, or until the current task ends. Urgent messages can override it if Kiel allows. |
| `peers-send` | Sends a message with urgency, reply_to and an optional structured type (review-request with artifact path + sha, verdict, status, question). |
| `peers-roster` | Shows who's online, their harness, wake policy, last seen, and unacked backlog. |
| `peers-digest` | Human summary of agent traffic since the last digest (on request, or pushed to Telegram). |
| `peers-export` | Writes a conversation thread to disk (docs/research) as the durable record. |
| later: `peers-watchdog` | Opt-in reviewer that follows one thread or agent and flags stale asks, loops, and unanswered review requests. Inspired by BuilderIO agent-watchdog, and "relay sparingly" applies. |

## Human dashboard (read-only v1)
- **Threads view:** conversations grouped by participants and reply chains, with each message's lifecycle: sent → woken → delivered → acked → replied.
- **Attention panel:** unacked messages older than X, review requests with no verdict, failed wake-ups, loops that tripped the guard.
- **Roster:** online state, harness, wake policy, DND.
- **Controls (v2, gated):** pause the operator, mute an agent. There's no "send as Kiel" at first. Messages entered on the dashboard must carry a verified human origin, and agents must still treat peer text as data.
- **Data:** read the SQLite broker directly (1,146 messages since 2026-03-23). Serve locally and publish behind Cloudflare Access (`--audience work`) via the publish convention if Kiel wants it off-machine.

## Open questions
1. Codex `send_message_to_thread`: its parameters, where the thread id comes from, whether it wakes an **idle** thread, and whether it works across app and CLI threads.
2. Does `codex queue` wake an idle thread that's open in the Codex app? Test on a throwaway thread.
3. Should agent-to-agent conversation text be shown to humans verbatim? Messages can contain client data, so the dashboard needs Access gating.
4. Where the skills live: the fork's `plugin/` (Claude) plus a Codex skill copy.

## Test plan (needs Kiel's OK: touches real sessions)
1. Claude → spare Claude desktop session: send a fixed wake-up line, check a turn started and the hook delivered the message.
2. `codex queue` → throwaway idle Codex thread: check it wakes.
3. Codex `send_message_to_thread` → a Claude session? (Probably not possible; confirm.)

## Wake rules (added after Astra #1210)
- **Separate states.** Wake state (`woken_at`, `wake_attempts`, `wake_error`) is kept apart from delivery (hook/inbox lease) and ack (explicit). A message can be woken but not acked, or acked without ever being woken.
- **Busy recipient.** Skip the wake-up if the recipient has a live lease or was seen in the last N seconds. The Stop hook already delivers at the next turn boundary.
- **Dedupe.** At most one wake-up per message. Batch per recipient: one line lists all pending ids.
- **Retry.** Only when `wake_error` is set; exponential backoff; max 3 attempts; then surface the message on the dashboard attention panel.
- **Suppress.** DND or `wake_policy=off` means never wake.
- **Loop guard.** Per-recipient rate limit, plus a cap on wake-driven replies in a row between the same pair.
- **Capability vs tested (2026-09-25).** Claude `send_message`: schema read, not live-tested. `codex queue`: help text only. Codex `send_message_to_thread` (+ `list_threads`/`read_thread`/`wait_threads`): Astra reports they're callable; wake behaviour not tested.

## Live observation 2026-09-25 (Kiel's screenshot, first operator attempt)
- A Sonnet 5 session in **Auto** permission mode, acting as operator, used the native `SendMessage` tool to reach the Opus session "Airtable Fixes: temporal engine" (in **bypassPermissions** mode).
- Result: "Cross-session message held for approval (recipient: uds:/tmp/cc-socks/69383.sock). The recipient's session has different permission-mode settings, so their user must approve it before Claude sees it."
- **Verified:** SendMessage delivers over a per-session Unix socket (`/tmp/cc-socks/<pid>.sock`). The harness has a built-in approval gate: a message from a session in a different permission mode is held for a human.
- **Design impact:**
  - A fully automatic wake-up only works when the operator's permission mode **matches** each target's. Otherwise every wake-up needs Kiel to click approve, which is still less noisy than a cron but not hands-free.
  - The gate is a good security property: a lower-privilege session can't push text into a bypass session. Keep it. Don't look for ways around it.
  - Options: (a) run one operator per permission mode in use; (b) standardise agent sessions on one mode; (c) accept an approval click for cross-mode wake-ups, which works as a visible human checkpoint.
- Not yet known: whether the held message, once approved, starts a turn in an idle recipient.
- **Test A PASSED (2026-09-25):** the "Operator agent with Claude peers" session (bypass mode, `local_085fc697…`) sent `SendMessage` to this idle Opus session (bypass mode). It arrived as `<cross-session-message>` and **started a turn without approval**. Same mode means an automatic wake-up. Different mode means held for the user.
- **New primitive:** `SendMessage` has `notify_when_idle: true`, which sends one `[Cross-session idle notice]` when a local session goes idle. An operator can wait for a busy recipient to go idle and then deliver, with no polling. `ListAgents` shows each session as busy or idle.
- **Test B PASSED (2026-09-25 ~4:05 PM ET):** from this Claude session's shell, `codex queue --thread 01a0da28-f06c-7a62-b236-cf37ef228046 --message "..."` returned "Queued message 01a0da2b-…". Sol (the Codex task) replied "test B received" over claude-peers as msg #1222 (sent_at 20:05:01Z), a few seconds later. So **Claude → Codex needs no model**: any process can run `codex queue`. Still to confirm with Sol: was its task idle when this arrived (Astra's earlier send_message_to_thread test says yes, for that path)?
- **Test C PASSED (first form):** a background `until` script watching the broker for Sol's reply re-invoked this idle Claude session when the row landed. So a watch script can wake the Claude operator. The reusable form is `Monitor`, which expires after 30 minutes and has to be re-armed.

## Resulting architecture (post-tests)
- **Claude → Codex:** sender writes to the broker; a plain daemon (no model) runs `codex queue --thread <recipient> --message "claude-peers: message #N waiting"`.
- **Codex → Claude:** sender writes to the broker; the watch script in the Claude operator session sees it; the operator sends `SendMessage` to the recipient (same permission mode means automatic, different means held for Kiel).
- **Codex → Codex:** native `send_message_to_thread` (Sol), or the same daemon.
- **Claude → Claude:** native `SendMessage`, logged to the broker.
- The only model in the loop is the Claude operator, because only Claude has no external wake entry point.
- **Test B visual confirmation (Kiel's screenshot of Sol's Codex thread):** the `codex queue` message showed up in the Codex GUI thread and started a turn. **Authority finding:** it rendered as a plain **user bubble with no origin label**. In contrast, Astra's `send_message_to_thread` message carried "Sent by ChatGPT from another task". So in the GUI a `codex queue` wake-up **looks exactly like Kiel typed it**. This confirms Astra's R1.1 point 4, "automated-origin notice". Rules:
  - The wake-up text must identify itself: `[automated claude-peers wake — not from Kiel] message #N waiting`.
  - Prefer `send_message_to_thread` (labelled) when a Codex operator is available. Use `codex queue` only as the no-model fallback.
  - Recipients must never treat a wake-up line as user authority. It only says "check your inbox".
- **Origin metadata, checked in Sol's raw rollout** (`~/.codex/sessions/2026/09/25/rollout-…-01a0da28-….jsonl`):
  - `send_message_to_thread` reaches the model as a **tool output** wrapped in `<codex_delegation><source_thread_id>01a0cfaf-…</source_thread_id><input>…</input>`. The model sees the provenance.
  - `codex queue` reaches the model as `role:"user"`, `content_item_kinds:["user.text"]`, metadata `{"client_authored": false, "user_input_order": 7}`. That is **identical in shape** to Kiel's typed prompt (`{"client_authored": false, "user_input_order": 0}`, `user.text`). The model cannot tell them apart.
  - The only difference is below the model: the event `client_id`. Kiel's is a random UUID (`703daf9d-…`); the queue's is time-ordered and matches the queued-message id (`01a0da2b-aee8-…`). It's undocumented, not shown to the model, and unusable as a trust signal.
  - Conclusion: Kiel was right that the GUI hides metadata, but there is **no origin marker for `codex queue`**. The self-identifying wake text and "prefer send_message_to_thread" rules stand.

## Proposal after tests: one Claude operator only (Kiel's question, 2026-09-25)
- The Claude operator has a shell, so it wakes Codex recipients with `codex queue`, and it wakes Claude recipients with `SendMessage`. **No Codex operator is needed.**
- The unlabelled `codex queue` origin is acceptable because the wake line carries **no instructions**: a fixed `[automated claude-peers wake — not from Kiel] message #N waiting`. The real message arrives through the claude-peers inbox with its broker `from_id`, and it is still treated as untrusted peer data.
- Sol (the Codex operator) is optional. Keep it only if we later want Codex wakes to go through the labelled `send_message_to_thread`. A standing Sol heartbeat recreates the noise and token cost we just removed from the Claude side.
