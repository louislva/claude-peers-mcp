# comms-watch TUI Design Spec

## Overview

A single terminal dashboard (`comms-watch`) that combines GSD project status monitoring with claude-peers broker state visualization. Launched via `/comms-watch` as a tmux split pane. Built with raw ANSI escape codes — zero external dependencies.

## Architecture

```
comms-watch (Bun binary: tui/main.ts)
├── tui/render.ts    — Alternate screen, cursor, box drawing, colors (~150 LOC)
├── tui/input.ts     — Raw stdin keypress parser (~80 LOC)
├── tui/app.ts       — Tab manager, refresh loop, resize handler (~120 LOC)
├── tui/tabs/
│   ├── gsd-watch.ts — .planning/ tree view with fswatch (~150 LOC)
│   ├── peers.ts     — Live peer list from broker /list-peers (~100 LOC)
│   ├── waves.ts     — Wave breakdown from broker /wave-status (~120 LOC)
│   ├── tasks.ts     — Flat task table from wave-status data (~100 LOC)
│   ├── messages.ts  — Message feed from broker /poll-messages (~100 LOC)
│   └── stats.ts     — DB stats from broker /stats + /health (~80 LOC)
└── tui/broker.ts    — Shared broker HTTP fetch helper (~40 LOC)
```

Total estimate: ~940 lines of TypeScript.

## Tab Specifications

### Tab 1: GSD Watch

Replicates the core gsd-watch functionality:
- Reads `.planning/ROADMAP.md`, `STATE.md`, phase dirs (`*-PLAN.md`, `*-SUMMARY.md`, `*-VERIFICATION.md`)
- Tree view: Milestone > Phases > Plans with status badges
- Status badges: `[DONE]`, `[EXEC]`, `[PLAN]`, `[DISC]`, `[VRFY]`, `[PEND]`
- Progress bar at bottom (completed plans / total plans)
- Live updates via `fs.watch()` on `.planning/` directory
- Keyboard: `e` expand all, `w` collapse all, `j/k` scroll, `Enter` toggle node

### Tab 2: Peers

- Polls broker `POST /list-peers` with `scope: "machine"` every 2 seconds
- Columns: ID, PID, Summary, Last Seen
- Role badges parsed from summary string: ORCH, EXEC, PROXY
- Color-coded last_seen: green (<30s), yellow (30-120s), red (>120s)
- Footer: repo path + broker URL

### Tab 3: Waves

- Polls broker `POST /wave-status` for each known wave
- Groups tasks by wave number
- Shows wave status badge: DONE, RUNNING, PENDING, FAILED
- Per-task rows: task name, assigned executor peer, status, duration
- Dependency info per wave header

### Tab 4: Tasks

