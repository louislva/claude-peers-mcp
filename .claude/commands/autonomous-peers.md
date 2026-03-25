Run a full GSD milestone with peer-aware parallel execution.

Discovers available Claude Code executor peers and a decision proxy via the broker, then orchestrates parallel phase execution across dependency-resolved waves. Falls back to standard sequential autonomous mode when no peers are found.

## Instructions

1. **Register with the broker** if not already registered. Set your summary:
   ```
   set_summary("Orchestrator -- coordinating autonomous milestone execution")
   ```

2. **Read the orchestrator agent document** and follow it exactly:
   ```
   @gsd-plugin/agents/gsd-orchestrator.md
   ```

3. **Read these supporting files** for context:
   - `@gsd-plugin/orchestrator/orchestrator-helpers.ts` — All protocol functions
   - `@gsd-plugin/autonomous-peers-runtime.ts` — Kahn's sort + wave polling
   - `@shared/types.ts` — Message payload types

## Fallback Behavior

If `discoverPeers` returns zero executors and no proxy, fall back to standard sequential GSD:
- Run `/gsd:autonomous` (the existing sequential workflow)
- No special configuration needed — this is the normal path when running solo

## Peer Setup (for multi-session testing)

**Executor peer** (in a separate terminal):
1. Start Claude Code in the same repo
2. Read `gsd-plugin/agents/gsd-executor.md` and follow it
3. Set summary: `"Executor -- available for phase execution"`

**Decision proxy** (in a separate terminal):
1. Start Claude Code in the same repo
2. Read `gsd-plugin/agents/gsd-proxy.md` and follow it
3. Set summary: `"Decision proxy -- answering discuss-phase choices for autonomous runs"`
