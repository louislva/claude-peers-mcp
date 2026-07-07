#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${CLAUDE_PEERS_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
SCRIPT="$ROOT/hooks/codex-drain-peer-inbox.ts"

if [[ ! -f "$SCRIPT" ]]; then
  printf 'claude-peers Gemini hook missing: %s\n' "$SCRIPT" >&2
  exit 1
fi

CLAUDE_PEERS_CLIENT_TYPE=gemini \
CLAUDE_PEERS_HOOK_EVENT_NAME=BeforeAgent \
exec bun "$SCRIPT"