- Same data source as Waves, but flat table view
- Columns: ID, Wave, Task Name, Executor, Status, Duration
- Footer: files currently in flight (from running tasks' file lists)
- Sorted by: wave number, then task ID

### Tab 5: Messages

- Polls broker `POST /poll-messages` with a special viewer peer ID (read-only, does not ACK)
- Needs new broker endpoint: `POST /list-messages` (returns recent N messages regardless of delivery status)
- Shows: message type badge, from, to, text preview, timestamp
- Color-coded by type: execute_phase (blue), phase_progress (purple), discuss_choice (yellow), phase_complete (green), status_request (dim), errors (red)
- Most recent at top, capped at 50 messages

### Tab 6: Stats

- Polls broker `GET /stats` + `GET /health` every 5 seconds (less frequent than other tabs)
- Stat cards: active peers, DB size, waves total, tasks total
- Row counts table: peers, messages (pending/delivered), sessions (active/completed), waves, tasks
- Retention policy display
- Database info: path, schema version, WAL size, broker URL

## New Broker Endpoint

### `POST /list-messages`

Returns the most recent N messages across all peers, regardless of delivery status. Required for the Messages tab since `/poll-messages` only returns undelivered messages for a specific peer.

```typescript
// Request
{ limit?: number } // default 50, max 200

// Response
Array<{
  id: number;
  from_id: string;
  to_id: string;
  text: string;
  msg_type: MessageType;
  payload: string;
  sent_at: string;
  delivered: number;
}>
```

## Slash Commands

### `/comms-watch` (primary)

Launches the full TUI in a tmux split pane (35% width, right side). Same pattern as `/gsd-watch`:

1. Check `comms-watch` binary exists (or fall back to `bun tui/main.ts`)
2. Check running inside tmux
3. Check for duplicate instance (pane title starts with `comms-watch:`)
4. Spawn via `tmux split-window -h -p 35 -d`

### `/comms-peers` (inline)

Quick text-only peer list. No TUI, no tmux. Calls broker `/list-peers` and prints formatted output inline in the Claude Code conversation.

### `/comms-send <peer-id> <message>` (inline)

Send a message to a peer. Calls broker `/send-message`. Reports success/failure inline.

### `/comms-stats` (inline)

Quick text-only stats dump. Calls broker `/stats` and prints formatted output inline.

### `/comms-kill` (inline)

Stop the broker daemon. Same as `bun cli.ts kill-broker`.

## Input Handling

- **Tab switching:** `1-6` number keys, `Tab`/`Shift+Tab` to cycle
- **Scrolling:** `j/k` or arrow keys for vertical scroll within active tab
- **Tree navigation (GSD Watch tab):** `Enter` toggle expand/collapse, `e` expand all, `w` collapse all
- **Help overlay:** `?` toggles help
- **Quit:** `q` exits cleanly (restores terminal)

## Refresh Strategy

- **Tabs 1 (GSD Watch):** Event-driven via `fs.watch()` on `.planning/`. No polling.
- **Tabs 2-5 (Peers, Waves, Tasks, Messages):** Poll broker every 2 seconds.
- **Tab 6 (Stats):** Poll broker every 5 seconds.
- **Rendering:** Only re-render when data changes (diff check) or tab switches. No unnecessary screen flicker.

## Terminal Compatibility

- Uses alternate screen buffer (`\x1b[?1049h` / `\x1b[?1049l`)
- Raw mode stdin for keypress capture
- ANSI 256-color palette (not true color — wider terminal support)
- Handles `SIGWINCH` for terminal resize
- Handles `SIGINT`/`SIGTERM` for clean exit (restore terminal state)
- `--no-emoji` flag uses ASCII-only badges (same as gsd-watch)

## Visual Design

Matches the approved HTML preview at `docs/tui-preview.html`:

- Dark background with subtle borders (box-drawing characters)
- Purple accent for active tab indicator and highlights
- Green for success/healthy states
- Yellow for warnings/pending
- Red for errors/blocked
- Blue for peer IDs and executor assignments
- Dim gray for timestamps and secondary info

## File Structure

```
tui/
  main.ts          — Entry point: parse args, init app, start refresh loop
  render.ts        — ANSI primitives: box, color, cursor, clear, screen buffer
  input.ts         — Raw stdin reader, keypress event parser
  app.ts           — Tab state machine, resize handler, render orchestration
  broker.ts        — Shared brokerFetch() with timeout and error handling
  tabs/
    gsd-watch.ts   — .planning/ parser + tree renderer
    peers.ts       — Peer list renderer
    waves.ts       — Wave breakdown renderer
    tasks.ts       — Task table renderer
    messages.ts    — Message feed renderer
    stats.ts       — Stats dashboard renderer
```

## Non-Goals

- No mouse support (keyboard-only, like gsd-watch)
- No configuration file (use env vars for broker port/DB path, same as cli.ts)
- No compiled binary for v1.1 (run via `bun tui/main.ts`; compilation is a future enhancement)
- No message sending from TUI (use `/comms-send` for that)
- No filtering/search within tabs (future enhancement)
