/**
 * tui/main.ts — Entry point for comms-watch TUI
 *
 * Usage: bun tui/main.ts [--no-emoji] [--help|-h]
 *
 * Enters alternate screen, starts the App, registers signal handlers,
 * and ensures clean terminal restoration on exit.
 */

import { enterAltScreen, exitAltScreen, showCursor, clearScreen } from "./render.ts";
import { App } from "./app.ts";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const noEmoji = args.includes("--no-emoji");
const showHelp = args.includes("--help") || args.includes("-h");

if (showHelp) {
  console.log(`comms-watch — Terminal dashboard for GSD project status and gsd-comms broker state

Usage:
  bun tui/main.ts [options]

Options:
  --no-emoji    Use ASCII-only badges instead of emoji characters
  --help, -h    Show this help message and exit

Key bindings:
  1-6           Switch to tab by number
  Tab           Cycle to next tab
  Shift+Tab     Cycle to previous tab
  j/k           Scroll up/down in active tab
  e             Expand all (GSD Watch tab)
  w             Collapse all (GSD Watch tab)
  Enter         Toggle expand/collapse (GSD Watch tab)
  ?             Toggle help overlay
  q / Ctrl+C    Exit and restore terminal

Tabs:
  1  GSD Watch   .planning/ tree view (event-driven)
  2  Peers       Live peer list from broker /list-peers
  3  Waves       Wave breakdown from broker /wave-status
  4  Tasks       Flat task table from wave data
  5  Messages    Message feed from broker /list-messages
  6  Stats       DB stats from broker /stats + /health

Environment:
  GSD_COMMS_PORT      Broker HTTP port (default: 7899). Legacy CLAUDE_PEERS_PORT still honoured.
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Startup sequence
// ---------------------------------------------------------------------------

enterAltScreen();

const app = new App();

/**
 * Cleanup function: stop app, restore terminal state, exit.
 * Order matters: stop app -> clear -> exit alt screen -> show cursor -> exit.
 */
function cleanup(): void {
  app.stop();
  clearScreen();
  exitAltScreen();
  showCursor();
  process.exit(0);
}

// Signal handlers for clean exit
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// Wire quit callback from App (triggered by q or Ctrl+C keypress)
app.onQuit = cleanup;

// Start the TUI
app.start(noEmoji);
