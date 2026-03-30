/**
 * tui/tabs/messages.ts — Messages tab: recent message feed from broker /list-messages
 *
 * Renders the 50 most recent inter-peer messages with color-coded type badges,
 * from/to peer IDs, text preview, and relative timestamps.
 * Supports j/k scrolling.
 */

import {
  moveTo,
  write,
  fg,
  resetStyle,
  C,
  badge,
  truncate,
} from "../render.ts";
import { safeFetch } from "../broker.ts";
import type { Message, MessageType } from "../../shared/types.ts";

// ---------------------------------------------------------------------------
// Tab identity
// ---------------------------------------------------------------------------

export const TAB_NAME = "Messages";
export const REFRESH_MS = 2000;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let messagesData: Message[] = [];
let scrollOffset: number = 0;
let fetching: boolean = false;

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
    const data = await safeFetch<Message[]>("/list-messages", { limit: 50 });
    if (data !== null) {
      messagesData = data;
    }
  } finally {
    fetching = false;
    if (lastRenderArgs) {
      const { startRow, startCol, width, height } = lastRenderArgs;
      renderSync(startRow, startCol, width, height);
    }
  }
}

// ---------------------------------------------------------------------------
// Type badge helpers
// ---------------------------------------------------------------------------

function getTypeBadge(msgType: MessageType): string {
  switch (msgType) {
    case "execute_phase":    return badge("EXEC", C.blue);
    case "phase_progress":   return badge("PROG", C.purple);
    case "phase_complete":   return badge("DONE", C.green);
    case "phase_blocked":    return badge("BLKD", C.red);
    case "discuss_choice":   return badge("ASK", C.yellow);
    case "discuss_answer":   return badge("ANS", C.yellow);
    case "task_complete":    return badge("TASK", C.green);
    case "task_blocked":     return badge("TBLK", C.red);
    case "wave_advance":     return badge("WAVE", C.purple);
    case "status_request":   return badge("SREQ", C.dimGray);
    case "status_response":  return badge("SRSP", C.dimGray);
    case "reclaim_task":     return badge("RCLM", C.red);
    case "chat":             return badge("CHAT", C.text);
    default:                 return badge("MSG", C.dimGray);
  }
}

// ---------------------------------------------------------------------------
// Time ago formatting
// ---------------------------------------------------------------------------

function timeAgo(sentAt: string): string {
  const sent = new Date(sentAt).getTime();
  const diffMs = Date.now() - sent;
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

// ---------------------------------------------------------------------------
// Synchronous render (reads from module state)
// ---------------------------------------------------------------------------

// Approximate visual width of a type badge: "[XXXX]" = 6 chars
const BADGE_VISUAL_WIDTH = 6;

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
  const viewportHeight = height - 1; // reserve 1 for footer

  if (messagesData.length === 0) {
    const msg = "No messages";
    const midRow = startRow + Math.floor(height / 2);
    const midCol = startCol + Math.max(0, Math.floor((width - msg.length) / 2));
    moveTo(midRow, midCol);
    write(fg(C.dimGray) + msg + resetStyle());
  } else {
    // Layout: [BADGE] fromID -> toID  preview  Xs
    // Fixed widths: badge=6, " "=1, from=8, " -> "=4, to=8, "  "=2, time=4, "  "=2 = 35 chars overhead
    const OVERHEAD = BADGE_VISUAL_WIDTH + 1 + 8 + 4 + 8 + 2 + 4 + 2;
    const previewWidth = Math.max(10, width - OVERHEAD);

    // Clamp scroll
    const maxScroll = Math.max(0, messagesData.length - viewportHeight);
    if (scrollOffset > maxScroll) scrollOffset = maxScroll;
    if (scrollOffset < 0) scrollOffset = 0;

    const visibleMessages = messagesData.slice(scrollOffset, scrollOffset + viewportHeight);
    for (let i = 0; i < visibleMessages.length; i++) {
      const msg = visibleMessages[i];
      const row = startRow + i;
      const typeBadge = getTypeBadge(msg.msg_type);
      const ago = timeAgo(msg.sent_at);

      moveTo(row, startCol);
      write(
        typeBadge +
        " " +
        fg(C.blue) + msg.from_id.slice(0, 8) + resetStyle() +
        fg(C.dimGray) + " -> " + resetStyle() +
        fg(C.blue) + msg.to_id.slice(0, 8) + resetStyle() +
        "  " +
        fg(C.text) + truncate(msg.text, previewWidth) + resetStyle() +
        "  " +
        fg(C.dimGray) + ago + resetStyle()
      );
    }
  }

  // Footer
  moveTo(footerRow, startCol);
  write(fg(C.dimGray) + messagesData.length + " message(s)" + resetStyle());
}

// ---------------------------------------------------------------------------
// Tab interface exports
// ---------------------------------------------------------------------------

export function render(
  startRow: number,
  startCol: number,
  width: number,
  height: number
): void {
  lastRenderArgs = { startRow, startCol, width, height };
  fetchData();
  renderSync(startRow, startCol, width, height);
}

export function start(): void {
  fetchData();
}

export function stop(): void {
  messagesData = [];
  scrollOffset = 0;
  lastRenderArgs = null;
}

export function handleKey(name: string): void {
  if (!lastRenderArgs) return;
  const { startRow, startCol, width, height } = lastRenderArgs;
  const viewportHeight = height - 1;
  const maxScroll = Math.max(0, messagesData.length - viewportHeight);

  if (name === "j" || name === "down") {
    scrollOffset = Math.min(scrollOffset + 1, maxScroll);
    renderSync(startRow, startCol, width, height);
  } else if (name === "k" || name === "up") {
    scrollOffset = Math.max(scrollOffset - 1, 0);
    renderSync(startRow, startCol, width, height);
  }
}
