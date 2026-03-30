/**
 * tui/render.ts — ANSI rendering primitives for comms-watch TUI
 *
 * Zero external dependencies. All output via process.stdout.write().
 * Uses ANSI 256-color palette only (not true color) for wider compatibility.
 */

// ---------------------------------------------------------------------------
// Named color constants (ANSI 256-color values matching design spec)
// ---------------------------------------------------------------------------

export const C = {
  bg: 233,      // dark background #0a0a0f
  bgLight: 234, // slightly lighter bg #12121a
  purple: 99,   // accent #7c6aef
  green: 34,    // success #28c840
  yellow: 214,  // warning #febc2e
  red: 203,     // error #ff5f57
  blue: 75,     // peer IDs #50a0ff
  dimGray: 238, // timestamps #444
  gray: 240,    // secondary #555
  bright: 254,  // headers #e0e0e0
  text: 250,    // normal text #c0c0c0
} as const;

// ---------------------------------------------------------------------------
// Screen buffer management
// ---------------------------------------------------------------------------

/** Enter the alternate screen buffer (saves normal terminal content) */
export function enterAltScreen(): void {
  process.stdout.write("\x1b[?1049h");
}

/** Exit the alternate screen buffer (restores normal terminal content) */
export function exitAltScreen(): void {
  process.stdout.write("\x1b[?1049l");
}

/** Clear the screen and move cursor to home position */
export function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

/** Hide the cursor */
export function hideCursor(): void {
  process.stdout.write("\x1b[?25l");
}

/** Show the cursor */
export function showCursor(): void {
  process.stdout.write("\x1b[?25h");
}

// ---------------------------------------------------------------------------
// Cursor control
// ---------------------------------------------------------------------------

/** Move cursor to row, col (1-based) */
export function moveTo(row: number, col: number): void {
  process.stdout.write(`\x1b[${row};${col}H`);
}

/** Write text directly to stdout */
export function write(text: string): void {
  process.stdout.write(text);
}

// ---------------------------------------------------------------------------
// Color system (ANSI 256-color)
// ---------------------------------------------------------------------------

/** Returns ANSI escape code to set foreground color (256-color palette) */
export function fg(color: number): string {
  return `\x1b[38;5;${color}m`;
}

/** Returns ANSI escape code to set background color (256-color palette) */
export function bg(color: number): string {
  return `\x1b[48;5;${color}m`;
}

/** Returns ANSI reset all attributes escape code */
export function resetStyle(): string {
  return "\x1b[0m";
}

/** Returns ANSI bold escape code */
export function bold(): string {
  return "\x1b[1m";
}

/** Returns ANSI dim escape code */
export function dim(): string {
  return "\x1b[2m";
}

// ---------------------------------------------------------------------------
// Box-drawing and layout
// ---------------------------------------------------------------------------

// Unicode box-drawing characters (single-line)
const BOX_TL = "\u250c"; // ┌
const BOX_TR = "\u2510"; // ┐
const BOX_BL = "\u2514"; // └
const BOX_BR = "\u2518"; // ┘
const BOX_H  = "\u2500"; // ─
const BOX_V  = "\u2502"; // │

/**
 * Draw a box using Unicode box-drawing characters.
 * Title (if provided) is rendered in bright text centered in the top border.
 */
export function drawBox(
  row: number,
  col: number,
  width: number,
  height: number,
  title?: string
): void {
  const innerWidth = width - 2;

  // Top border
  moveTo(row, col);
  if (title) {
    const truncatedTitle = truncate(title, innerWidth - 2);
    const titleWithSpaces = ` ${truncatedTitle} `;
    const padLeft = Math.floor((innerWidth - titleWithSpaces.length) / 2);
    const padRight = innerWidth - titleWithSpaces.length - padLeft;
    process.stdout.write(
      BOX_TL +
        BOX_H.repeat(padLeft) +
        fg(C.bright) +
        titleWithSpaces +
        resetStyle() +
        BOX_H.repeat(padRight) +
        BOX_TR
    );
  } else {
    process.stdout.write(BOX_TL + BOX_H.repeat(innerWidth) + BOX_TR);
  }

  // Side borders
  for (let r = 1; r < height - 1; r++) {
    moveTo(row + r, col);
    process.stdout.write(BOX_V);
    moveTo(row + r, col + width - 1);
    process.stdout.write(BOX_V);
  }

  // Bottom border
  moveTo(row + height - 1, col);
  process.stdout.write(BOX_BL + BOX_H.repeat(innerWidth) + BOX_BR);
}

/** Draw a horizontal line using the box-drawing horizontal character */
export function drawHLine(row: number, col: number, width: number): void {
  moveTo(row, col);
  process.stdout.write(BOX_H.repeat(width));
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Returns a colored badge string: [text] with fg color and reset.
 * Example: badge("DONE", C.green) returns "\x1b[38;5;34m[DONE]\x1b[0m"
 */
export function badge(text: string, colorCode: number): string {
  return `${fg(colorCode)}[${text}]${resetStyle()}`;
}

/**
 * Truncate text to maxLen characters, adding "..." if truncated.
 * The "..." counts toward maxLen (so truncate("abcdef", 5) = "ab...").
 */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  if (maxLen <= 3) return text.slice(0, maxLen);
  return text.slice(0, maxLen - 3) + "...";
}

/**
 * Pad text on the right with spaces to reach the specified width.
 * If text is already wider than width, returns text unchanged.
 */
export function padRight(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}

// ---------------------------------------------------------------------------
// Terminal size
// ---------------------------------------------------------------------------

/** Get current terminal dimensions */
export function getTermSize(): { rows: number; cols: number } {
  return {
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
  };
}
