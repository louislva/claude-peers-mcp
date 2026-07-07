# claude-peers Workflow Improvements — Implementation Spec

**Date**: 2026-04-17
**Status**: spec-only, not yet implemented
**Applies to**: `manuel-goepfi/claude-peers-mcp` fork + `~/.claude/` user config

## Context

Tonight we shipped the inbox fix: `/poll-by-pid` endpoint + `UserPromptSubmit` drain hook + `Stop` hook `asyncRewake` autonomous wake (opt-in via "standby" summary keyword). The fundamental coordination gap is closed. What remains is **workflow polish + one real correctness gap**.

Party-mode review identified 6 findings worth implementing, listed here in ship order by value/effort ratio. One finding (#3: pane-border color) was discarded as complex-for-marginal-value.

This spec is self-contained: a future session with zero context should be able to implement each item from what's written here.

---

## #7 — Peer-identity rehydration on restart (BLOCKER-CLASS)

### Problem

When a Claude session dies (crash, quit, broker restart) and the user relaunches in the same tmux pane, the new MCP server registers as a **new peer with a new ID**. Any undelivered messages addressed to the old peer ID are **permanently orphaned** — `selectUndelivered(peer.id)` never sees them because the peer row they reference is gone.

Live evidence: 87 undelivered messages in `~/.claude-peers.db` as of 2026-04-17, all addressed to peer IDs that no longer exist (dead from prior crashes/restarts). Messages include real work handoffs like *"HANDOFF: Phase 5 reconciliation COMPLETE. PRD at v0.4 FINAL"* — genuinely lost coordination.

### Solution

On `/register`, if the incoming registration matches a recently-dead peer by `(tmux_session, tmux_window_index, tmux_window_name, cwd)`, inherit that peer's ID and any undelivered mail addressed to it.

### Implementation

**Files**:
- `broker.ts` — handleRegister (lines ~315-337)

**Logic**:

```ts
function handleRegister(body: RegisterRequest): RegisterResult {
  const pidErr = verifyPidUid(body.pid);
  if (pidErr) return { ok: false, status: 403, error: `S3 PID/UID rejected: ${pidErr}` };
  if (body.summary && utf8Bytes(body.summary) > MAX_SUMMARY_BYTES) {
    return { ok: false, status: 413, error: `summary exceeds ${MAX_SUMMARY_BYTES} bytes` };
  }

  const now = new Date().toISOString();

  // REHYDRATION: look for a recently-dead peer with matching location tuple.
  // "Recently-dead" = last_seen within REHYDRATE_WINDOW_MS AND pid no longer alive.
  // Match strictness: requires identical tmux triple + cwd to prevent cross-pane
  // ID inheritance. A peer relaunched in a different tmux pane = new identity.
  let inheritedId: string | null = null;
  if (body.tmux_session && body.tmux_window_index !== null && body.tmux_window_name) {
    const candidates = db.query(`
      SELECT id, pid, last_seen FROM peers
      WHERE tmux_session = ? AND tmux_window_index = ? AND tmux_window_name = ?
        AND cwd = ? AND pid != ?
      ORDER BY last_seen DESC LIMIT 3
    `).all(
      body.tmux_session,
      body.tmux_window_index,
      body.tmux_window_name,
      body.cwd,
      body.pid
    ) as { id: string; pid: number; last_seen: string }[];

    for (const c of candidates) {
      const ageMs = Date.now() - new Date(c.last_seen).getTime();
      if (ageMs > REHYDRATE_WINDOW_MS) continue;  // too stale
      try { process.kill(c.pid, 0); continue; } catch {}  // alive peer — not ours to inherit
      // Inherit this ID. Delete the old row; we'll re-insert with the same ID.
      inheritedId = c.id;
      deletePeer.run(c.id);
      buckets.delete(c.id);
      console.error(`[broker] rehydrate: new pid=${body.pid} inherits id=${c.id} from dead pid=${c.pid} (age=${ageMs}ms)`);
      break;
    }
  }

  const id = inheritedId ?? generateId();
  const token = generateToken();

  // Existing PID-dedup (unchanged)
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing && existing.id !== id) {
    deletePeer.run(existing.id);
    buckets.delete(existing.id);
  }

  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.name ?? null,
    body.tmux_session ?? null, body.tmux_window_index ?? null, body.tmux_window_name ?? null,
    body.summary, now, now, token);
  return { ok: true, value: { id, token } };
}
```

**New constant** near line 57:

```ts
const REHYDRATE_WINDOW_MS = 3600_000;   // 1h — after this, orphan the mail
```

### Tests

Add to `tests/delivery.test.ts` under the live-broker block:

1. **"rehydration: new peer in same tmux location inherits old peer's ID"** — register peer A with tmux session/window/pane/cwd, kill its PID, register peer B with SAME tuple → expect `B.id === A.id`.
2. **"rehydration: undelivered mail survives"** — send msg to peer A, kill A, register B with A's location, drain via `/poll-by-pid` using B's new pid → expect A's messages in B's inbox.
3. **"rehydration: different tmux pane does NOT inherit"** — A in `rag:claude.1`, relaunch as `rag:claude.2` → new ID, A's mail stays orphaned.
4. **"rehydration: stale peer (>1h) does NOT inherit"** — backdate peer's `last_seen` to 2h ago, relaunch → new ID.
5. **"rehydration: live peer with matching location does NOT inherit"** — peer A still running, register a clone → new ID for the clone, A keeps its identity.

### Rollout

No breaking changes. Inheritance is additive. Existing tests continue to pass. Bump broker ensureBroker restart to pick up the change.

### Risk

- **PID reuse within 1h window**: if Linux recycles peer A's PID to an unrelated process that later re-registers, the dedup check (`existing.id !== id`) still deletes A's row. Benign.
- **Multiple restarts within 1h**: fine — `last_seen DESC LIMIT 3` + liveness check picks the most recent dead one.

---

## #1 — SessionStart greeting

### Problem

New Claude launched via `ccp` has zero awareness of who else is running until the user manually asks `list_peers`. Cognitive overhead for coordination.

### Solution

`SessionStart` hook injects a compact peer roster into the session's opening context.

### Implementation

**New file**: `~/.claude/hooks/claude-peers-session-greeting.sh`

```bash
#!/bin/bash
# SessionStart hook — inject current peer roster at session open.
# Soft-fail on every error path.

set -u
trap 'exit 0' ERR

# Soft-guard: sqlite required
command -v sqlite3 >/dev/null 2>&1 || exit 0
[[ -f "$HOME/.claude-peers.db" ]] || exit 0

# Query live peers (exclude self by pid walk-up if possible)
# Can't always determine self at SessionStart — MCP server may not be registered
# yet. So list everyone; the human reader filters mentally.
ROWS=$(sqlite3 -separator '|' "$HOME/.claude-peers.db" \
  "SELECT COALESCE(name,'(unnamed)'), tmux_session, substr(summary,1,60)
   FROM peers
   ORDER BY last_seen DESC LIMIT 15" 2>/dev/null) || exit 0

[[ -z "$ROWS" ]] && exit 0

PEERS=""
while IFS='|' read -r name tmux summary; do
  PEERS+="  - ${name} [${tmux:-no-tmux}]"
  [[ -n "$summary" ]] && PEERS+=": ${summary}"
  PEERS+=$'\n'
done <<< "$ROWS"

CONTEXT="claude-peers roster at session start:
${PEERS}
Call list_peers for full detail, find_peer name=X to resolve, set_summary to set your own context."

jq -n --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}' 2>/dev/null || exit 0
```

**Settings wiring** (`~/.claude/settings.json`, merge into existing `hooks`):

```json
"SessionStart": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "/home/manzo/.claude/hooks/claude-peers-session-greeting.sh"
      }
    ]
  }
]
```

### Tests

Shell harness at `~/claude-peers-mcp/tests/greeting.test.sh`:

1. Empty DB → hook exits 0 silently, no stdout
2. DB with 3 peers → hook emits JSON with `additionalContext` containing all 3 names
3. sqlite3 missing → exits 0 silently
4. DB locked → exits 0 silently (errors suppressed)

### Rollout

Create file, chmod +x, add to settings.json, relaunch any test session to verify.

---

## #4 — `peers-doctor` diagnostic command

### Problem

When something's off ("why am I not receiving peer mail?"), there's no quick-path diagnostic. User has to grep logs, check ps, test endpoints manually.

### Solution

A shell script that runs all checks in sequence and prints `[✓]`/`[✗]` per check with one-line remediation hints.

### Implementation

**New file**: `~/claude-peers-mcp/bin/peers-doctor.sh` (and symlink from `~/.local/bin/peers-doctor` or `~/bin/peers-doctor`)

Checks:

1. Broker process alive: `pgrep -f 'bun.*broker.ts'`
2. Broker HTTP responding: `curl -sf http://127.0.0.1:7899/health`
3. Broker DB readable: `sqlite3 -readonly ~/.claude-peers.db 'SELECT count(*) FROM peers'`
4. Current session has an MCP server registered: `pgrep -P <parent-claude-pid> -f 'claude-peers-mcp/server.ts'`
5. UserPromptSubmit hook registered: `jq '.hooks.UserPromptSubmit' ~/.claude/settings.json`
6. Stop hook registered: `jq '.hooks.Stop' ~/.claude/settings.json`
7. drain-peer-inbox.sh executable: `test -x ~/.claude/hooks/drain-peer-inbox.sh`
8. standby-watcher.sh executable: `test -x ~/.claude/hooks/claude-peers-standby-watcher.sh`
9. `/poll-by-pid` endpoint responds: curl with this session's MCP PID → expect 200
10. Latency-log pattern present in recent broker log: `grep -c 'via=poll-by-pid' ~/.claude-peers-broker.log | tail -1`
11. Stale lock-file count (warn if >20): `ls /tmp/claude-peers-standby-*.lock 2>/dev/null | wc -l`

Output format:

```
claude-peers doctor — 2026-04-17T12:34:56Z
[✓] broker process alive (pid 1234)
[✓] broker /health responding (200, 19 peers)
[✓] broker DB readable (87 messages, 19 peers)
[✗] current session NOT registered — no MCP child of claude pid 5678
    → relaunch this session with `ccp` (not bare `claude`)
[✓] UserPromptSubmit hook wired
[✓] Stop hook wired
[✓] drain-peer-inbox.sh executable
[✓] standby-watcher.sh executable
[✓] /poll-by-pid responds 200 for my MCP
[✓] 247 deliveries in broker log
[!] 207 stale lock files in /tmp — consider cleanup
    → find /tmp -name 'claude-peers-standby-*.lock' -mtime +1 -delete

9/10 checks pass. 1 error, 1 warning.
```

### Tests

Optional — the script is pure diagnostic, errors are user-facing not silent. Acceptable to ship without unit tests. Manual verification on a healthy machine + a broken setup (broker killed).

### Rollout

Symlink into `$PATH`. Add invocation to README + cheatsheet. Run once after every fork update to catch drift.

---

## #5 — Broadcast scope in send_message

### Problem

To message every peer in a tmux session, Claude has to call `list_peers`, filter client-side, then loop `send_message` per peer. Clunky and not atomic.

### Solution

New broker endpoint `/broadcast-message` + MCP tool `broadcast_message` that fanout server-side by scope.

### Implementation

**Broker** (`broker.ts`):

```ts
// New prepared statement
const selectPeersForBroadcast = db.prepare(`
  SELECT id FROM peers
  WHERE (? IS NULL OR tmux_session = ?)
    AND (? IS NULL OR git_root = ?)
    AND (? IS NULL OR lower(name) LIKE '%' || lower(?) || '%')
    AND id != ?
`);

interface BroadcastRequest {
  tmux_session?: string | null;
  git_root?: string | null;
  name_like?: string | null;
  text: string;
}

function handleBroadcast(authedFromId: string, body: BroadcastRequest): { ok: boolean; sent: number; error?: string } {
  if (typeof body.text !== "string") return { ok: false, sent: 0, error: "text must be string" };
  if (utf8Bytes(body.text) > MAX_MSG_BYTES) return { ok: false, sent: 0, error: `text exceeds ${MAX_MSG_BYTES} bytes` };

  // At least one scope filter must be provided — refuse unfiltered global broadcast.
  if (!body.tmux_session && !body.git_root && !body.name_like) {
    return { ok: false, sent: 0, error: "at least one scope filter required (tmux_session, git_root, or name_like)" };
  }

  const targets = selectPeersForBroadcast.all(
    body.tmux_session ?? null, body.tmux_session ?? null,
    body.git_root ?? null, body.git_root ?? null,
    body.name_like ?? null, body.name_like ?? null,
    authedFromId
  ) as { id: string }[];

  const now = new Date().toISOString();
  let sent = 0;
  db.transaction(() => {
    for (const t of targets) {
      insertMessage.run(authedFromId, t.id, body.text, now);
      sent++;
    }
  })();
  return { ok: true, sent };
}
```

**Route case** (broker.ts in the switch):

```ts
case "/broadcast-message":
  return Response.json(handleBroadcast(auth.id, body as unknown as BroadcastRequest));
```

**MCP tool** (`server.ts`):

```ts
{
  name: "broadcast_message",
  description: "Send a message to multiple peers at once by scope (tmux session, git repo, or name substring). At least one scope filter is required.",
  inputSchema: {
    type: "object" as const,
    properties: {
      text: { type: "string", description: "Message text" },
      tmux_session: { type: "string", description: "Target all peers in this tmux session" },
      git_root: { type: "string", description: "Target all peers in this git repo" },
      name_like: { type: "string", description: "Target peers whose name contains this substring (case-insensitive)" }
    },
    required: ["text"]
  }
}

// In the case block:
case "broadcast_message": {
  const args2 = args as { text: string; tmux_session?: string; git_root?: string; name_like?: string };
  try {
    const result = await brokerFetch<{ ok: boolean; sent: number; error?: string }>("/broadcast-message", {
      from_id: myId,
      text: args2.text,
      tmux_session: args2.tmux_session ?? null,
      git_root: args2.git_root ?? null,
      name_like: args2.name_like ?? null,
    });
    if (!result.ok) {
      return { content: [{ type: "text", text: `Broadcast failed: ${result.error}` }], isError: true };
    }
    const pending = await drainPendingMessages();
    return { content: [{ type: "text", text: `Broadcast sent to ${result.sent} peer(s).${pending ?? ""}` }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}
```

### Tests

`tests/delivery.test.ts` additions:

1. **broadcast to tmux_session delivers to all matching peers** — 3 peers in `rag`, 1 in `prd`; broadcast with `tmux_session: "rag"` → 3 messages in the DB.
2. **broadcast excludes the sender** — sender in scope still doesn't receive its own broadcast.
3. **broadcast rejects unfiltered** — call with no scope filter → 400.
4. **broadcast with `name_like` does substring+case-insensitive match** — peers "reviewer.1", "REVIEWER.2", "coder.1"; `name_like: "review"` → 2 matches.
5. **broadcast size cap applies** — 33KB text → 413.

### Rollout

Broker restart required (new endpoint). Already-running MCP servers won't have the new tool until their session relaunches — acceptable; old sessions fall back to looping `send_message`.

---

## #2 — Delivery confirmation

### Problem

`send_message` currently returns `{ok: true}` with no indication of whether / when the message was received. Sender is blind after send.

### Solution

New endpoint `/message-status` returns `{id, delivered, delivered_at, via}`. MCP tool `message_status(id)` exposes it. Automatically invoked after `send_message` for immediate feedback.

### Implementation

**Broker**:

```ts
const selectMessageStatus = db.prepare(`
  SELECT id, delivered, delivered_at FROM messages WHERE id = ? AND from_id = ?
`);

function handleMessageStatus(authedFromId: string, body: { ids: number[] }): {
  ok: boolean;
  statuses: { id: number; delivered: boolean; delivered_at: string | null }[]
} {
  if (!Array.isArray(body.ids)) return { ok: false, statuses: [] };
  const statuses = body.ids.map(id => {
    const row = selectMessageStatus.get(id, authedFromId) as
      { id: number; delivered: number; delivered_at: string | null } | null;
    return row
      ? { id: row.id, delivered: row.delivered === 1, delivered_at: row.delivered_at }
      : { id, delivered: false, delivered_at: null };
  });
  return { ok: true, statuses };
}
```

**send_message response change** (`broker.ts`): include the inserted message `id` in the response so the caller can query later.

```ts
// handleSendMessage — change return type
function handleSendMessage(authedFromId: string, body: SendMessageRequest):
  { ok: boolean; id?: number; error?: string } {
  // ... existing validation ...
  const result = insertMessage.run(authedFromId, body.to_id, body.text, new Date().toISOString());
  return { ok: true, id: Number(result.lastInsertRowid) };
}
```

**MCP `send_message` tool**: after successful send, poll `/message-status` once after 2s and include delivery status in the tool's text output:

```
"Message sent (id=694). Status after 2s: delivered at 14:22:07 (latency 1.8s)."
```

or if still undelivered:

```
"Message sent (id=694). Status after 2s: queued (not yet delivered — target peer may be idle)."
```

### Tests

1. **send_message returns message id** — `result.id` is a number > 0.
2. **message_status for undelivered** — send, immediately query status → `delivered: false, delivered_at: null`.
3. **message_status after ack** — send, target drains via poll-by-pid, status query → `delivered: true, delivered_at: <iso>`.
4. **message_status for other peer's message** — peer A's message id queried by peer B → returns undelivered/null (scoped by from_id, not readable by non-sender).

### Rollout

Backward compat: existing clients ignore the new `id` field in send_message response. New tool call is additive.

---

## #6 — Hook self-install (`setup.sh`)

### Problem

Manual steps to reproduce the current setup on another machine: clone fork, bun install, copy hook scripts, chmod, edit settings.json, update bashrc, update tmux.conf. Error-prone and undocumented.

### Solution

Idempotent `setup.sh` in the fork root that does:

1. Verifies bun installed; installs via curl if missing
2. Runs `bun install` in the fork
3. Copies `hooks/*.sh` from the fork's `hooks/` subdir to `~/.claude/hooks/` (chmod +x each)
4. Merges hook entries into `~/.claude/settings.json` using `jq` — idempotent (checks existence before adding)
5. Appends `_ccp_*` functions + `_ccp_autoname` to `~/.bashrc` if not already present (detect via marker comment)
6. Appends pane-border config to `~/.tmux.conf` if not already present (detect via marker comment)
7. Starts the broker once to verify it works
8. Prints a summary of what was installed / skipped-already-present

### Implementation

Prerequisites: move current hook scripts from `~/.claude/hooks/drain-peer-inbox.sh` + `...standby-watcher.sh` into `~/claude-peers-mcp/hooks/` in the fork. Symlink or copy to `~/.claude/hooks/` during setup.

```bash
#!/bin/bash
# claude-peers setup — idempotent installer

set -eu
FORK_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
MARKER_BASHRC="# >>> claude-peers setup BEGIN"
MARKER_TMUX="# >>> claude-peers tmux BEGIN"

# 1. bun check
command -v bun >/dev/null 2>&1 || {
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
}

# 2. deps
cd "$FORK_DIR" && bun install

# 3. hooks
mkdir -p "$CLAUDE_DIR/hooks"
for h in "$FORK_DIR/hooks/"*.sh; do
  cp -f "$h" "$CLAUDE_DIR/hooks/"
  chmod +x "$CLAUDE_DIR/hooks/$(basename "$h")"
  echo "  installed $(basename "$h")"
done

# 4. settings.json merge (via jq)
SETTINGS="$CLAUDE_DIR/settings.json"
[[ -f "$SETTINGS" ]] || echo '{"hooks":{}}' > "$SETTINGS"
jq '
  .hooks.UserPromptSubmit //= [] |
  .hooks.Stop //= [] |
  .hooks.SessionStart //= [] |
  .hooks.UserPromptSubmit |= (if any(.hooks[]?; .command | endswith("drain-peer-inbox.sh")) then . else . + [{"hooks":[{"type":"command","command":"'"$CLAUDE_DIR"'/hooks/drain-peer-inbox.sh"}]}] end) |
  .hooks.Stop |= (if any(.hooks[]?; .command | endswith("claude-peers-standby-watcher.sh")) then . else . + [{"hooks":[{"type":"command","command":"'"$CLAUDE_DIR"'/hooks/claude-peers-standby-watcher.sh","asyncRewake":true,"timeout":3600}]}] end) |
  .hooks.SessionStart |= (if any(.hooks[]?; .command | endswith("claude-peers-session-greeting.sh")) then . else . + [{"hooks":[{"type":"command","command":"'"$CLAUDE_DIR"'/hooks/claude-peers-session-greeting.sh"}]}] end)
' "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"

# 5. bashrc append (marker-guarded)
if ! grep -qF "$MARKER_BASHRC" "$HOME/.bashrc"; then
  cat "$FORK_DIR/templates/bashrc-fragment.sh" >> "$HOME/.bashrc"
fi

# 6. tmux conf append (marker-guarded)
if ! grep -qF "$MARKER_TMUX" "$HOME/.tmux.conf" 2>/dev/null; then
  cat "$FORK_DIR/templates/tmux-fragment.conf" >> "$HOME/.tmux.conf"
fi

# 7. broker smoke test
bun "$FORK_DIR/broker.ts" &
BROKER_PID=$!
sleep 2
curl -sf http://127.0.0.1:7899/health >/dev/null && echo "  broker OK (pid $BROKER_PID)" || {
  echo "  broker FAILED to respond"
  exit 1
}

echo "Done. Restart shell + run \`tmux source-file ~/.tmux.conf\` to activate."
```

Also create `templates/bashrc-fragment.sh` and `templates/tmux-fragment.conf` in the fork mirroring the current snippets.

### Tests

Manual: run on a clean VM/container, verify everything works. Unit-testing an installer is overkill.

### Rollout

Low priority — single-machine user, only matters when onboarding a second machine.

---

## #8 — Undelivered-mail TTL for LIVE-but-non-draining peers (CORRECTNESS GAP)

> **STATUS: SHIPPED** — `f6952f1` to `manzo/main` (2026-06-28). Lever A (undelivered-mail TTL gated on `receiver_mode='unknown'`) + Lever B1 (broadcast excludes `receiver_mode='unknown'`) live after broker restart. Lever B2 resolved to **B2b — no daemon change** (the pieces-bridge is send-only by design; A+B1 fully close the leak). Live-verified: bridge is the sole `unknown`-receiver peer and is excluded from broadcast targets; 0 undelivered mail to unknown-receivers. Full suite 516 pass / 0 fail. The implementation matches the design below; the lossy-cap risk was retired by the `receiver_mode='unknown'` gate (real idle peers never lose mail).

### Problem

The 2026-06 reaper hardening bounded undelivered mail on **dead** seats (`deadSeatMailExpired` — a dead seat with pending mail is preserved for `DEAD_MAIL_TTL_MS` then reaped, row + mail). It did **not** bound mail to a peer whose row stays **alive** but **never drains**.

A peer can heartbeat (keeping `last_seen` fresh, so the reaper never reaps its row) while having no receive path at all — `receiver_mode = unknown`, `client_type = unknown`, `last_drain_at` empty. Mail addressed to it is then trapped in a three-way no-man's-land:

- the reaper won't reap the **row** (it heartbeats — not stale, not pid-dead),
- the orphan-mail sweep won't delete the **mail** (`to_id` IS a live peer row),
- the `deadSeatMailExpired` TTL never fires (the seat isn't dead),
- the delivered-mail TTL never fires (these rows are `delivered = 0`).

Result: **undelivered mail to a live-but-non-draining peer has no upper bound.**

Live evidence (2026-06-28): `pieces-bridge.linux` (`scripts/clause5-pieces-bridge/daemon.ts`, a one-way Pieces→claude-peers bridge) registered a receivable seat and heartbeats, but never drains. 7 messages (mostly stale fleet broadcasts, oldest 2026-06-21 — 7 days) sat at `delivered = 0` with no mechanism able to clear them. Purged manually; the mechanism is unfixed.

### Solution

Two independent levers — (B) is the real root-cause fix; (A) is the safety-net backstop. Either alone helps; both is correct.

**(A) Undelivered-mail age cap (backstop).** In `cleanStalePeers`, after the orphan-mail sweep, also delete undelivered mail older than a TTL **regardless of recipient liveness**:

```ts
// Undelivered-mail age cap: a peer that heartbeats but never drains (receiver_mode
// unknown, no hook) traps mail forever — the orphan sweep skips it (row is live)
// and the dead-seat TTL skips it (seat is alive). Bound it by absolute age.
const undelivCutoff = new Date(Date.now() - UNDELIVERED_MSG_TTL_MS).toISOString();
const stale = db.run(
  "DELETE FROM messages WHERE delivered = 0 AND sent_at < ?",
  [undelivCutoff]
);
if (stale.changes > 0) {
  console.error(`[broker] undelivered-mail TTL: dropped ${stale.changes} message(s) older than ${UNDELIVERED_MSG_TTL_MS}ms (recipient never drained)`);
}
```

New constant near the other TTLs, env-overridable via `positiveEnvMs` (the established pattern), default e.g. 7d:
```ts
const UNDELIVERED_MSG_TTL_MS = positiveEnvMs("CLAUDE_PEERS_UNDELIVERED_MSG_TTL_MS", 604_800_000);
```
This must sit **inside the mail-purge try/catch stage** of `cleanStalePeers` so a throw is crash-isolated (the per-mechanism isolation added 2026-06-28). **Trade-off to weigh before shipping:** this is a *lossy* cap — it drops mail a genuinely-busy-but-slow recipient hasn't pulled yet. 7d is generous enough that only never-draining recipients hit it, but the value must be ≥ the longest legitimate idle-then-return window. Consider gating the delete on `receiver_mode = 'unknown'` (only cap mail to peers with no known receive path) to make it non-lossy for real Claude/Codex/Gemini peers — at the cost of leaving mail to a *temporarily* mis-detected peer.

**(B) Don't route broadcasts to non-receiving peers (root cause).** A one-way bridge that only *publishes* should not register a *receivable* seat, or `handleBroadcast` (#5) should exclude `receiver_mode = 'unknown'` / `client_type = 'unknown'` peers from its target set. Fixing this stops the accumulation at the source — no mail is ever queued to a dead-end recipient in the first place. Cheaper and non-lossy. The bridge's own registration (`scripts/clause5-pieces-bridge/daemon.ts`) is the place to either skip registration or mark itself send-only.

### Tests
- **(A)** `:memory:` DB test: an undelivered row with `sent_at` older than the TTL is dropped on the sweep; a recent undelivered row and any delivered row are preserved. Planted-error VoV: dropping the TTL clause leaves the stale row (test goes red).
- **(A) wiring sentinel** (matches the existing block in `phase-b-r5b-ttl-reaper.test.ts`): assert `cleanStalePeers` source contains the `DELETE FROM messages WHERE delivered = 0 AND sent_at` clause AND that it lives inside the mail-purge try-stage.
- **(B)** broadcast test: a peer with `receiver_mode = 'unknown'` is excluded from `handleBroadcast` targets; a normal peer is included.

### Rollout
Broker restart activates (A) (lives in the reaper, same as the other TTLs). (B) needs the bridge daemon restart and/or a `handleBroadcast` change + broker restart. Backward-compatible; additive.

### Risk
- **(A) over-eager drop**: a real recipient idle > TTL loses mail. Mitigation: generous default (7d) and/or the `receiver_mode = 'unknown'` gate above.
- **(B) under-detection**: a peer mis-classified as `unknown` (e.g. a Claude that registered before its receiver_mode resolved) would be wrongly excluded from broadcasts. Mitigation: only exclude peers whose `receiver_mode` has been `unknown` for longer than one heartbeat interval, or treat `unknown` as receivable but cap its mail via (A).

---

## Ship order recommendation

| Phase | Items | Rationale |
|---|---|---|
| **Ship next** | #7 (rehydration) | Closes real data-loss bug. 1h. |
| **Soon** | #1 (greeting) + #4 (doctor) | Daily UX + diagnostic gold. ~1.5h combined. |
| **When needed** | #5 (broadcast) | Natural when you actually want cross-session blast. ~1h. |
| **Blocked on #7** | #2 (delivery confirmation) | Needs rehydration to be meaningful — until then, status lies when target peer crashed. ~30min. |
| **Ship next (correctness)** | #8 (undelivered-mail TTL) | Closes the live-but-non-draining-peer leak (pieces-bridge, 2026-06-28). Backstop (A) ~30min; root-cause (B) ~30min. |
| **Defer** | #6 (setup.sh) | Single-machine use; only when onboarding second machine. ~1.5h. |

**Total implementation budget** (excluding #6): ~4h for items that make your daily workflow materially better.

## Testing protocol

Every item's test block follows TEST-01: happy path + error/edge cases + regression guard. Every new test file requires pr-test-analyzer review per TEST-03. No item ships without `bun test` at 100%.

## Rollback

Every item is additive with no breaking schema changes. Rollback = revert the commit. Rehydration (#7) uses existing schema — nothing to migrate down.
