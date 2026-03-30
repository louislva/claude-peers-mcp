/**
 * tui/tabs/stats.ts — Stats tab: broker health, DB info, row counts, retention policy
 *
 * Fetches from /stats (GET) and /health (GET) every 5 seconds.
 * Displays a dashboard of broker health, database info, row count table,
 * and retention policy settings.
 */

import {
  moveTo,
  write,
  fg,
  resetStyle,
  bold,
  C,
  truncate,
  padRight,
} from "../render.ts";
import { safeFetch } from "../broker.ts";

// ---------------------------------------------------------------------------
// Tab identity
// ---------------------------------------------------------------------------

export const TAB_NAME = "Stats";
export const REFRESH_MS = 5000;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface StatsResponse {
  db_path: string;
  db_size_bytes: number;
  db_size_human: string;
  wal_size_bytes: number;
  schema_version: number;
  retention: {
    messages_hours: number;
    sessions_days: number;
    waves_days: number;
  };
  counts: {
    peers: number;
    messages_total: number;
    messages_undelivered: number;
    messages_delivered: number;
    sessions_active: number;
    sessions_completed: number;
    waves_total: number;
    waves_running: number;
    waves_completed: number;
    tasks_total: number;
    tasks_running: number;
    tasks_completed: number;
  };
}

interface HealthResponse {
  status: string;
  peers: number;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let statsData: StatsResponse | null = null;
let healthData: HealthResponse | null = null;
let fetching: boolean = false;

// Last render args for re-renders after async data loads
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
    // Both /stats and /health are GET endpoints (no body)
    const [stats, health] = await Promise.all([
      safeFetch<StatsResponse>("/stats"),
      safeFetch<HealthResponse>("/health"),
    ]);
    if (stats !== null) statsData = stats;
    if (health !== null) healthData = health;
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

  // Loading state
  if (statsData === null && healthData === null) {
    const msg = "Loading...";
    const midRow = startRow + Math.floor(height / 2);
    const midCol = startCol + Math.max(0, Math.floor((width - msg.length) / 2));
    moveTo(midRow, midCol);
    write(fg(C.dimGray) + msg + resetStyle());
    return;
  }

  let row = startRow;
  const col = startCol + 2; // left margin
  const labelWidth = 20;

  // Helper: render a key-value row
  function kv(label: string, value: string, valueColor: number = C.text): void {
    moveTo(row++, col);
    write(fg(C.gray) + padRight(label + ":", labelWidth) + fg(valueColor) + value + resetStyle());
  }

  // Helper: render a section header
  function sectionHeader(title: string): void {
    moveTo(row++, col);
    write(bold() + fg(C.bright) + title + resetStyle());
  }

  // ---------------------------------------------------------------------------
  // Section 1: Broker Health
  // ---------------------------------------------------------------------------
  sectionHeader("Broker Health");

  if (healthData !== null) {
    const isOk = healthData.status === "ok";
    kv("Status", healthData.status.toUpperCase(), isOk ? C.green : C.red);
    kv("Active Peers", String(healthData.peers), C.text);
  } else {
    kv("Status", "UNREACHABLE", C.red);
  }

  row++; // blank line

  // ---------------------------------------------------------------------------
  // Section 2: Database
  // ---------------------------------------------------------------------------
  sectionHeader("Database");

  if (statsData !== null) {
    kv("Path", truncate(statsData.db_path, width - col - labelWidth - 2));
    kv("Size", statsData.db_size_human);
    kv("Schema", `v${statsData.schema_version}`);
  } else {
    kv("Path", "(unavailable)", C.dimGray);
    kv("Size", "(unavailable)", C.dimGray);
    kv("Schema", "(unavailable)", C.dimGray);
  }

  row++; // blank line

  // ---------------------------------------------------------------------------
  // Section 3: Row Counts
  // ---------------------------------------------------------------------------
  sectionHeader("Row Counts");

  if (statsData !== null) {
    const c = statsData.counts;

    // Table header
    moveTo(row++, col);
    const colA = 16;
    const colB = 30;
    write(
      bold() +
      fg(C.dimGray) +
      padRight("Category", colA) +
      padRight("Active / Running", colB) +
      "Total" +
      resetStyle()
    );

    // Peers
    moveTo(row++, col);
    write(
      fg(C.text) + padRight("Peers", colA) +
      fg(C.green) + padRight(`${c.peers} active`, colB) +
      fg(C.text) + String(c.peers) + resetStyle()
    );

    // Messages
    moveTo(row++, col);
    write(
      fg(C.text) + padRight("Messages", colA) +
      fg(c.messages_undelivered > 0 ? C.yellow : C.text) +
      padRight(`${c.messages_undelivered} pending / ${c.messages_delivered} delivered`, colB) +
      fg(C.text) + String(c.messages_total) + resetStyle()
    );

    // Sessions
    moveTo(row++, col);
    write(
      fg(C.text) + padRight("Sessions", colA) +
      fg(c.sessions_active > 0 ? C.green : C.text) +
      padRight(`${c.sessions_active} active / ${c.sessions_completed} completed`, colB) +
      fg(C.text) + String(c.sessions_active + c.sessions_completed) + resetStyle()
    );

    // Waves
    moveTo(row++, col);
    write(
      fg(C.text) + padRight("Waves", colA) +
      fg(c.waves_running > 0 ? C.green : C.text) +
      padRight(`${c.waves_running} running / ${c.waves_completed} done`, colB) +
      fg(C.text) + String(c.waves_total) + resetStyle()
    );

    // Tasks
    moveTo(row++, col);
    write(
      fg(C.text) + padRight("Tasks", colA) +
      fg(c.tasks_running > 0 ? C.blue : C.text) +
      padRight(`${c.tasks_running} running / ${c.tasks_completed} done`, colB) +
      fg(C.text) + String(c.tasks_total) + resetStyle()
    );
  } else {
    moveTo(row++, col);
    write(fg(C.dimGray) + "(stats unavailable)" + resetStyle());
  }

  row++; // blank line

  // ---------------------------------------------------------------------------
  // Section 4: Retention Policy
  // ---------------------------------------------------------------------------
  if (row < startRow + height - 1) {
    sectionHeader("Retention Policy");

    if (statsData !== null) {
      const r = statsData.retention;
      kv("Messages", `${r.messages_hours}h (delivered)`);
      kv("Sessions", `${r.sessions_days}d (completed)`);
      kv("Waves", `${r.waves_days}d (completed/failed)`);
    } else {
      moveTo(row++, col);
      write(fg(C.dimGray) + "(retention info unavailable)" + resetStyle());
    }
  }
}

// ---------------------------------------------------------------------------
// Tab interface exports
// ---------------------------------------------------------------------------

/**
 * render() is synchronous per TabDef interface.
 * Reads from module state. Kicks off a fire-and-forget fetch
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
  // Render current state synchronously
  renderSync(startRow, startCol, width, height);
}

/** Called by app.ts to start background work. Fetches initial stats. */
export function start(): void {
  fetchData();
}

/** Called by app.ts to stop background work. Resets module state. */
export function stop(): void {
  statsData = null;
  healthData = null;
  lastRenderArgs = null;
}

/** Called by app.ts for tab-specific key handling. Stats tab has no scroll. */
export function handleKey(_name: string): void {}
