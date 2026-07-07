#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${CLAUDE_PEERS_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
SCRIPT="$ROOT/hooks/register-peer-session.ts"

if [[ ! -f "$SCRIPT" ]]; then
  printf 'claude-peers Gemini register hook missing: %s\n' "$SCRIPT" >&2
  exit 1
fi

CLAUDE_PEERS_CLIENT_TYPE=gemini \
exec bun "$SCRIPT"
