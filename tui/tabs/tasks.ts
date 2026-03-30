/**
 * tui/tabs/tasks.ts — Tasks tab: flat task table from broker /list-waves + /wave-status
 *
 * Renders all tasks across all waves in a flat sorted table (by wave_number ASC,
 * then task id ASC). Footer shows count and lists files currently in-flight.
 * Supports j/k scrolling.
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
import { safeFetch } from "../broker.ts";
import type { Wave, TaskAssignment, ListWavesResponse } from "../../shared/types.ts";

// ---------------------------------------------------------------------------
// Tab identity
// ---------------------------------------------------------------------------

export const TAB_NAME = "Tasks";
export const REFRESH_MS = 2000;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let allTasks: Array<TaskAssignment & { wave_number: number }> = [];
let filesInFlight: string[] = [];
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
    const listResult = await safeFetch<ListWavesResponse>("/list-waves");
    if (listResult !== null && listResult.waves) {
      const collected: Array<TaskAssignment & { wave_number: number }> = [];

      for (const wave of listResult.waves) {
        const detail = await safeFetch<{ wave: Wave; tasks: TaskAssignment[] }>(
          "/wave-status",
          { wave_id: wave.id }
        );
        if (detail !== null) {
          for (const task of detail.tasks) {
            collected.push({ ...task, wave_number: wave.wave_number });
          }
        }
      }

      // Sort by wave_number ASC then id ASC
      collected.sort((a, b) => {
        if (a.wave_number !== b.wave_number) return a.wave_number - b.wave_number;
        return a.id - b.id;
      });

      allTasks = collected;

      // Collect files from running tasks
      const inFlight: string[] = [];
      for (const task of collected) {
        if (task.status === "running") {
          try {
            const files = JSON.parse(task.files) as string[];
            inFlight.push(...files);
          } catch {
            // ignore malformed files JSON
          }
        }
      }
      filesInFlight = inFlight;
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
// Color helpers
// ---------------------------------------------------------------------------

function taskStatusColor(status: string): number {
  switch (status) {
    case "completed": return C.green;
    case "running":   return C.purple;
    case "failed":    return C.red;
    case "blocked":   return C.yellow;
    default:          return C.dimGray;
  }
}

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return "--";
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
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

  // Reserve 2 footer rows + 1 header row
  const footerRow1 = startRow + height - 2;
  const footerRow2 = startRow + height - 1;
  const headerRow = startRow;
  const viewportHeight = height - 3; // header + 2 footer rows

  if (allTasks.length === 0) {
    const msg = "No tasks";
    const midRow = startRow + Math.floor(height / 2);
    const midCol = startCol + Math.max(0, Math.floor((width - msg.length) / 2));
    moveTo(midRow, midCol);
    write(fg(C.dimGray) + msg + resetStyle());
  } else {
    // Column widths
    const idWidth = 6;
    const waveWidth = 6;
    const taskWidth = 30;
    const execWidth = 12;
    const statusWidth = 10;
    // Duration takes remainder

    // Header row
    moveTo(headerRow, startCol);
    write(
      bold() +
      fg(C.bright) +
      padRight("ID", idWidth) +
      padRight("Wave", waveWidth) +
      padRight("Task", taskWidth) +
      padRight("Executor", execWidth) +
      padRight("Status", statusWidth) +
      "Duration" +
      resetStyle()
    );

    // Clamp scroll
    const maxScroll = Math.max(0, allTasks.length - viewportHeight);
    if (scrollOffset > maxScroll) scrollOffset = maxScroll;
    if (scrollOffset < 0) scrollOffset = 0;

    // Render task rows
    const visibleTasks = allTasks.slice(scrollOffset, scrollOffset + viewportHeight);
    for (let i = 0; i < visibleTasks.length; i++) {
      const task = visibleTasks[i];
      const row = headerRow + 1 + i;
      const tColor = taskStatusColor(task.status);
      const dur = formatDuration(task.started_at, task.completed_at);

      moveTo(row, startCol);
      write(
        fg(C.dimGray) + padRight(String(task.id), idWidth) + resetStyle() +
        fg(C.text)    + padRight(String(task.wave_number), waveWidth) + resetStyle() +
        fg(C.text)    + padRight(truncate(task.task_name, taskWidth - 2), taskWidth) + resetStyle() +
        (task.session_id
          ? fg(C.blue) + padRight(task.session_id.slice(0, 10), execWidth) + resetStyle()
          : fg(C.dimGray) + padRight("--", execWidth) + resetStyle()
        ) +
        badge(task.status.toUpperCase(), tColor) + " ".repeat(Math.max(0, statusWidth - task.status.length - 2)) +
        fg(C.dimGray) + dur + resetStyle()
      );
    }
  }

  // Footer row 1: task count
  moveTo(footerRow1, startCol);
  write(fg(C.dimGray) + allTasks.length + " task(s)" + resetStyle());

  // Footer row 2: in-flight files
  if (filesInFlight.length > 0) {
    moveTo(footerRow2, startCol);
    const inFlightLabel = "In-flight: ";
    write(
      fg(C.yellow) +
      inFlightLabel +
      fg(C.text) +
      truncate(filesInFlight.join(", "), width - inFlightLabel.length) +
      resetStyle()
    );
  }
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
  allTasks = [];
  filesInFlight = [];
  scrollOffset = 0;
  lastRenderArgs = null;
}

export function handleKey(name: string): void {
  if (!lastRenderArgs) return;
  const { startRow, startCol, width, height } = lastRenderArgs;
  const viewportHeight = height - 3;
  const maxScroll = Math.max(0, allTasks.length - viewportHeight);

  if (name === "j" || name === "down") {
    scrollOffset = Math.min(scrollOffset + 1, maxScroll);
    renderSync(startRow, startCol, width, height);
  } else if (name === "k" || name === "up") {
    scrollOffset = Math.max(scrollOffset - 1, 0);
    renderSync(startRow, startCol, width, height);
  }
}
