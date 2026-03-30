/**
 * tui/input.ts — Raw stdin keypress parser for comms-watch TUI
 *
 * Zero external dependencies. Parses raw stdin byte sequences into named
 * KeyEvent objects. Uses process.stdin.setRawMode(true) for raw input.
 */

export interface KeyEvent {
  name: string;    // "q", "1", "2", ..., "6", "tab", "shift-tab", "up", "down",
                   // "right", "left", "j", "k", "e", "w", "enter", "?", "escape",
                   // "c" (ctrl+c), "unknown"
  raw: Buffer;     // original bytes
  ctrl: boolean;   // Ctrl modifier detected
  shift: boolean;  // Shift modifier detected (for shift-tab)
}

export type KeyHandler = (key: KeyEvent) => void;

// Active data listener for removal on stopInput
let activeHandler: ((data: Buffer) => void) | null = null;

// Pending escape timeout handle
let escapeTimeout: ReturnType<typeof setTimeout> | null = null;

// Pending escape buffer (accumulated bytes waiting for timeout)
let pendingEscape: Buffer | null = null;

/**
 * Parse a raw buffer into a KeyEvent.
 * Handles arrow keys, tab, shift-tab, enter, ctrl+c, and printable chars.
 */
function parseKey(buf: Buffer): KeyEvent {
  const base: Omit<KeyEvent, "name"> = { raw: buf, ctrl: false, shift: false };
  const bytes = Array.from(buf);

  // Ctrl+C
  if (bytes[0] === 0x03) {
    return { ...base, name: "c", ctrl: true };
  }

  // Enter (\r = 0x0d)
  if (bytes[0] === 0x0d) {
    return { ...base, name: "enter" };
  }

  // Tab (\t = 0x09)
  if (bytes[0] === 0x09) {
    return { ...base, name: "tab" };
  }

  // Escape sequences
  if (bytes[0] === 0x1b && bytes.length > 1) {
    // Shift+Tab: ESC [ Z
    if (bytes[1] === 0x5b && bytes[2] === 0x5a) {
      return { ...base, name: "shift-tab", shift: true };
    }
    // Arrow keys: ESC [ A/B/C/D
    if (bytes[1] === 0x5b) {
      if (bytes[2] === 0x41) return { ...base, name: "up" };
      if (bytes[2] === 0x42) return { ...base, name: "down" };
      if (bytes[2] === 0x43) return { ...base, name: "right" };
      if (bytes[2] === 0x44) return { ...base, name: "left" };
    }
    return { ...base, name: "unknown" };
  }

  // Bare escape (handled via timeout in startInput, but as fallback)
  if (bytes[0] === 0x1b && bytes.length === 1) {
    return { ...base, name: "escape" };
  }

  // Single printable character
  if (bytes.length === 1 && bytes[0] >= 0x20 && bytes[0] <= 0x7e) {
    return { ...base, name: String.fromCharCode(bytes[0]) };
  }

  return { ...base, name: "unknown" };
}

/**
 * Start listening for keypresses.
 * Sets stdin to raw mode and registers a data listener.
 * Calls handler(key) for each parsed key event.
 */
export function startInput(handler: KeyHandler): void {
  if (activeHandler) {
    // Already listening — remove previous handler first
    process.stdin.off("data", activeHandler);
  }

  activeHandler = (data: Buffer) => {
    const bytes = Array.from(data);

    // Handle escape ambiguity: \x1b alone could be a bare Escape key,
    // or the start of an escape sequence (arrow keys, shift-tab, etc.)
    if (bytes[0] === 0x1b && bytes.length === 1) {
      // Buffer the escape byte and wait 50ms for more bytes
      if (escapeTimeout) {
        clearTimeout(escapeTimeout);
        escapeTimeout = null;
      }
      if (pendingEscape) {
        // Multiple escape bytes — flush pending first
        handler(parseKey(pendingEscape));
      }
      pendingEscape = data;
      escapeTimeout = setTimeout(() => {
        if (pendingEscape) {
          handler({ name: "escape", raw: pendingEscape, ctrl: false, shift: false });
          pendingEscape = null;
        }
        escapeTimeout = null;
      }, 50);
      return;
    }

    // If we have a pending escape and this is a continuation byte
    if (pendingEscape && bytes[0] !== 0x1b) {
      if (escapeTimeout) {
        clearTimeout(escapeTimeout);
        escapeTimeout = null;
      }
      // Combine pending escape with this data for sequence parsing
      const combined = Buffer.concat([pendingEscape, data]);
      pendingEscape = null;
      handler(parseKey(combined));
      return;
    }

    // If there's a pending escape and a new escape sequence starts, flush first
    if (pendingEscape && bytes[0] === 0x1b && bytes.length > 1) {
      if (escapeTimeout) {
        clearTimeout(escapeTimeout);
        escapeTimeout = null;
      }
      handler({ name: "escape", raw: pendingEscape, ctrl: false, shift: false });
      pendingEscape = null;
    }

    handler(parseKey(data));
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", activeHandler);
}

/**
 * Stop listening for keypresses.
 * Removes the data listener and restores stdin to cooked mode.
 */
export function stopInput(): void {
  if (escapeTimeout) {
    clearTimeout(escapeTimeout);
    escapeTimeout = null;
  }
  pendingEscape = null;

  if (activeHandler) {
    process.stdin.off("data", activeHandler);
    activeHandler = null;
  }

  try {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  } catch {
    // Ignore errors if stdin is not a TTY (e.g., in tests)
  }
}
