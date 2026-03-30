/**
 * tui/tabs/waves.ts — Waves tab: wave breakdown from broker /list-waves + /wave-status
 *
 * Renders wave groups with status badges and per-task rows showing
 * executor session ID, task status, and elapsed duration.
 * Supports j/k scrolling when content exceeds the viewport.
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

export const TAB_NAME = "Waves";
export const REFRESH_MS = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WaveWithTasks {
  wave: Wave & { task_count: number; tasks_completed: number; tasks_running: number };
  tasks: TaskAssignment[];
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let wavesData: WaveWithTasks[] = [];
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
      const results: WaveWithTasks[] = [];
      for (const wave of listResult.waves) {
        const detail = await safeFetch<{ wave: Wave; tasks: TaskAssignment[] }>(
          "/wave-status",
          { wave_id: wave.id }
        );
        results.push({
          wave,
          tasks: detail !== null ? detail.tasks : [],
        });
      }
      wavesData = results;
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

function waveStatusColor(status: string): number {
  switch (status) {
    case "completed": return C.green;
    case "running":   return C.purple;
    case "failed":    return C.red;
    default:          return C.dimGray; // pending
  }
}

function taskStatusColor(status: string): number {
  switch (status) {
    case "completed": return C.green;
    case "running":   return C.purple;
    case "failed":    return C.red;
    case "blocked":   return C.yellow;
    default:          return C.dimGray; // pending
  }
}

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return "";
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

  const footerRow = startRow + height - 1;
  const contentHeight = height - 1; // reserve 1 for footer

  if (wavesData.length === 0) {
    const msg = "No waves";
    const midRow = startRow + Math.floor(height / 2);
    const midCol = startCol + Math.max(0, Math.floor((width - msg.length) / 2));
    moveTo(midRow, midCol);
    write(fg(C.dimGray) + msg + resetStyle());
  } else {
    // Build all renderable lines
    const lines: Array<() => void> = [];

    for (const { wave, tasks } of wavesData) {
      // Wave header line
      lines.push(() => {
        const wColor = waveStatusColor(wave.status);
        const waveBadge = badge(wave.status.toUpperCase(), wColor);
        const header =
          waveBadge +
          " " +
          bold() +
          fg(C.bright) +
          "Wave " +
          wave.wave_number +
          resetStyle() +
          fg(C.dimGray) +
          " (Phase " +
          wave.phase +
          ")" +
          " — " +
          fg(C.text) +
          wave.tasks_completed +
          "/" +
          wave.task_count +
          " tasks" +
          resetStyle();
        write(header);
      });

      // Task rows
      for (const task of tasks) {
        lines.push(() => {
          const tColor = taskStatusColor(task.status);
          const tBadge = badge(task.status.toUpperCase(), tColor);
          const executor = task.session_id
            ? fg(C.blue) + task.session_id.slice(0, 8) + resetStyle()
            : fg(C.dimGray) + "unassigned" + resetStyle();
          const dur = formatDuration(task.started_at, task.completed_at);
          const durStr = dur ? fg(C.dimGray) + "  " + dur + resetStyle() : "";
          const row =
            "  " +
            tBadge +
            " " +
            fg(C.text) +
            truncate(task.task_name, 30) +
            resetStyle() +
            "  " +
            executor +
            durStr;
          write(row);
        });
      }

      // Blank separator between wave groups
      lines.push(() => {
        write("");
      });
    }

    // Clamp scroll
    const maxScroll = Math.max(0, lines.length - contentHeight);
    if (scrollOffset > maxScroll) scrollOffset = maxScroll;
    if (scrollOffset < 0) scrollOffset = 0;

    // Render visible lines
    const visibleLines = lines.slice(scrollOffset, scrollOffset + contentHeight);
    for (let i = 0; i < visibleLines.length; i++) {
      moveTo(startRow + i, startCol);
      visibleLines[i]();
    }
  }

  // Footer
  moveTo(footerRow, startCol);
  write(fg(C.dimGray) + wavesData.length + " wave(s)" + resetStyle());
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
  wavesData = [];
  scrollOffset = 0;
  lastRenderArgs = null;
}

export function handleKey(name: string): void {
  if (!lastRenderArgs) return;
  const { startRow, startCol, width, height } = lastRenderArgs;

  if (name === "j" || name === "down") {
    scrollOffset = Math.max(0, scrollOffset + 1);
    renderSync(startRow, startCol, width, height);
  } else if (name === "k" || name === "up") {
    scrollOffset = Math.max(0, scrollOffset - 1);
    renderSync(startRow, startCol, width, height);
  }
}
