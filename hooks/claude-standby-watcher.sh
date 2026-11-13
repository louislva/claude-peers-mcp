#!/usr/bin/env bash
# Stop hook with asyncRewake: keep an idle Claude session reachable for peer
# mail. A new Stop refreshes the existing watch instead of losing the re-arm
# behind the per-session lock.

set -u

positive_int() {
  local value="$1" fallback="$2"
  if [[ "$value" =~ ^[1-9][0-9]*$ ]]; then printf '%s\n' "$value"; else printf '%s\n' "$fallback"; fi
}

ACTIVE_SECONDS=$(positive_int "${CLAUDE_PEERS_STANDBY_ACTIVE_SECONDS:-3600}" 3600)
# Every idle Claude session runs one watcher, and each tick is a broker claim.
# 30s/120s keeps a 20+ session fleet near one claim per second in the fast
# window (2026-10-05: 10s/60s added ~2 claims/s to an already saturated broker).
POLL_INTERVAL=$(positive_int "${CLAUDE_PEERS_STANDBY_POLL_INTERVAL_SECONDS:-30}" 30)
IDLE_INTERVAL=$(positive_int "${CLAUDE_PEERS_STANDBY_IDLE_INTERVAL_SECONDS:-120}" 120)
LOCK_WAIT=$(positive_int "${CLAUDE_PEERS_STANDBY_LOCK_WAIT_SECONDS:-2}" 2)
# A watcher that cannot render must not hold the session's lock (and keep
# claiming its mail) for the life of the Claude process. After this many
# consecutive render failures it exits so a later Stop can arm a working one.
MAX_RENDER_FAILURES=$(positive_int "${CLAUDE_PEERS_STANDBY_MAX_RENDER_FAILURES:-3}" 3)
BROKER_PORT="${CLAUDE_PEERS_PORT:-7899}"
FALLBACK_HOME="${HOME:-${TMPDIR:-/tmp}}"

# Logging is set up BEFORE any early exit, on purpose.
#
# Every bail-out below used to be a bare `exit 0`. The Stop hook therefore
# reported success, Claude's transcript listed this script with no hookErrors,
# and no watcher existed — a failure that is invisible from every direction at
# once. Measured 2026-08-03: idle Claude lanes stopped waking for peer mail and
# the only way to find out why was to read the script.
LOG_DIR="${CLAUDE_CONFIG_DIR:-$FALLBACK_HOME/.claude}/logs"
mkdir -p "$LOG_DIR" 2>/dev/null
STANDBY_LOG="$LOG_DIR/standby-watcher.log"

# Exit without arming the watcher, leaving a trace. Still exit 0: a Stop hook
# must never block the turn. The point is that "did nothing" becomes visible.
bail() {
  printf '%s no-watch reason=%s session=%s claude_pid=%s\n' \
    "$(date -Iseconds)" "$1" "${SESSION_ID:-none}" "${CLAUDE_PID:-none}" >> "$STANDBY_LOG" 2>/dev/null
  exit 0
}

command -v jq >/dev/null 2>&1 || bail missing-jq

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
SERVER_PATH="$ROOT/server.ts"

# Never run from the inherited working directory. Claude starts this hook in the
# session's cwd, which can be a worktree that is removed while the watcher lives
# on; bun then refuses to start ("The current working directory was deleted")
# and every render fails. Measured 2026-10-05: one such watcher looped ~22 h,
# claiming the session's mail every poll. Every path below is absolute.
cd / 2>/dev/null || bail cwd-unavailable
BUN=$(command -v bun 2>/dev/null) || BUN=""
[[ -n "$BUN" ]] || bail missing-bun

child_server_pid() {
  ps -ewwo pid=,ppid=,args= 2>/dev/null | awk -v parent="$1" -v server="$SERVER_PATH" \
    '$2 == parent && index($0, server) > 0 { print $1; exit }'
}

# The server may run behind a stdio-guard wrapper (claude → mcp-stdio-guard.sh
# → bun server.ts). pgrep -f matches the WRAPPER too (its argv contains the
# server path), but the broker row carries the bun process's own pid — so any
# match must be descended to the actual `bun` process before use.
resolve_bun_pid() {
  local cand="$1" depth child
  for depth in 1 2 3; do
    [[ -z "$cand" ]] && return 1
    if [[ "$(ps -p "$cand" -o comm= 2>/dev/null)" == "bun" ]]; then
      echo "$cand"; return 0
    fi
    child=$(pgrep -P "$cand" -f 'claude-peers-mcp/server\.ts' 2>/dev/null | head -1)
    cand="$child"
  done
  return 1
}

