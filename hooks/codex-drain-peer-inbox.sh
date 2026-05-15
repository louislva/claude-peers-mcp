#!/usr/bin/env bash
set -u

ROOT="${CLAUDE_PEERS_ROOT:-/home/manzo/claude-peers-mcp}"
SCRIPT="$ROOT/hooks/codex-drain-peer-inbox.ts"

if [[ ! -f "$SCRIPT" ]]; then
  printf 'claude-peers Codex hook missing: %s\n' "$SCRIPT" >&2
  exit 1
fi

exec bun "$SCRIPT"
