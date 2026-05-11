#!/usr/bin/env bash
# install.sh — install, reset, or inspect the gsd-comms-mcp deployment on this machine.
#
# Idempotent. Safe to re-run.
#
# Subcommands:
#   install     (default) Set up dependencies + register the MCP server at user scope.
#                         Warns (but does not kill) if a stale broker is running.
#   reset                 Tear down the running broker + bridge, re-register the MCP
#                         (in case the repo moved), and leave everything ready for the
#                         next session to auto-spawn fresh processes.
#   status                Print what's registered and what's running. No side effects.
#   uninstall             Stop the broker + bridge and remove the MCP registration.
#                         Does NOT delete the repo or the database file.
#   help                  This message.
#
# Environment:
#   CLAUDE_PEERS_PORT      Broker port (default: 7899)
#   CLAUDE_PEERS_DB        DB path (default: ~/.claude-peers.db)
#   GSD_COMMS_MCP_NAME     Override the registered MCP name (default: claude-peers,
#                          matching the project's .mcp.json)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MCP_NAME="${GSD_COMMS_MCP_NAME:-claude-peers}"
BROKER_PORT="${CLAUDE_PEERS_PORT:-7899}"
CMD="${1:-install}"

# ---- colors / logging -------------------------------------------------------

if [[ -t 1 ]]; then
  C_INFO=$'\033[1;36m'; C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_INFO=""; C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_RESET=""
fi
log()  { printf '%s[install.sh]%s %s\n' "$C_INFO" "$C_RESET" "$*"; }
ok()   { printf '%s[install.sh]%s %s\n' "$C_OK"   "$C_RESET" "$*"; }
warn() { printf '%s[install.sh]%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
die()  { printf '%s[install.sh]%s %s\n' "$C_ERR"  "$C_RESET" "$*" >&2; exit 1; }

usage() {
  sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ---- dependency checks ------------------------------------------------------

check_deps() {
  command -v bun    >/dev/null 2>&1 || die "bun not found on PATH (install from https://bun.sh)"
  command -v claude >/dev/null 2>&1 || die "claude CLI not found on PATH"
  [[ -f "$REPO_DIR/server.ts" ]]    || die "expected $REPO_DIR/server.ts — is this the repo root?"
  [[ -f "$REPO_DIR/broker.ts" ]]    || die "expected $REPO_DIR/broker.ts — is this the repo root?"
}

# ---- bun deps ---------------------------------------------------------------

bun_install() {
  log "bun install (silent)"
  (cd "$REPO_DIR" && bun install --silent)
}

# ---- MCP registration -------------------------------------------------------
#
# We always manage USER scope so the MCP is available in every Claude Code
# session on this machine. Project scope (via .mcp.json) is a separate concern
# checked into the repo — this script never touches it.

# Returns 0 if any registration exists (any scope), 1 otherwise.
mcp_registered_any_scope() {
  claude mcp get "$MCP_NAME" >/dev/null 2>&1
}

# Returns 0 if user-scope is the active/visible registration.
mcp_registered_user_scope() {
  claude mcp get "$MCP_NAME" 2>/dev/null | grep -qE "Scope:[[:space:]]*User"
}

# Returns the scope label of the active registration (e.g. "User", "Project",
# "Local"), or "none" if nothing is registered.
mcp_active_scope() {
  if ! mcp_registered_any_scope; then
    echo "none"; return
  fi
  local line
  line="$(claude mcp get "$MCP_NAME" 2>/dev/null | grep -E '^[[:space:]]*Scope:' || true)"
  case "$line" in
    *User*)    echo "user" ;;
    *Project*) echo "project" ;;
    *Local*)   echo "local" ;;
    *)         echo "unknown" ;;
  esac
}

register_user_scope() {
  log "registering '$MCP_NAME' at user scope → $REPO_DIR/server.ts"
  claude mcp add --scope user --transport stdio "$MCP_NAME" -- bun "$REPO_DIR/server.ts"
  ok "MCP '$MCP_NAME' registered (user scope)"
}