HOOK_INPUT=""
if [[ ! -t 0 ]]; then HOOK_INPUT=$(cat 2>/dev/null || true); fi
SESSION_ID=""
if [[ -n "$HOOK_INPUT" ]] && command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(printf '%s' "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
fi

CLAUDE_PID="${CLAUDE_PEERS_STANDBY_CLAUDE_PID:-$PPID}"
if [[ -z "${CLAUDE_PEERS_STANDBY_CLAUDE_PID:-}" ]]; then
  walk="$PPID"
  for _ in 1 2 3 4 5; do
    comm=$(ps -p "$walk" -o comm= 2>/dev/null)
    if [[ "$comm" == "claude" ]]; then CLAUDE_PID="$walk"; break; fi
    walk=$(ps -p "$walk" -o ppid= 2>/dev/null | tr -d ' ')
    [[ -z "$walk" || "$walk" == "1" ]] && break
  done
fi
[[ "$CLAUDE_PID" =~ ^[0-9]+$ ]] || bail no-claude-pid
kill -0 "$CLAUDE_PID" 2>/dev/null || bail claude-pid-not-live

find_mcp_pid() {
  local try walk comm
  try=$(child_server_pid "$PPID")
  if [[ -n "$try" ]] && try=$(resolve_bun_pid "$try"); then printf '%s\n' "$try"; return 0; fi
  walk="$PPID"
  for _ in 1 2 3 4 5; do
    comm=$(ps -p "$walk" -o comm= 2>/dev/null)
    if [[ "$comm" == "claude" ]]; then
      try=$(child_server_pid "$walk")
      if [[ -n "$try" ]] && try=$(resolve_bun_pid "$try"); then printf '%s\n' "$try"; return 0; fi
    fi
    walk=$(ps -p "$walk" -o ppid= 2>/dev/null | tr -d ' ')
    [[ -z "$walk" || "$walk" == "1" || "$walk" == "0" ]] && return 1
  done
  return 1
}

# Thread identity is the primary route; the MCP pid is only a fallback.
#
# Claude's hooks contract guarantees session_id on Stop stdin. It does NOT
# guarantee that this hook is an ancestor-descendant of the session's MCP server
# — and in the live detached topology it is not, so find_mcp_pid() returns
# nothing and the watcher used to die here with no trace. session_id is the same
# identifier the SessionStart hook persists as peers.thread_id, so it addresses
# our own row exactly, with no process tree involved.
#
# The pid path is kept for rows registered before thread_id existed (most of the
# fleet right now) and for Gemini/legacy clients. Ancestry therefore survives
# only as a FALLBACK and as liveness (`kill -0 "$CLAUDE_PID"` in the loop below),
# never as the primary identity.
MCP_PID="${CLAUDE_PEERS_STANDBY_MCP_PID:-$(find_mcp_pid)}"
if [[ ! "$MCP_PID" =~ ^[0-9]+$ ]]; then
  MCP_PID=""
  [[ -n "$SESSION_ID" ]] || bail no-mcp-pid-and-no-session-id
fi

LOCK_KEY="${SESSION_ID:-$CLAUDE_PID}"
if [[ ! "$LOCK_KEY" =~ ^[A-Za-z0-9._-]{1,128}$ ]]; then LOCK_KEY="$CLAUDE_PID"; fi

# Keep coordination files below an owner-only runtime directory. Unlike the old
# public /tmp lock, the persistent lock inode is never removed, avoiding an
# unlink/recreate split-lock race while another Stop invocation is waiting.
RUNTIME_BASE="${CLAUDE_PEERS_STANDBY_RUNTIME_DIR:-${XDG_RUNTIME_DIR:-$FALLBACK_HOME/.cache}}"
STATE_DIR="$RUNTIME_BASE/claude-peers/standby"
umask 077
[[ ! -L "$STATE_DIR" ]] || bail unsafe-state-dir-symlink
mkdir -p "$STATE_DIR" 2>/dev/null || bail state-dir-create-failed
chmod 700 "$STATE_DIR" 2>/dev/null || bail state-dir-chmod-failed
OWNER=$(stat -c '%u' "$STATE_DIR" 2>/dev/null || true)
[[ "$OWNER" == "$(id -u)" ]] || bail state-dir-owner-mismatch

LOCK_FILE="$STATE_DIR/$LOCK_KEY.lock"
STATE_FILE="$STATE_DIR/$LOCK_KEY.state"
NOW=$(date +%s)
DEADLINE=$((NOW + ACTIVE_SECONDS))
STATE_TMP="$STATE_DIR/.$LOCK_KEY.state.$$"
printf '%s %s\n' "$DEADLINE" "$MCP_PID" > "$STATE_TMP" 2>/dev/null || bail state-write-failed
chmod 600 "$STATE_TMP" 2>/dev/null || bail state-chmod-failed
mv -f "$STATE_TMP" "$STATE_FILE" 2>/dev/null || bail state-publish-failed

command -v flock >/dev/null 2>&1 || bail missing-flock
exec 200>>"$LOCK_FILE" || bail lock-open-failed
chmod 600 "$LOCK_FILE" 2>/dev/null || bail lock-chmod-failed
# If a prior watcher is approaching its deadline, wait briefly so this process
# can take over. Otherwise the lease write above refreshes that watcher and this
# contender exits without creating a duplicate poller.
flock -w "$LOCK_WAIT" 200 || exit 0

wake_mode() {
  local summary="" query=""
  if [[ "$ROUTE_MODE" == "thread" && "$SESSION_ID" =~ ^[A-Za-z0-9._-]{1,128}$ ]]; then
    query="SELECT summary FROM peers WHERE thread_id='$SESSION_ID' LIMIT 1"
  elif [[ -n "$MCP_PID" ]]; then
    query="SELECT summary FROM peers WHERE pid=$MCP_PID LIMIT 1"
  fi
  if [[ -n "$query" ]] && command -v sqlite3 >/dev/null 2>&1; then
    summary=$(sqlite3 -readonly "${CLAUDE_PEERS_DB:-$FALLBACK_HOME/.claude-peers.db}" \
      "$query" 2>/dev/null || true)
    if [[ "$("$BUN" "$SCRIPT_DIR/claude-wake-mode.ts" "$summary" 2>/dev/null)" == "auto" ]]; then
      printf 'auto\n'
      return
    fi
  fi
  printf 'ask\n'
}

sleep_idle_interruptibly() {
  local remaining="$IDLE_INTERVAL" slice now deadline
  while (( remaining > 0 )); do
    slice="$POLL_INTERVAL"
    (( slice > remaining )) && slice="$remaining"
    sleep "$slice"
    remaining=$((remaining - slice))
    now=$(date +%s)
    read -r deadline _ < "$STATE_FILE" 2>/dev/null || deadline=0
    if [[ "$deadline" =~ ^[0-9]+$ ]] && (( now < deadline )); then return; fi
  done
}

# Settle the claimed batch in $RESP: verb "ack" marks it delivered, "release"
# hands it straight back to the queue. Always on the SAME route family the claim
# used; mixing them would settle against a different resolution of "who we are"
# than the one that handed us the messages. Sets SETTLE_STATUS and SETTLE_COUNT.
settle_claim() {
  local verb="$1" field drain ids path body raw
  case "$verb" in ack) field=acked ;; release) field=released ;; *) return 1 ;; esac
  SETTLE_STATUS=""
  SETTLE_COUNT=0
  drain=$(printf '%s' "$RESP" | jq -r '.drain_id // empty' 2>/dev/null)
  ids=$(printf '%s' "$RESP" | jq -c '[.messages[].id]' 2>/dev/null)
  [[ -n "$drain" && -n "$ids" && "$ids" != "[]" ]] || return 1
  if [[ "$ROUTE_MODE" == "thread" ]]; then
    path="/${verb}-by-thread"
    body=$(jq -nc --arg thread "$SESSION_ID" --argjson caller "$CLAUDE_PID" --arg drain "$drain" --argjson ids "$ids" \
      '{thread_id:$thread, caller_pid:$caller, drain_id:$drain, ids:$ids, via:"claude-standby-hook", client_type:"claude", receiver_mode:"claude-channel"}')
  else
    path="/${verb}-by-pid"
    body=$(jq -nc --argjson pid "$MCP_PID" --argjson caller "$CLAUDE_PID" --arg drain "$drain" --argjson ids "$ids" \
      '{pid:$pid, caller_pid:$caller, drain_id:$drain, ids:$ids, via:"claude-standby-hook", client_type:"claude", receiver_mode:"claude-channel"}')
  fi
  raw=$(curl -s -m 3 -w $'\n%{http_code}' -X POST "http://127.0.0.1:${BROKER_PORT}${path}" \
    -H 'Content-Type: application/json' -d "$body" 2>/dev/null)
  SETTLE_STATUS=$(printf '%s\n' "$raw" | tail -n1)
  SETTLE_COUNT=$(printf '%s' "$raw" | sed '$d' | jq -r --arg field "$field" '.[$field] // 0' 2>/dev/null)
  [[ "$SETTLE_COUNT" =~ ^[0-9]+$ ]] || SETTLE_COUNT=0
}

