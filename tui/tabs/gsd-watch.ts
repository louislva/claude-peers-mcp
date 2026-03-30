/**
 * tui/tabs/gsd-watch.ts — GSD Watch tab: live .planning/ tree view
 *
 * Renders a tree of milestone > phase > plan nodes parsed from .planning/ROADMAP.md.
 * Supports expand/collapse navigation, status badges, scroll, and progress bar.
 * Event-driven via fs.watch — no polling (REFRESH_MS = 0).
 *
 * Exports: TAB_NAME, REFRESH_MS, render, start, stop, handleKey
 */

import * as path from "node:path";
import {
  moveTo,
  write,
  fg,
  bg,
  resetStyle,
  bold,
  C,
  badge,
  truncate,
  padRight,
} from "../render.ts";
import { parseGsdTree, watchPlanning } from "./gsd-watch-parser.ts";
import type { GsdTree, TreeNode, NodeStatus } from "./gsd-watch-parser.ts";

// ---------------------------------------------------------------------------
// Tab identity
// ---------------------------------------------------------------------------

export const TAB_NAME = "GSD Watch";
export const REFRESH_MS = 0; // event-driven via fs.watch, not polled

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let tree: GsdTree = { roots: [], completedPlans: 0, totalPlans: 0 };
let stopWatcher: (() => void) | null = null;
let cursorIndex: number = 0; // index into visible (flattened) nodes
let scrollOffset: number = 0; // first visible row in viewport
let planningDir: string | null = null;
let noData: boolean = false; // true if .planning/ not found

/**
 * Find the git repository root by walking up from script location, then cwd.
 * Returns cwd as final fallback.
 */