remove_user_scope_quiet() {
  claude mcp remove --scope user "$MCP_NAME" >/dev/null 2>&1 || true
}

register_mcp_if_missing() {
  local active; active="$(mcp_active_scope)"
  case "$active" in
    user)
      log "MCP '$MCP_NAME' already registered at user scope (global — every session sees it)"
      ;;
    project|local)
      warn "'$MCP_NAME' is registered at $active scope (only loads from that directory)."
      warn "Adding a user-scope registration so it's available in every Claude session on this machine."
      register_user_scope
      ;;
    none)
      register_user_scope
      ;;
    *)
      warn "could not determine MCP scope; attempting to add at user scope"
      register_user_scope
      ;;
  esac
}

reregister_mcp_user_scope() {
  # Always remove first. `claude mcp get` only reports the highest-priority
  # scope, so a project-scope registration can shadow a user-scope one and
  # mask its existence — but `claude mcp add --scope user` will still 409 if
  # it's there. The remove is quiet either way.
  log "clearing any existing user-scope registration"
  remove_user_scope_quiet
  register_user_scope
}

# ---- broker lifecycle -------------------------------------------------------

broker_pids() {
  # broker.ts run anywhere on this machine, regardless of how it was launched
  pgrep -f 'bun .*broker\.ts' 2>/dev/null || true
}

broker_health() {
  curl -sf --max-time 2 "http://127.0.0.1:${BROKER_PORT}/health" 2>/dev/null || true
}

kill_broker() {
  local pids; pids="$(broker_pids)"
  if [[ -z "$pids" ]]; then
    log "no broker process running"
    return 0
  fi
  log "stopping broker (PIDs: $(echo "$pids" | tr '\n' ' '))"
  echo "$pids" | xargs -r kill -TERM 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    sleep 0.5
    [[ -z "$(broker_pids)" ]] && break
  done
  pids="$(broker_pids)"
  if [[ -n "$pids" ]]; then
    warn "broker still alive after SIGTERM; sending SIGKILL"
    echo "$pids" | xargs -r kill -KILL 2>/dev/null || true
  fi
  ok "broker stopped"
}

# ---- bridge lifecycle -------------------------------------------------------

bridge_pids() {
  pgrep -f 'bun .*bridges/telegram/telegram\.ts' 2>/dev/null || true
}

kill_bridge() {
  local pids; pids="$(bridge_pids)"
  if [[ -z "$pids" ]]; then
    return 0
  fi
  log "stopping Telegram bridge (PIDs: $(echo "$pids" | tr '\n' ' '))"
  echo "$pids" | xargs -r kill -TERM 2>/dev/null || true
  for _ in 1 2 3 4; do
    sleep 0.5
    [[ -z "$(bridge_pids)" ]] && break
  done
  pids="$(bridge_pids)"
  if [[ -n "$pids" ]]; then
    warn "bridge still alive after SIGTERM; sending SIGKILL"
    echo "$pids" | xargs -r kill -KILL 2>/dev/null || true
  fi
  ok "bridge stopped"
}

# ---- status -----------------------------------------------------------------

