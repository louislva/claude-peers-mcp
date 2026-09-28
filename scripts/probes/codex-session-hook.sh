#!/bin/bash
# Phase 0 probe: log a Codex hook payload and the hook's process ancestry.
out="$(dirname "$0")/out/codex-hook.log"
payload="$(cat)"
{
  echo "=== $(date -u +%FT%TZ) pid=$$"
  echo "payload: $payload"
  pid=$$
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    echo "  ancestor $pid $(ps -o comm= -p "$pid")"
    pid=$(ps -o ppid= -p "$pid" | tr -d ' ')
  done
} >> "$out"
exit 0
