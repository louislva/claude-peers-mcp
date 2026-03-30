# Phase 6: TUI Core - Context

**Gathered:** 2026-03-30
**Status:** Ready for planning
**Mode:** Auto-generated (infrastructure phase — discuss skipped)

<domain>
## Phase Boundary

Build the TUI application shell: alternate screen buffer management, raw stdin keypress parser, tab state machine with 6 tabs, ANSI 256-color renderer with box-drawing, terminal resize handling (SIGWINCH), and a refresh loop with configurable intervals per tab. Zero new dependencies — raw ANSI escape codes + Bun APIs only.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Use the design spec at `docs/superpowers/specs/2026-03-30-comms-watch-tui-design.md` and the HTML preview at `docs/tui-preview.html` as the visual reference.

Key constraints from design spec:
- File structure: `tui/main.ts`, `tui/render.ts`, `tui/input.ts`, `tui/app.ts`, `tui/broker.ts`, `tui/tabs/*.ts`
- Alternate screen buffer: `\x1b[?1049h` / `\x1b[?1049l`
- ANSI 256-color (not true color)
- Raw mode stdin via `process.stdin.setRawMode(true)`
- Tab content is placeholder strings for now — actual tab implementations come in Phases 7-8
- `--no-emoji` flag for ASCII-only mode
- Handle SIGINT/SIGTERM for clean exit (restore terminal)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `cli.ts` — existing broker HTTP fetch helper (`brokerFetch<T>()`) with timeout and error handling
- `shared/types.ts` — all TypeScript types for broker API (Peer, Message, Session, Wave, TaskAssignment)

### Established Patterns
- Bun-native APIs: `Bun.spawn()`, `Bun.file()`, `process.env`
- Per-module `brokerFetch` duplication pattern (self-contained modules, no cross-imports)
- Environment variable config: `CLAUDE_PEERS_PORT`, `CLAUDE_PEERS_DB`

### Integration Points
- `tui/broker.ts` will duplicate the `brokerFetch` pattern from `cli.ts`
- Tab implementations (Phases 7-8) will import from `tui/render.ts` for ANSI primitives
- `tui/main.ts` is the entry point — `bun tui/main.ts` to run

</code_context>

<specifics>
## Specific Ideas

- Visual design matches the HTML preview at `docs/tui-preview.html` — dark background, purple accent, green/yellow/red status colors
- Tab bar at top with number key hints, status bar at bottom with broker connection status and help hint
- Refresh loop: broker tabs poll every 2s, stats every 5s, GSD Watch is event-driven (fs.watch)

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>