async function findGitRoot(): Promise<string> {
  // Try from the script's directory first (tui/tabs/ -> project root)
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const fromScript = path.resolve(scriptDir, "../..");
  if (await Bun.file(path.join(fromScript, ".planning", "ROADMAP.md")).exists()) {
    return fromScript;
  }

  // Walk up from cwd looking for .planning/ROADMAP.md
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (await Bun.file(path.join(dir, ".planning", "ROADMAP.md")).exists()) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

// Last render args for watcher-triggered re-renders
let lastRenderArgs: {
  startRow: number;
  startCol: number;
  width: number;
  height: number;
} | null = null;

// ---------------------------------------------------------------------------
// Visible node flattening
// ---------------------------------------------------------------------------

interface VisibleNode {
  node: TreeNode;
  depth: number;
}

/**
 * Flatten the tree into a list of visible nodes, respecting expanded/collapsed state.
 */
function flattenVisible(roots: TreeNode[]): VisibleNode[] {
  const result: VisibleNode[] = [];

  function walk(node: TreeNode, depth: number): void {
    result.push({ node, depth });
    if (node.expanded && node.children.length > 0) {
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    }
  }

  for (const root of roots) {
    walk(root, 0);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Recursive node operations
// ---------------------------------------------------------------------------

function expandAll(nodes: TreeNode[]): void {
  for (const node of nodes) {
    node.expanded = true;
    if (node.children.length > 0) {
      expandAll(node.children);
    }
  }
}

function collapseAll(nodes: TreeNode[], isRoot: boolean = true): void {
  for (const node of nodes) {
    // Keep milestone (root) nodes expanded so phases are visible
    if (isRoot) {
      node.expanded = true;
    } else {
      node.expanded = false;
    }
    if (node.children.length > 0) {
      collapseAll(node.children, false);
    }
  }
}

// ---------------------------------------------------------------------------
// Status badge rendering
// ---------------------------------------------------------------------------

function statusBadge(status: NodeStatus): string {
  switch (status) {
    case "DONE":
      return badge("DONE", C.green);
    case "EXEC":
      return badge("EXEC", C.purple);
    case "PLAN":
      return badge("PLAN", C.blue);
    case "DISC":
      return badge("DISC", C.yellow);
    case "VRFY":
      return badge("VRFY", C.green);
    case "PEND":
      return badge("PEND", C.dimGray);
    default:
      return badge("????", C.dimGray);
  }
}

/** Raw (ANSI-stripped) length of a status badge: "[XXXX]" = 6 chars */
const BADGE_VISIBLE_LEN = 6; // "[DONE]" = 6

// ---------------------------------------------------------------------------
// render()
// ---------------------------------------------------------------------------

export function render(
  startRow: number,
  startCol: number,
  width: number,
  height: number
): void {
  // Store for watcher-triggered re-renders
  lastRenderArgs = { startRow, startCol, width, height };

  // Handle no .planning/ case
  if (noData || !planningDir) {
    const msg = "No .planning/ directory found";
    const midRow = startRow + Math.floor(height / 2);
    for (let r = startRow; r < startRow + height; r++) {
      moveTo(r, startCol);
      write(padRight("", width));
    }
    const col = startCol + Math.max(0, Math.floor((width - msg.length) / 2));
    moveTo(midRow, col);
    write(fg(C.dimGray) + msg + resetStyle());
    return;
  }

  const visible = flattenVisible(tree.roots);

  // Handle empty tree
  if (visible.length === 0) {
    const msg = "No phases found";
    const midRow = startRow + Math.floor(height / 2);
    for (let r = startRow; r < startRow + height; r++) {
      moveTo(r, startCol);
      write(padRight("", width));
    }
    const col = startCol + Math.max(0, Math.floor((width - msg.length) / 2));
    moveTo(midRow, col);
    write(fg(C.dimGray) + msg + resetStyle());
    return;
  }

  // Clamp cursor and scroll
  cursorIndex = Math.min(cursorIndex, Math.max(0, visible.length - 1));

  // Reserve 2 rows: 1 for progress bar, 1 for gap
  const viewportHeight = Math.max(1, height - 2);
  const treeRows = visible.slice(scrollOffset, scrollOffset + viewportHeight);

  // Render tree rows
  for (let rowIdx = 0; rowIdx < viewportHeight; rowIdx++) {
    const absRow = startRow + rowIdx;
    moveTo(absRow, startCol);

    const visibleIdx = scrollOffset + rowIdx;
    const item = treeRows[rowIdx];

    if (!item) {
      // Clear empty rows below the tree
      write(padRight("", width));
      continue;
    }

    const { node, depth } = item;
    const isCursor = visibleIdx === cursorIndex;

    // Build the line content (visible chars tracked separately)
    let line = "";
    let visibleLen = 0;

    // Highlight cursor row
    if (isCursor) {
      line += bg(C.bgLight) + fg(C.bright) + bold();
    }

    // Indentation: 2 spaces per depth level
    const indent = "  ".repeat(depth);
    line += indent;
    visibleLen += indent.length;

    // Tree connector based on kind
    let connector = "";
    if (node.kind === "phase") {
      connector = "|-- ";
    } else if (node.kind === "plan") {
      connector = "    |-- ";
    }
    line += connector;
    visibleLen += connector.length;

    // Collapse indicator
    let indicator = "  ";
    if (node.children.length > 0) {
      indicator = node.expanded ? "v " : "> ";
    }
    line += indicator;
    visibleLen += indicator.length;

    // Status badge: "[XXXX]" adds 6 visible chars + 1 space
    line += statusBadge(node.status) + " ";
    visibleLen += BADGE_VISIBLE_LEN + 1;

    // Node name, truncated to fit remaining width
    const remainingWidth = Math.max(0, width - visibleLen);
    const name = truncate(node.name, remainingWidth);
    line += name;
    visibleLen += name.length;

    // Pad to full width to clear previous content
    const padLen = Math.max(0, width - visibleLen);
    line += " ".repeat(padLen);

    if (isCursor) {
      line += resetStyle();
    }

    write(line);
  }

  // Gap row between tree and progress bar
  const gapRow = startRow + height - 2;
  if (gapRow >= startRow) {
    moveTo(gapRow, startCol);
    write(padRight("", width));
  }

  // Progress bar on last line
  renderProgressBar(startRow + height - 1, startCol, width);
}

// ---------------------------------------------------------------------------
// Progress bar rendering
// ---------------------------------------------------------------------------

function renderProgressBar(row: number, startCol: number, width: number): void {
  const { completedPlans, totalPlans } = tree;
  const percent = totalPlans > 0 ? Math.round((completedPlans / totalPlans) * 100) : 0;

  // Bar width: min(30, width - 20)
  const barWidth = Math.min(30, Math.max(4, width - 20));
  const filled = totalPlans > 0 ? Math.round((completedPlans / totalPlans) * barWidth) : 0;
  const empty = barWidth - filled;

  const barFilled = fg(C.green) + "|".repeat(filled) + resetStyle();
  const barEmpty = fg(C.dimGray) + ".".repeat(empty) + resetStyle();
  const stats = fg(C.bright) + ` ${percent}% (${completedPlans}/${totalPlans} plans)` + resetStyle();

  const visibleBarLen = 2 + barWidth; // "[" + bar + "]"
  const visibleStatsLen = ` ${percent}% (${completedPlans}/${totalPlans} plans)`.length;
  const totalVisible = visibleBarLen + visibleStatsLen;
  const padLen = Math.max(0, width - totalVisible);

  moveTo(row, startCol);
  write(
    fg(C.dimGray) + "[" + resetStyle() +
    barFilled +
    barEmpty +
    fg(C.dimGray) + "]" + resetStyle() +
    stats +
    " ".repeat(padLen)
  );
}

// ---------------------------------------------------------------------------
// start() / stop()
// ---------------------------------------------------------------------------

/**
 * Called by app.ts to start background watching.
 * Detects .planning/ directory, parses initial tree, starts fs.watch.
 */
export async function start(): Promise<void> {
  // Find .planning/ relative to git root, then fall back to cwd
  const gitRoot = await findGitRoot();
  const candidate = path.join(gitRoot, ".planning");
  const roadmapPath = path.join(candidate, "ROADMAP.md");

  try {
    await Bun.file(roadmapPath).text();
    planningDir = candidate;
    noData = false;
  } catch {
    planningDir = null;
    noData = true;
    return;
  }

  // Parse initial tree
  tree = await parseGsdTree(planningDir);

  // Start watcher
  stopWatcher = watchPlanning(planningDir, async () => {
    if (!planningDir) return;

    // Re-parse tree
    tree = await parseGsdTree(planningDir);

    // Clamp cursor to new visible node count
    const visible = flattenVisible(tree.roots);
    if (visible.length > 0) {
      cursorIndex = Math.min(cursorIndex, visible.length - 1);
    } else {
      cursorIndex = 0;
    }

    // Immediately re-render if we have cached dimensions
    if (lastRenderArgs) {
      render(
        lastRenderArgs.startRow,
        lastRenderArgs.startCol,
        lastRenderArgs.width,
        lastRenderArgs.height
      );
    }
  });
}

/**
 * Called by app.ts to stop background watching and reset state.
 */
export function stop(): void {
  if (stopWatcher) {
    stopWatcher();
    stopWatcher = null;
  }
  tree = { roots: [], completedPlans: 0, totalPlans: 0 };
  cursorIndex = 0;
  scrollOffset = 0;
  planningDir = null;
  noData = false;
  lastRenderArgs = null;
}

// ---------------------------------------------------------------------------
// handleKey()
// ---------------------------------------------------------------------------

/**
 * Handle tab-specific key events dispatched from app.ts.
 */
export function handleKey(name: string): void {
  const visible = flattenVisible(tree.roots);
  if (visible.length === 0) return;

  switch (name) {
    case "enter": {
      // Toggle expanded/collapsed on the node at cursorIndex
      const item = visible[cursorIndex];
      if (item && item.node.children.length > 0) {
        item.node.expanded = !item.node.expanded;
        // After collapse, clamp cursor if it would be out of bounds
        const newVisible = flattenVisible(tree.roots);
        cursorIndex = Math.min(cursorIndex, Math.max(0, newVisible.length - 1));
        // Clamp scroll
        if (lastRenderArgs) {
          const viewportHeight = Math.max(1, lastRenderArgs.height - 2);
          if (cursorIndex < scrollOffset) {
            scrollOffset = cursorIndex;
          } else if (cursorIndex >= scrollOffset + viewportHeight) {
            scrollOffset = cursorIndex - viewportHeight + 1;
          }
        }
      }
      break;
    }

    case "e": {
      // Expand all nodes recursively
      expandAll(tree.roots);
      break;
    }

    case "w": {
      // Collapse all non-root nodes; keep milestone roots expanded
      collapseAll(tree.roots, true);
      // Clamp cursor to visible
      const newVisible = flattenVisible(tree.roots);
      cursorIndex = Math.min(cursorIndex, Math.max(0, newVisible.length - 1));
      scrollOffset = Math.min(scrollOffset, Math.max(0, cursorIndex));
      break;
    }

    case "j":
    case "down": {
      if (cursorIndex < visible.length - 1) {
        cursorIndex++;
        // Adjust scroll if cursor moves below viewport
        if (lastRenderArgs) {
          const viewportHeight = Math.max(1, lastRenderArgs.height - 2);
          if (cursorIndex >= scrollOffset + viewportHeight) {
            scrollOffset = cursorIndex - viewportHeight + 1;
          }
        }
      }
      break;
    }

    case "k":
    case "up": {
      if (cursorIndex > 0) {
        cursorIndex--;
        // Adjust scroll if cursor moves above viewport
        if (cursorIndex < scrollOffset) {
          scrollOffset = cursorIndex;
        }
      }
      break;
    }
  }

  // Re-render after key handling
  if (lastRenderArgs) {
    render(
      lastRenderArgs.startRow,
      lastRenderArgs.startCol,
      lastRenderArgs.width,
      lastRenderArgs.height
    );
  }
}
