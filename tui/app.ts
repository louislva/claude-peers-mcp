/**
 * tui/app.ts — Tab state machine and render orchestration for comms-watch TUI
 *
 * Manages tab switching, resize handling, refresh loops, and broker health checks.
 * Delegates rendering to each tab module. Consumed by tui/main.ts.
 */

import {
  clearScreen,
  moveTo,
  write,
  fg,
  bg,
  resetStyle,
  bold,
  C,
  drawHLine,
  getTermSize,
  hideCursor,
} from "./render.ts";
import { startInput, stopInput, type KeyEvent } from "./input.ts";
import { isBrokerUp, BROKER_URL } from "./broker.ts";
import * as gsdWatch from "./tabs/gsd-watch.ts";
import * as peers from "./tabs/peers.ts";
import * as waves from "./tabs/waves.ts";
import * as tasks from "./tabs/tasks.ts";
import * as messages from "./tabs/messages.ts";
import * as stats from "./tabs/stats.ts";

// Tab definition array — order matches number keys 1-6
const TABS = [gsdWatch, peers, waves, tasks, messages, stats];

export interface TabDef {
  TAB_NAME: string;
  REFRESH_MS: number;
  render(startRow: number, startCol: number, width: number, height: number): void;
  start(): void | Promise<void>;
  stop(): void;
  handleKey(name: string): void;
}

export class App {
  activeTab: number = 0;
  running: boolean = false;
  private refreshTimers: ReturnType<typeof setInterval>[] = [];
  private brokerTimer: ReturnType<typeof setInterval> | null = null;
  brokerConnected: boolean = false;
  noEmoji: boolean = false;

  /** Callback wired by main.ts to trigger cleanup and exit */
  onQuit: (() => void) | null = null;

  /**
   * Start the TUI: hide cursor, set up input, SIGWINCH, refresh timers, initial render.
   */
  start(noEmoji: boolean = false): void {
    this.noEmoji = noEmoji;
    this.running = true;

    hideCursor();
    startInput(this.handleKey.bind(this));

    // Handle terminal resize
    process.on("SIGWINCH", () => this.render());

    // Start each tab's background work (fs.watch, initial data load, etc.)
    for (const tab of TABS) {
      tab.start();
    }

    // Start per-tab refresh timers for tabs with REFRESH_MS > 0
    for (let i = 0; i < TABS.length; i++) {
      const tab = TABS[i];
      if (tab.REFRESH_MS > 0) {
        const timer = setInterval(() => this.refreshTab(i), tab.REFRESH_MS);
        this.refreshTimers.push(timer);
      }
    }

    // Broker health check every 5 seconds
    this.brokerTimer = setInterval(async () => {
      this.brokerConnected = await isBrokerUp();
      // Re-render status bar if active tab is visible
      if (this.running) {
        this.render();
      }
    }, 5000);

    // Check broker status immediately on startup
    isBrokerUp().then((up) => {
      this.brokerConnected = up;
      this.render();
    });

    // Initial render
    this.render();
  }

  /**
   * Stop the TUI: clear timers, stop each tab, stop input.
   */
  stop(): void {
    this.running = false;

    // Clear refresh timers
    for (const timer of this.refreshTimers) {
      clearInterval(timer);
    }
    this.refreshTimers = [];

    if (this.brokerTimer !== null) {
      clearInterval(this.brokerTimer);
      this.brokerTimer = null;
    }

    // Stop each tab's background work
    for (const tab of TABS) {
      tab.stop();
    }

    stopInput();
  }

  /**
   * Handle a keypress event dispatched from startInput.
   */
  handleKey(key: KeyEvent): void {
    // Quit on q or Ctrl+C
    if (key.name === "q" || (key.name === "c" && key.ctrl)) {
      this.stop();
      if (this.onQuit) {
        this.onQuit();
      }
      return;
    }

    // Number keys 1-6: switch to that tab
    if (key.name >= "1" && key.name <= "6") {
      const idx = parseInt(key.name, 10) - 1;
      if (idx >= 0 && idx < TABS.length) {
        this.activeTab = idx;
        this.render();
      }
      return;
    }

    // Tab: cycle forward
    if (key.name === "tab") {
      this.activeTab = (this.activeTab + 1) % TABS.length;
      this.render();
      return;
    }

    // Shift+Tab: cycle backward
    if (key.name === "shift-tab") {
      this.activeTab = (this.activeTab - 1 + TABS.length) % TABS.length;
      this.render();
      return;
    }

    // Forward to active tab's key handler
    TABS[this.activeTab].handleKey(key.name);
  }

  /**
   * Full re-render: clear screen, draw chrome and active tab content.
   */
  render(): void {
    const { rows, cols } = getTermSize();

    clearScreen();

    // Draw tab bar on row 1
    this.renderTabBar(cols);

    // Draw separator line on row 2
    moveTo(2, 1);
    write(fg(C.dimGray));
    drawHLine(2, 1, cols);
    write(resetStyle());

    // Render active tab content (rows 3..rows-1, leaving row rows for status bar)
    const contentHeight = rows - 3; // rows 3..(rows-1)
    if (contentHeight > 0) {
      TABS[this.activeTab].render(3, 1, cols, contentHeight);
    }

    // Draw status bar on last row
    this.renderStatusBar(rows, cols);
  }

  /**
   * Render the tab bar on row 1.
   * Active tab: purple background + bright text. Inactive: dim gray text.
   */
  private renderTabBar(cols: number): void {
    moveTo(1, 1);
    write(bg(C.bg));

    let line = bg(C.bg);
    for (let i = 0; i < TABS.length; i++) {
      const tab = TABS[i];
      const keyNum = i + 1;
      const label = ` ${keyNum} ${tab.TAB_NAME} `;

      if (i === this.activeTab) {
        // Active tab: purple background, bright bold text
        line += bg(C.purple) + fg(C.bright) + bold() + label + resetStyle() + bg(C.bg);
      } else {
        // Inactive tab: dim gray text
        line += fg(C.gray) + label + resetStyle() + bg(C.bg);
      }
    }

    // Pad remainder of row with background color
    write(line + resetStyle());
  }

  /**
   * Render the status bar on the last row.
   * Left: broker status + URL. Right: key hints.
   */
  private renderStatusBar(rows: number, cols: number): void {
    moveTo(rows, 1);

    const brokerStatus = this.brokerConnected
      ? fg(C.green) + "BROKER OK" + resetStyle()
      : fg(C.red) + "BROKER --" + resetStyle();

    const brokerInfo = ` ${brokerStatus} ${fg(C.dimGray)}${BROKER_URL}${resetStyle()}`;
    const hints = `${fg(C.dimGray)}q:quit  ?:help  1-6:tabs${resetStyle()} `;

    // Compute visible lengths for padding (strip ANSI escape codes for length)
    const visibleLeft = ` BROKER OK ${BROKER_URL}`;
    const visibleRight = `q:quit  ?:help  1-6:tabs `;
    const padWidth = Math.max(0, cols - visibleLeft.length - visibleRight.length);

    write(bg(C.bgLight) + brokerInfo + " ".repeat(padWidth) + hints + resetStyle());
  }

  /**
   * Called by refresh timers — only re-render if the refreshing tab is active.
   */
  private refreshTab(index: number): void {
    if (index === this.activeTab && this.running) {
      this.render();
    }
  }
}
