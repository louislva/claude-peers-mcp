---
phase: 06-tui-core
plan: 01
subsystem: tui
tags: [tui, ansi, rendering, input, broker, foundation]
dependency_graph:
  requires: []
  provides: [tui/render.ts, tui/input.ts, tui/broker.ts]
  affects: [tui/app.ts, tui/tabs/*.ts, tui/main.ts]
tech_stack:
  added: []
  patterns: [ANSI 256-color escape codes, raw stdin keypress parsing, broker HTTP fetch pattern]
key_files:
  created:
    - tui/render.ts
    - tui/input.ts
    - tui/broker.ts
  modified: []
decisions:
  - ANSI 256-color only (not true color) per project decision — wider terminal compatibility
  - brokerFetch duplicated from cli.ts per project convention (no cross-module imports)
  - 50ms escape timeout in input.ts to distinguish bare Escape from multi-byte sequences
metrics:
  duration: "~2 minutes"
  completed: "2026-03-30"
  tasks_completed: 3
  files_created: 3
---

# Phase 06 Plan 01: TUI Foundation Modules Summary

Three independent foundation modules built as the rendering, input, and broker layers for the comms-watch TUI: ANSI 256-color renderer with box-drawing primitives, raw stdin keypress parser with escape sequence disambiguation, and broker HTTP fetch helper matching cli.ts exactly.

## What Was Built

### tui/render.ts (~150 LOC)
ANSI rendering primitives with zero external dependencies:
- Screen buffer: `enterAltScreen`, `exitAltScreen`, `clearScreen`, `hideCursor`, `showCursor`
- Cursor: `moveTo(row, col)` (1-based), `write(text)`
- Color system: `fg(n)`, `bg(n)`, `resetStyle()`, `bold()`, `dim()` — ANSI 256-color
- Color constants object `C` with all design spec values: `purple=99`, `green=34`, `yellow=214`, `red=203`, `blue=75`, `bg=233`, `bgLight=234`, `dimGray=238`, `gray=240`, `bright=254`, `text=250`
- Layout: `drawBox(row, col, width, height, title?)`, `drawHLine(row, col, width)`
- Text: `badge(text, colorCode)`, `truncate(text, maxLen)`, `padRight(text, width)`
- Terminal: `getTermSize()` returning `{ rows, cols }`

### tui/input.ts (~170 LOC)
Raw stdin keypress parser with escape sequence timeout:
- `KeyEvent` interface: `name`, `raw`, `ctrl`, `shift`
- `KeyHandler` type alias
- `startInput(handler)`: sets raw mode, parses byte sequences
- `stopInput()`: removes listener, restores cooked mode
- Parses: `\x1b[A/B/C/D` → up/down/right/left, `\x09` → tab, `\x1b[Z` → shift-tab, `\x0d` → enter, `\x03` → ctrl+c (name="c", ctrl=true), bare `\x1b` (50ms timeout) → escape, printable chars → char name

### tui/broker.ts (~57 LOC)
Broker HTTP fetch helper matching cli.ts pattern exactly:
- `brokerFetch<T>(path, body?)`: generic fetch with 3s timeout, throws on errors
- `safeFetch<T>(path, body?)`: returns `T | null`, never throws (for polling loops)
- `isBrokerUp()`: returns `Promise<boolean>` via `/health` check
- `BROKER_URL`: `http://127.0.0.1:{CLAUDE_PEERS_PORT}` with default 7899

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Create ANSI renderer module | e774da5 |
| 2 | Create raw stdin keypress parser | 3bba919 |
| 3 | Create broker HTTP fetch helper | d7c9975 |

## Deviations from Plan

None — plan executed exactly as written. All acceptance criteria verified.

## Known Stubs

None — all modules are fully functional implementations with no placeholders.

## Self-Check: PASSED

- tui/render.ts: FOUND
- tui/input.ts: FOUND
- tui/broker.ts: FOUND
- Commit e774da5: FOUND
- Commit 3bba919: FOUND
- Commit d7c9975: FOUND
