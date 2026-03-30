/**
 * tui/tabs/peers.ts — Peers tab: live peer list from broker /list-peers
 *
 * Renders a table of active Claude Code instances with role badges,
 * PID, truncated summary, and color-coded last_seen timestamps.
 * Supports j/k scrolling when the list exceeds the viewport.
 */

import {
  moveTo,
  write,
  fg,
  resetStyle,
  bold,
  C,
  badge,
  truncate,
  padRight,
} from "../render.ts";
import { safeFetch, BROKER_URL } from "../broker.ts";
import type { Peer } from "../../shared/types.ts";

// ---------------------------------------------------------------------------
// Tab identity
// ---------------------------------------------------------------------------

export const TAB_NAME = "Peers";
export const REFRESH_MS = 2000;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let peerData: Peer[] = [];
let scrollOffset: number = 0;
let fetching: boolean = false;

// Last render args for scroll-triggered re-renders
let lastRenderArgs: {
  startRow: number;
  startCol: number;
  width: number;
  height: number;
} | null = null;

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchData(): Promise<void> {
  if (fetching) return;
  fetching = true;
  try {
    const data = await safeFetch<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    if (data !== null) {
      peerData = data;
    }
  } finally {
    fetching = false;
    // Re-render if we have saved render args
    if (lastRenderArgs) {
      const { startRow, startCol, width, height } = lastRenderArgs;
      renderSync(startRow, startCol, width, height);
    }
  }
}

// ---------------------------------------------------------------------------
// Role detection
// ---------------------------------------------------------------------------

function getRoleBadge(summary: string): string {
  const lower = summary.toLowerCase();
  if (lower.includes("orchestrat")) return badge("ORCH", C.purple);
  if (lower.includes("execut")) return badge("EXEC", C.blue);
  if (lower.includes("proxy") || lower.includes("decision")) return badge("PROXY", C.yellow);
  return badge("PEER", C.gray);
}

// ---------------------------------------------------------------------------
// Last-seen formatting
// ---------------------------------------------------------------------------

function formatLastSeen(lastSeen: string): { text: string; color: number } {
  const seenMs = new Date(lastSeen).getTime();
  const nowMs = Date.now();
  const diffSec = Math.max(0, Math.floor((nowMs - seenMs) / 1000));

  let text: string;
  if (diffSec < 60) {
    text = `${diffSec}s ago`;
  } else if (diffSec < 3600) {
    text = `${Math.floor(diffSec / 60)}m ago`;
  } else {
    text = `${Math.floor(diffSec / 3600)}h ago`;
  }

  let color: number;
  if (diffSec < 30) {
    color = C.green;
  } else if (diffSec <= 120) {
    color = C.yellow;
  } else {
    color = C.red;
  }

  return { text, color };
}

// ---------------------------------------------------------------------------
// Synchronous render (reads from module state)
// ---------------------------------------------------------------------------

function renderSync(
  startRow: number,
  startCol: number,
  width: number,
  height: number
): void {
  // Clear content area
  for (let r = startRow; r < startRow + height; r++) {
    moveTo(r, startCol);
    write(" ".repeat(width));
  }

  const footerRow = startRow + height - 1;
  const viewportHeight = height - 2; // reserve 1 for header, 1 for footer

  if (peerData.length === 0) {
    // Show "No peers connected" centered
    const msg = "No peers connected";
    const midRow = startRow + Math.floor(height / 2);
    const midCol = startCol + Math.max(0, Math.floor((width - msg.length) / 2));
    moveTo(midRow, midCol);
    write(fg(C.dimGray) + msg + resetStyle());
  } else {
    // Column widths
    const badgeWidth = 8;  // "[ORCH] " padded
    const pidWidth = 14;   // "PID:12345678  "
    const seenWidth = 10;  // "XXXm ago  "
    const summaryWidth = Math.max(10, width - startCol - badgeWidth - pidWidth - seenWidth - 2);

    // Header row
    moveTo(startRow, startCol);
    write(
      bold() +
      fg(C.bright) +
      padRight("Role", badgeWidth) +
      padRight("PID", pidWidth) +
      padRight("Summary", summaryWidth) +
      padRight("Last Seen", seenWidth) +
      resetStyle()
    );

    // Clamp scroll offset
    const maxScroll = Math.max(0, peerData.length - viewportHeight);
    if (scrollOffset > maxScroll) scrollOffset = maxScroll;
    if (scrollOffset < 0) scrollOffset = 0;

    // Render peer rows
    const visiblePeers = peerData.slice(scrollOffset, scrollOffset + viewportHeight);
    for (let i = 0; i < visiblePeers.length; i++) {
      const peer = visiblePeers[i];
      const row = startRow + 1 + i;
      const { text: seenText, color: seenColor } = formatLastSeen(peer.last_seen);

      moveTo(row, startCol);

      // Role badge (strip ANSI for padding, then render actual badge)
      const roleBadge = getRoleBadge(peer.summary);
      // Badge renders as [XXXX] — fixed visual width of 6 chars + trailing space
      write(roleBadge + " ".repeat(Math.max(0, badgeWidth - 6)));

      // PID
      write(fg(C.dimGray) + padRight(`PID:${peer.pid}`, pidWidth) + resetStyle());

      // Summary (truncated)
      write(fg(C.text) + padRight(truncate(peer.summary || "(no summary)", summaryWidth), summaryWidth) + resetStyle());

      // Last seen (color-coded)
      write(fg(seenColor) + padRight(seenText, seenWidth) + resetStyle());
    }
  }

  // Footer line
  moveTo(footerRow, startCol);
  write(
    fg(C.dimGray) +
    truncate(`${BROKER_URL} | ${peerData.length} peer(s)`, width) +
    resetStyle()
  );
}

// ---------------------------------------------------------------------------
// Tab interface exports
// ---------------------------------------------------------------------------

/**
 * render() is synchronous per TabDef interface.
 * Reads from module state (peerData). Kicks off a fire-and-forget fetch
 * that will update state and re-render on completion.
 */
export function render(
  startRow: number,
  startCol: number,
  width: number,
  height: number
): void {
  lastRenderArgs = { startRow, startCol, width, height };
  // Kick off async fetch (fire-and-forget) — result triggers re-render via lastRenderArgs
  fetchData();
  // Render current state synchronously (may show stale/empty data on first call)
  renderSync(startRow, startCol, width, height);
}

/** Called by app.ts to start background work. Fetches initial peer data. */
export function start(): void {
  fetchData();
}

/** Called by app.ts to stop background work. Resets module state. */
export function stop(): void {
  peerData = [];
  scrollOffset = 0;
  lastRenderArgs = null;
}

/** Called by app.ts for tab-specific key handling. */
export function handleKey(name: string): void {
  if (!lastRenderArgs) return;

  const { startRow, startCol, width, height } = lastRenderArgs;
  const viewportHeight = height - 2;
  const maxScroll = Math.max(0, peerData.length - viewportHeight);

  if (name === "j" || name === "down") {
    scrollOffset = Math.min(scrollOffset + 1, maxScroll);
    renderSync(startRow, startCol, width, height);
  } else if (name === "k" || name === "up") {
    scrollOffset = Math.max(scrollOffset - 1, 0);
    renderSync(startRow, startCol, width, height);
  }
}
