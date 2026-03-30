# Phase 7: GSD Watch Tab - Context

**Gathered:** 2026-03-30
**Status:** Ready for planning
**Mode:** Auto-generated (infrastructure-like phase — discuss skipped)

<domain>
## Phase Boundary

Implement the GSD Watch tab (`tui/tabs/gsd-watch.ts`) that replicates the core gsd-watch functionality: parse `.planning/ROADMAP.md` and phase directories to build a tree view of milestone > phases > plans with status badges. Use `fs.watch()` for live updates. Support expand/collapse navigation and a progress bar.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion. Key references:
- Design spec: `docs/superpowers/specs/2026-03-30-comms-watch-tui-design.md` (GSD Watch Tab section)
- HTML preview: `docs/tui-preview.html` (Tab 1 visual reference)
- gsd-watch binary strings analysis showed these status badges: `[disc]`, `[plan]`, `[exec]`, `[vrfy]`, `[rsrch]`, `[DONE]`, `[PEND]`
- Phase status derived from: ROADMAP.md `[x]` markers, presence of CONTEXT.md, PLAN.md, SUMMARY.md, VERIFICATION.md files
- Plan status: pending (no files), discussed (CONTEXT.md), planned (PLAN.md), executing (SUMMARY.md partial), verified (VERIFICATION.md passed)
- Tree structure: Milestone node > Phase nodes > Plan nodes
- fs.watch() on `.planning/` directory (recursive) for live updates

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `tui/render.ts` — ANSI primitives: `badge()`, `color()`, `truncate()`, box drawing, color constants (C.green, C.yellow, C.red, C.purple, C.dim, C.blue)
- `tui/app.ts` — Tab interface: `render(width, height)`, `start()`, `stop()`, `handleKey(key)`
- `tui/tabs/gsd-watch.ts` — existing stub (replace contents)

### Established Patterns
- Tab modules export: `TAB_NAME`, `REFRESH_MS`, `render()`, `start()`, `stop()`, `handleKey()`
- REFRESH_MS = 0 for GSD Watch (event-driven via fs.watch, not polled)
- `render()` returns `string[]` (array of lines), app.ts handles cursor positioning

### Integration Points
- `tui/tabs/gsd-watch.ts` is already registered in `tui/app.ts` TABS array at index 0
- fs.watch() watcher started in `start()`, cleaned up in `stop()`
- `handleKey()` receives KeyEvent from input.ts — handle Enter (toggle), e (expand all), w (collapse all), j/k (scroll)

</code_context>

<specifics>
## Specific Ideas

- Progress bar at bottom: `[████████░░] 84% (11/13 plans)` style, using render.ts color helpers
- Tree indentation with `|` connector lines like the HTML preview
- Collapsed nodes show `>`, expanded show `v`
- Status badge colors: DONE=green, EXEC=purple, PLAN=blue, DISC=yellow, PEND=dim, VRFY=green

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>
