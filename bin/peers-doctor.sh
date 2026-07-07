#!/bin/bash
# peers-doctor — one-shot diagnostic for the claude-peers stack.
# Checks broker, DB, hook wiring, hook scripts, endpoint health, log presence,
# and stale-lock pollution. Prints [✓]/[!]/[✗] per check with remediation hints.
#
# Exit code: 0 if all critical checks pass, 1 otherwise (warnings don't fail).

set -u

PASS=0
WARN=0
FAIL=0

ok()   { printf "[\e[32m✓\e[0m] %s\n" "$1"; PASS=$((PASS+1)); }
warn() { printf "[\e[33m!\e[0m] %s\n    → %s\n" "$1" "$2"; WARN=$((WARN+1)); }
fail() { printf "[\e[31m✗\e[0m] %s\n    → %s\n" "$1" "$2"; FAIL=$((FAIL+1)); }

printf "claude-peers doctor — %s\n\n" "$(date -Iseconds)"

# 1. broker HTTP /health — authoritative liveness check (the pgrep pattern
# can miss brokers launched as `bun broker.ts` without a full path).
HEALTH=$(curl -sf -m 2 http://127.0.0.1:7899/health 2>/dev/null || echo "")
if [[ -n "$HEALTH" ]]; then
  CAPS_KNOWN=false
  if command -v jq >/dev/null 2>&1; then
    CAPS_KNOWN=true
    PEER_COUNT=$(echo "$HEALTH" | jq -r '.peers // 0' 2>/dev/null || echo "?")
    CLAIM_CAP=$(echo "$HEALTH" | jq -r '.capabilities.hookDrain.claimByPid // false' 2>/dev/null || echo "false")
    ACK_CAP=$(echo "$HEALTH" | jq -r '.capabilities.hookDrain.ackByPid // false' 2>/dev/null || echo "false")
    HEARTBEAT_CAP=$(echo "$HEALTH" | jq -r '.capabilities.hookDrain.hookHeartbeatByPid // false' 2>/dev/null || echo "false")
  else
    PEER_COUNT="?"
    CLAIM_CAP="unknown"
    ACK_CAP="unknown"
    HEARTBEAT_CAP="unknown"
  fi
  BROKER_PID=$(pgrep -f 'bun.*broker\.ts' 2>/dev/null | head -1)
  ok "broker /health responding (${PEER_COUNT} peers${BROKER_PID:+, pid $BROKER_PID})"
  if [[ "$CAPS_KNOWN" != "true" ]]; then
    warn "broker capability flags not parsed" "install jq or inspect /health manually; doctor will verify /claim-by-pid directly when this pane has an MCP PID"
  elif [[ "$CLAIM_CAP" == "true" && "$ACK_CAP" == "true" && "$HEARTBEAT_CAP" == "true" ]]; then
    ok "broker advertises prompt-hook drain capabilities"
  else
    fail "broker /health is alive but missing prompt-hook drain capabilities" "systemctl --user restart claude-peers-broker; stale brokers cannot autodrain Codex/Gemini peers"
  fi
else
  fail "broker /health not responding on 127.0.0.1:7899" "systemctl --user restart claude-peers-broker (managed unit with memory cap — do NOT spawn bun broker.ts manually)"
fi

# 3. DB readable
if [[ -f "$HOME/.claude-peers.db" ]]; then
  DB_COUNT=$(sqlite3 -readonly "$HOME/.claude-peers.db" \
    "SELECT count(*) FROM peers" 2>/dev/null || echo "")
  if [[ -n "$DB_COUNT" ]]; then
    MSG_COUNT=$(sqlite3 -readonly "$HOME/.claude-peers.db" \
      "SELECT count(*) FROM messages WHERE delivered=0" 2>/dev/null || echo "?")
    ok "broker DB readable (${DB_COUNT} peers, ${MSG_COUNT} undelivered messages)"
  else
    fail "broker DB exists but unreadable" "check ~/.claude-peers.db permissions + sqlite3 installed"
  fi
else
  warn "broker DB missing at ~/.claude-peers.db" "first broker launch will create it"
fi

# 4. current session has an MCP child
PPID_CLAUDE="$PPID"
walk="$PPID"
for i in 1 2 3 4 5; do
  comm=$(ps -p "$walk" -o comm= 2>/dev/null)
  if [[ "$comm" == "claude" ]]; then PPID_CLAUDE="$walk"; break; fi
  walk=$(ps -p "$walk" -o ppid= 2>/dev/null | tr -d ' ')
  [[ -z "$walk" || "$walk" == "1" ]] && break
done
MY_MCP=$(pgrep -P "$PPID_CLAUDE" -f 'claude-peers-mcp/server\.ts' 2>/dev/null | head -1)
if [[ -n "$MY_MCP" ]]; then
  ok "this session has claude-peers MCP (pid $MY_MCP under claude $PPID_CLAUDE)"
else
  warn "no claude-peers MCP sibling detected" "launch sessions via ccp / ccc / cccr / ccw / ccx (not bare claude)"
fi

# 5. hook wiring
SETTINGS="$HOME/.claude/settings.json"
if [[ -f "$SETTINGS" ]]; then
  for event in UserPromptSubmit Stop SessionStart; do
    if jq -e ".hooks.${event}" "$SETTINGS" >/dev/null 2>&1; then
      ok "${event} hook registered in settings.json"
    else
      warn "${event} hook NOT registered" "add a hooks.${event} entry to $SETTINGS"
    fi
  done
else
  fail "~/.claude/settings.json missing" "Claude Code creates it on first launch"
fi

# 6. hook scripts exist + executable
for h in drain-peer-inbox.sh claude-peers-standby-watcher.sh claude-peers-session-greeting.sh; do
  path="$HOME/.claude/hooks/$h"
  if [[ -f "$path" ]]; then
    if [[ -x "$path" ]]; then
      ok "$h executable"
    else
      warn "$h exists but not executable" "chmod +x $path (or invoke via 'bash $path' in settings.json)"
    fi
  else
    warn "$h missing" "expected at $path — re-run setup or copy from the fork"
  fi
done

# 7. /poll-by-pid responds
if [[ -n "$MY_MCP" ]]; then
  RESP=$(curl -s -m 2 -w '\n%{http_code}' -X POST http://127.0.0.1:7899/poll-by-pid \
    -H 'Content-Type: application/json' \
    -d "{\"pid\":${MY_MCP},\"caller_pid\":$$}" 2>/dev/null)
  BODY=$(printf '%s\n' "$RESP" | sed '$d')
  STATUS=$(printf '%s\n' "$RESP" | tail -n1)
  if [[ "$STATUS" == "200" && "$BODY" =~ \"peer_id\":\"[^\"]+\" ]]; then
    ok "/poll-by-pid responds 200 for this session's MCP"
  elif [[ "$STATUS" == "200" ]]; then
    warn "/poll-by-pid endpoint reachable but this PID has no broker peer row" "relaunch this session if Claude MCP delivery should be active; Codex/Gemini prompt-drain checks below may not apply to this PID"
  else
    fail "/poll-by-pid returned ${STATUS:-no-response}" "check broker + rebuild (bun install) + restart"
  fi

  CLAIM_RESP=$(curl -s -m 2 -w '\n%{http_code}' -X POST http://127.0.0.1:7899/claim-by-pid \
    -H 'Content-Type: application/json' \
    -d "{\"pid\":${MY_MCP},\"caller_pid\":$$,\"drain_id\":\"doctor-$$\"}" 2>/dev/null)
  CLAIM_BODY=$(printf '%s\n' "$CLAIM_RESP" | sed '$d')
  CLAIM_STATUS=$(printf '%s\n' "$CLAIM_RESP" | tail -n1)
  if [[ "$CLAIM_STATUS" == "200" && "$CLAIM_BODY" =~ \"peer_id\":\"[^\"]+\" ]]; then
    ok "/claim-by-pid responds 200 for safe prompt-hook drain"
  elif [[ "${CAPS_KNOWN:-false}" == "true" && "${CLAIM_CAP:-false}" != "true" ]]; then
    fail "/claim-by-pid unavailable on this broker" "restart broker onto current code; /health lacks capabilities.hookDrain.claimByPid"
  elif [[ "$CLAIM_STATUS" == "404" && "$CLAIM_BODY" =~ peer[[:space:]-]*not[[:space:]-]*found ]]; then
    warn "/claim-by-pid endpoint reachable but this PID has no claimable prompt-hook row" "this is expected for some Claude MCP-only sessions; verify Codex/Gemini claim drain from their client PID or relaunch registration if this was a Codex/Gemini pane"
  else
    fail "/claim-by-pid returned ${CLAIM_STATUS:-no-response}" "restart broker so the prompt-hook endpoints are available"
  fi
fi

# 7b. Codex/Gemini hook surfaces
CODEX_HOOK="$HOME/claude-peers-mcp/hooks/codex-drain-peer-inbox.sh"
if [[ -x "$CODEX_HOOK" ]]; then
  ok "Codex inbox hook executable"
else
  warn "Codex inbox hook not executable at $CODEX_HOOK" "chmod +x $CODEX_HOOK or reinstall fork"
fi

GEMINI_HOOK="$HOME/claude-peers-mcp/hooks/gemini-drain-peer-inbox.sh"
if [[ -x "$GEMINI_HOOK" ]]; then
  ok "Gemini inbox hook executable"
else
  warn "Gemini inbox hook not executable at $GEMINI_HOOK" "chmod +x $GEMINI_HOOK or reinstall fork"
fi

# 7c. orphaned / spare-parented server.ts processes. An orphan (ppid=1) is a
# dead session's MCP server still heartbeating — it squats a seat, breeds #N
# duplicate names, and blocks rehydration. Spare-parented (claude --bg-spare)
# servers are pre-warm ghosts. Both classes should not exist after the
# 2026-06-10 lifecycle fix; flag any survivors running old code.
ORPHANS=""
SPARES=""
for pid in $(pgrep -f 'claude-peers-mcp/server\.ts' 2>/dev/null); do
  ppid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
  [[ -z "$ppid" ]] && continue
  if [[ "$ppid" == "1" ]]; then
    ORPHANS+="$pid "
  elif ps -p "$ppid" -o args= 2>/dev/null | grep -q -- '--bg-spare'; then
    SPARES+="$pid "
  fi
done
if [[ -z "$ORPHANS" && -z "$SPARES" ]]; then
  ok "no orphaned or bg-spare server.ts processes"
else
  [[ -n "$ORPHANS" ]] && fail "orphaned server.ts (ppid=1): ${ORPHANS}" "kill ${ORPHANS}— these predate the stdin-EOF/parent-watchdog fix"
  [[ -n "$SPARES" ]] && warn "bg-spare-parented server.ts: ${SPARES}" "kill ${SPARES}— pre-warm ghosts; new code defers their registration"
fi

# 7d. Codex hook trust. Codex trust is hash-based: any hooks.json rewrite
# (e.g. install-codex-hook.ts) marks hooks untrusted and they silently stop
# running until re-trusted. We can't read Codex's trust store portably, so
# flag recently-modified hooks.json files as a reminder.
for cf in "$HOME/.codex/hooks.json" "$HOME"/*/.codex/hooks.json; do
  [[ -f "$cf" ]] || continue
  if [[ -n "$(find "$cf" -mmin -1440 2>/dev/null)" ]]; then
    warn "Codex hooks.json modified <24h ago: $cf" "run /hooks inside Codex to re-trust, or hooks may be silently skipped"
  fi
done

# 8. latency log has recent entries
LOG="$HOME/.claude-peers-broker.log"
if [[ -f "$LOG" ]]; then
  DELIVERS=$(grep -c 'via=poll-by-pid' "$LOG" 2>/dev/null || echo 0)
  ok "${DELIVERS} poll-by-pid deliveries recorded in broker log"
else
  warn "broker log not found at $LOG" "first broker launch creates it"
fi

# 9. stale lock-file count
LOCK_COUNT=$(ls /tmp/claude-peers-standby-*.lock 2>/dev/null | wc -l)
if [[ "$LOCK_COUNT" -gt 20 ]]; then
  warn "${LOCK_COUNT} stale lock files in /tmp" "cleanup: for f in /tmp/claude-peers-standby-*.lock; do pid=\${f##*-}; pid=\${pid%.lock}; kill -0 \$pid 2>/dev/null || rm -f \"\$f\"; done"
elif [[ "$LOCK_COUNT" -gt 0 ]]; then
  ok "${LOCK_COUNT} standby lock file(s) (below warning threshold)"
fi

printf "\n%d checks pass, %d warnings, %d errors.\n" "$PASS" "$WARN" "$FAIL"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
