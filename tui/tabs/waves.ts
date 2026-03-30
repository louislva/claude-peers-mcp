/**
 * tui/tabs/waves.ts — Waves placeholder tab
 *
 * Renders a placeholder for the wave breakdown from broker /wave-status.
 * Real implementation in Phase 8.
 */

import { moveTo, write, fg, resetStyle, C } from "../render.ts";

export const TAB_NAME = "Waves";
export const REFRESH_MS = 2000;

/**
 * Render placeholder content within the given bounds.
 * Content is vertically centered in the available area.
 */
export function render(
  startRow: number,
  startCol: number,
  width: number,
  height: number
): void {
  const midRow = startRow + Math.floor(height / 2);
  const label = "Waves - broker /wave-status";
  const note = "(Phase 8)";

  // Clear the content area
  for (let r = startRow; r < startRow + height; r++) {
    moveTo(r, startCol);
    write(" ".repeat(width));
  }

  // Render centered label
  const labelCol = startCol + Math.max(0, Math.floor((width - label.length) / 2));
  moveTo(midRow - 1, labelCol);
  write(fg(C.bright) + label + resetStyle());

  // Render phase note below
  const noteCol = startCol + Math.max(0, Math.floor((width - note.length) / 2));
  moveTo(midRow + 1, noteCol);
  write(fg(C.dimGray) + note + resetStyle());
}

/** Called by app.ts to start any background polling/watching */
export function start(): void {}

/** Called by app.ts to stop background polling/watching */
export function stop(): void {}

/** Called by app.ts for tab-specific key handling */
export function handleKey(name: string): void {}