# Batched idle wakes (shared/wake-batch.ts): while this session's last delivery
# is inside CLAUDE_PEERS_WAKE_BATCH_MS and none of its queued mail starts with
# "URGENT:", skip the claim so the mail stays queued, untouched, for one later
# wake (or the next prompt drain). Any helper failure answers "wake".
wake_batch_held() {
  local thread=""
  [[ "$SESSION_ID" =~ ^[A-Za-z0-9._-]{1,128}$ ]] && thread="$SESSION_ID"
  [[ "$("$BUN" "$SCRIPT_DIR/claude-wake-batch.ts" "$thread" "$MCP_PID" 2>/dev/null)" == "hold" ]]
}

pause_before_next_poll() {
  local now deadline
  now=$(date +%s)
  read -r deadline _ < "$STATE_FILE" 2>/dev/null || deadline=0
  if [[ "$deadline" =~ ^[0-9]+$ ]] && (( now < deadline )); then
    sleep "$POLL_INTERVAL"
  else
    # Remain reachable for the life of the Claude process, but reduce idle
    # broker traffic after the fast window. A later Stop refreshes the lease.
    sleep_idle_interruptibly
  fi
}

RENDER_FAILURES=0
WAKE_HOLD_LOGGED=0

# Which identity route is known to work for this session. Latched on first
# success so we stop paying for a failing probe every tick: "unknown" tries
# thread first, "thread" and "pid" go straight to the proven one.
ROUTE_MODE="unknown"