status_summary() {
  echo
  echo "${C_DIM}---- gsd-comms-mcp status ----${C_RESET}"
  printf "Repo:    %s\n" "$REPO_DIR"
  local active; active="$(mcp_active_scope)"
  case "$active" in
    user)
      printf "MCP:     ${C_OK}registered${C_RESET} as '%s' (scope: user — all sessions)\n" "$MCP_NAME"
      ;;
    project|local)
      printf "MCP:     ${C_WARN}registered${C_RESET} as '%s' (scope: %s — only loads from that dir)\n" "$MCP_NAME" "$active"
      printf "         ${C_DIM}run \`./install.sh install\` to add a global user-scope registration${C_RESET}\n"
      ;;
    none)
      printf "MCP:     ${C_WARN}not registered${C_RESET} as '%s' anywhere\n" "$MCP_NAME"
      ;;
    *)
      printf "MCP:     ${C_WARN}registered${C_RESET} as '%s' (scope: unknown)\n" "$MCP_NAME"
      ;;
  esac
  if [[ "$active" != "none" ]]; then
    claude mcp get "$MCP_NAME" 2>/dev/null | head -6 | sed 's/^/         /'
  fi

  local health; health="$(broker_health)"
  if [[ -n "$health" ]]; then
    printf "Broker:  ${C_OK}running${C_RESET} on :%s — %s\n" "$BROKER_PORT" "$health"
    local bpids; bpids="$(broker_pids)"
    [[ -n "$bpids" ]] && printf "         PIDs: %s\n" "$(echo "$bpids" | tr '\n' ' ')"
  else
    printf "Broker:  ${C_DIM}not running${C_RESET} (auto-spawns when an MCP client connects)\n"
  fi

  local brpids; brpids="$(bridge_pids)"
  if [[ -n "$brpids" ]]; then
    printf "Bridge:  ${C_OK}running${C_RESET} (PIDs: %s)\n" "$(echo "$brpids" | tr '\n' ' ')"
  elif [[ -f "$HOME/.config/gsd-comms/telegram/telegram.env" ]]; then
    printf "Bridge:  ${C_DIM}stopped${C_RESET} (creds present — start with \`bun run bridge:telegram &\`)\n"
  else
    printf "Bridge:  ${C_DIM}stopped${C_RESET} (no creds at ~/.config/gsd-comms/telegram/telegram.env)\n"
  fi
  echo "${C_DIM}-------------------------------${C_RESET}"
}

# ---- subcommands ------------------------------------------------------------

cmd_install() {
  check_deps
  bun_install
  register_mcp_if_missing
  if [[ -n "$(broker_pids)" ]]; then
    warn "a broker process is already running; if it predates a code change, run \`./install.sh reset\` so the next session starts a fresh one"
  fi
  status_summary
}

cmd_reset() {
  check_deps
  bun_install
  warn "this will stop the running broker. Active Claude Code sessions will reconnect to a fresh broker on their next MCP call (you may see a transient error in this very session if it's connected)."
  kill_bridge
  kill_broker
  reregister_mcp_user_scope
  log "ready — the broker will auto-launch when the next MCP client connects (or run \`bun broker.ts &\` to start it now)"
  if [[ -f "$HOME/.config/gsd-comms/telegram/telegram.env" ]]; then
    log "Telegram bridge creds detected — restart with \`bun run bridge:telegram &\` if you use it"
  fi
  status_summary
}

cmd_status() {
  status_summary
}

cmd_uninstall() {
  kill_bridge
  kill_broker
  if mcp_registered_user_scope; then
    remove_user_scope_quiet
    ok "removed user-scope registration for '$MCP_NAME'"
  fi
  # Project-scope is via .mcp.json in the repo — explicit about not touching it
  if claude mcp get "$MCP_NAME" 2>/dev/null | grep -qE "Scope:[[:space:]]*Project"; then
    warn "'$MCP_NAME' is still registered at project scope (via .mcp.json in $REPO_DIR)."
    warn "This script does NOT modify .mcp.json. Remove it manually if you want to fully uninstall."
  fi
  log "repo files at $REPO_DIR are untouched"
  log "database at \${CLAUDE_PEERS_DB:-~/.claude-peers.db} is untouched (delete manually if desired)"
}

case "$CMD" in
  install)   cmd_install   ;;
  reset)     cmd_reset     ;;
  status)    cmd_status    ;;
  uninstall) cmd_uninstall ;;
  help|-h|--help) usage    ;;
  *)
    warn "unknown subcommand: $CMD"
    echo
    usage
    exit 2
    ;;
esac
