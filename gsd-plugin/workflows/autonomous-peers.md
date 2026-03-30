# /gsd:autonomous-peers

Run a full GSD milestone with peer-aware parallel execution. Discovers available Claude Code executor peers and a decision proxy via the broker, then orchestrates parallel phase execution across dependency-resolved waves.

If no executor peers are found, execution falls back to standard sequential autonomous mode automatically — no error, no special handling needed.

---

## Prerequisites

- Broker is running on `http://127.0.0.1:{CLAUDE_PEERS_PORT || 7899}`
- `.planning/ROADMAP.md` exists with defined phases and dependency declarations
- `.planning/STATE.md` exists with milestone context
- **Optional:** Running inside **tmux** enables dynamic executor spawning.
  Without tmux, the orchestrator uses only pre-existing executor peers
  (or falls back to sequential execution if none exist).
  - Install tmux: `sudo apt install tmux` (Linux) or `brew install tmux` (macOS)
  - `gsd-watch` binary at `~/.local/bin/gsd-watch` enables live sidebar dashboards per executor
- **Optional:** Project `.mcp.json` includes `context-packet` MCP server for shared context
  resolution across all spawned executor peers

---

## Execution

1. Register with the broker (or re-use existing registration if already connected).

2. Set your summary to identify yourself as the orchestrator:
   `set_summary("Orchestrator -- coordinating autonomous milestone execution")`
   This exact string is how executor peers and the proxy identify your role.

3. Read and follow the full orchestrator protocol in `@gsd-plugin/agents/gsd-orchestrator.md`.

---

## Fallback

If `discoverPeers` returns zero executors and no proxy:

1. **If running inside tmux:** The orchestrator dynamically spawns executor peers as tmux panes (up to 6). Each executor gets a companion `gsd-watch --no-emoji` sidebar for live progress monitoring. Spawned executors auto-register with the broker via the `gsd-peers-sync` PostToolUse hook. After all waves complete, executor panes are cleaned up automatically.

2. **If NOT in tmux:** The orchestrator falls back to standard sequential autonomous execution — running `/gsd:discuss-phase` → `/gsd:plan-phase` → `/gsd:execute-phase` for each incomplete phase in order. No special configuration or flags are needed.

---

## References

- `gsd-plugin/orchestrator/orchestrator-helpers.ts` — All protocol functions (discovery, dispatch, monitoring, sync, spawning)
- `gsd-plugin/orchestrator/tmux-manager.ts` — tmux pane lifecycle (spawn, kill, layout, liveness checks)
- `gsd-plugin/agents/gsd-orchestrator.md` — Orchestrator state machine and full decision logic (includes 5c.5 Dynamic Executor Spawning and 5f.5 Executor Cleanup)
- `gsd-plugin/agents/gsd-executor.md` — Executor agent (runs on peer instances receiving execute_phase)
- `gsd-plugin/agents/gsd-proxy.md` — Proxy agent (answers discuss-phase choices autonomously)
- `gsd-plugin/proxy/proxy-helpers.ts` — Proxy communication: sendDiscussChoice, waitForAnswer
- `shared/types.ts` — Message payload type contracts (ExecutePhasePayload, PhaseCompletePayload, etc.)