while kill -0 "$CLAUDE_PID" 2>/dev/null; do
  read -r _ CURRENT_MCP_PID < "$STATE_FILE" 2>/dev/null || CURRENT_MCP_PID=""
  if [[ "$CURRENT_MCP_PID" =~ ^[0-9]+$ ]]; then MCP_PID="$CURRENT_MCP_PID"; fi
  if wake_batch_held; then
    if (( WAKE_HOLD_LOGGED == 0 )); then
      WAKE_HOLD_LOGGED=1
      printf '%s wake-held reason=batch-window session=%s\n' "$(date -Iseconds)" "${SESSION_ID:-none}" >> "$STANDBY_LOG" 2>/dev/null
    fi
    pause_before_next_poll
    continue
  fi
  WAKE_HOLD_LOGGED=0
  # Route by thread identity when we have it; fall back to the pid path only for
  # rows that predate thread_id. Both endpoints are atomic claims — resolving an
  # identity and then claiming as two calls would leave a TOCTOU gap, since the
  # mapping can change between them.
  RAW=""
  STATUS=""
  if [[ -n "$SESSION_ID" && "$ROUTE_MODE" != "pid" ]]; then
    CLAIM_BODY=$(jq -nc --arg thread "$SESSION_ID" --argjson caller "$CLAUDE_PID" \
      '{thread_id:$thread, caller_pid:$caller, client_type:"claude", receiver_mode:"claude-channel"}')
    RAW=$(curl -s -m 3 -w $'\n%{http_code}' -X POST "http://127.0.0.1:${BROKER_PORT}/claim-by-thread" \
      -H 'Content-Type: application/json' -d "$CLAIM_BODY" 2>/dev/null)
    STATUS=$(printf '%s\n' "$RAW" | tail -n1)
    # A 200 alone is not proof the route works: it must actually be a CLAIM
    # response. Latching on the status code would accept any 200-returning
    # endpoint and then poll it forever finding no mail, which is a hang rather
    # than a failure. A real claim always carries a `messages` array, empty or not.
    if [[ "$STATUS" == "200" ]] \
      && [[ "$(printf '%s' "$RAW" | sed '$d' | jq -r 'has("messages")' 2>/dev/null)" == "true" ]]; then
      ROUTE_MODE="thread"
    elif [[ -n "$MCP_PID" ]]; then
      # No row carries this thread yet (rows registered before thread_id, which
      # is most of the fleet today). Fall back rather than spin: this change must
      # never be worse than the pid-only behaviour it replaces.
      [[ "$ROUTE_MODE" == "unknown" ]] && printf '%s thread-route-unavailable status=%s session=%s falling-back=pid\n' \
        "$(date -Iseconds)" "${STATUS:-curl_failed}" "$SESSION_ID" >> "$STANDBY_LOG" 2>/dev/null
      ROUTE_MODE="pid"
      RAW=""
    fi
  fi
  if [[ -z "$RAW" ]]; then
    [[ -n "$MCP_PID" ]] || { sleep "$POLL_INTERVAL"; continue; }
    CLAIM_BODY=$(jq -nc --argjson pid "$MCP_PID" --argjson caller "$CLAUDE_PID" \
      '{pid:$pid, caller_pid:$caller, client_type:"claude", receiver_mode:"claude-channel"}')
    RAW=$(curl -s -m 3 -w $'\n%{http_code}' -X POST "http://127.0.0.1:${BROKER_PORT}/claim-by-pid" \
      -H 'Content-Type: application/json' -d "$CLAIM_BODY" 2>/dev/null)
    STATUS=$(printf '%s\n' "$RAW" | tail -n1)
  fi
  RESP=$(printf '%s' "$RAW" | sed '$d')

  if [[ -z "$STATUS" || "$STATUS" != "200" ]]; then
    printf '%s status=%s body=%s\n' "$(date -Iseconds)" "${STATUS:-curl_failed}" "${RESP:0:200}" \
      >> "$LOG_DIR/standby-watcher.log" 2>/dev/null
  else
    COUNT=$(printf '%s' "$RESP" | jq -r '.messages | length // 0' 2>/dev/null)
    if [[ "$COUNT" =~ ^[1-9][0-9]*$ ]]; then
      BLOCKS=$(printf '%s' "$RESP" | "$BUN" "$SCRIPT_DIR/claude-render-peer-messages.ts" 2>/dev/null)
      if [[ -z "$BLOCKS" ]]; then
        # Hand the batch back now rather than letting the claim hide it from
        # check_messages until CLAIM_TTL lapses (and this loop re-claims it).
        RENDER_FAILURES=$((RENDER_FAILURES + 1))
        settle_claim release
        printf '%s render_failed claimed=%s released=%s release_status=%s failures=%s/%s session=%s\n' \
          "$(date -Iseconds)" "$COUNT" "$SETTLE_COUNT" "${SETTLE_STATUS:-curl_failed}" \
          "$RENDER_FAILURES" "$MAX_RENDER_FAILURES" "${SESSION_ID:-none}" >> "$STANDBY_LOG" 2>/dev/null
        if (( RENDER_FAILURES >= MAX_RENDER_FAILURES )); then
          # Exit 0, not 2: rewaking the model on a permanent fault would turn
          # into a wake loop. The released mail stays queued for the next
          # prompt drain or check_messages, and the lock is free for a new Stop.
          printf '%s render_failures_exhausted failures=%s session=%s claude_pid=%s\n' \
            "$(date -Iseconds)" "$RENDER_FAILURES" "${SESSION_ID:-none}" "$CLAUDE_PID" >> "$STANDBY_LOG" 2>/dev/null
          exit 0
        fi
      else
        WAKE_MODE=$(wake_mode)
        if [[ "$WAKE_MODE" == "auto" ]]; then
          printf 'Peer mail arrived while idle. %s message(s) drained:\n\n%s\n\nAutonomous mode is enabled by the peer summary. Follow the user\x27s standing scope and normal safety rules.\n' "$COUNT" "$BLOCKS" >&2
        else
          printf 'Peer mail arrived while idle. %s message(s) drained:\n\n%s\n\nHandle it. If it needs nothing from the user (an FYI, an acknowledgement, status with no question or decision for them), end the turn without a message to the user. Otherwise tell the user in one or two lines before taking any new action that expands the current task.\n' "$COUNT" "$BLOCKS" >&2
        fi
        if settle_claim ack && [[ "$SETTLE_STATUS" != "200" || "$SETTLE_COUNT" != "$COUNT" ]]; then
          printf '%s status=%s requested=%s acked=%s\n' "$(date -Iseconds)" "${SETTLE_STATUS:-curl_failed}" "$COUNT" "$SETTLE_COUNT" >> "$STANDBY_LOG" 2>/dev/null
        fi
        exit 2
      fi
    fi
  fi

  pause_before_next_poll
done

exit 0
