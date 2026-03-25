# /gsd:autonomous-peers

Run a full GSD milestone with peer-aware parallel execution. Discovers available Claude Code executor peers and a decision proxy via the broker, then orchestrates parallel phase execution across dependency-resolved waves.

If no executor peers are found, execution falls back to standard sequential autonomous mode automatically — no error, no special handling needed.

---

## Prerequisites

- Broker is running on `http://127.0.0.1:{CLAUDE_PEERS_PORT || 7899}`
- `.planning/ROADMAP.md` exists with defined phases and dependency declarations
- `.planning/STATE.md` exists with milestone context

---

## Execution

1. Register with the broker (or re-use existing registration if already connected).

2. Set your summary to identify yourself as the orchestrator:
   `set_summary("Orchestrator -- coordinating autonomous milestone execution")`
   This exact string is how executor peers and the proxy identify your role.

3. Read and follow the full orchestrator protocol in `@gsd-plugin/agents/gsd-orchestrator.md`.

---

## Fallback

If `discoverPeers` returns zero executors and no proxy, the orchestrator automatically falls back to standard sequential autonomous execution — running `/gsd:discuss-phase` → `/gsd:plan-phase` → `/gsd:execute-phase` for each incomplete phase in order. No special configuration or flags are needed.

---

## References

- `gsd-plugin/orchestrator/orchestrator-helpers.ts` — All protocol functions (discovery, dispatch, monitoring, sync)
- `gsd-plugin/agents/gsd-orchestrator.md` — Orchestrator state machine and full decision logic
- `gsd-plugin/agents/gsd-executor.md` — Executor agent (runs on peer instances receiving execute_phase)
- `gsd-plugin/agents/gsd-proxy.md` — Proxy agent (answers discuss-phase choices autonomously)
- `gsd-plugin/proxy/proxy-helpers.ts` — Proxy communication: sendDiscussChoice, waitForAnswer
- `shared/types.ts` — Message payload type contracts (ExecutePhasePayload, PhaseCompletePayload, etc.)
