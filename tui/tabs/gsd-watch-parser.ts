/**
 * tui/tabs/gsd-watch-parser.ts — GSD .planning/ directory tree parser
 *
 * Parses ROADMAP.md + phase directories into a typed GsdTree structure.
 * Used by gsd-watch.ts tab renderer (Phase 7 Plan 02).
 *
 * Exports: parseGsdTree, watchPlanning, GsdTree, TreeNode, NodeStatus, NodeKind
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NodeStatus = "DONE" | "EXEC" | "PLAN" | "DISC" | "VRFY" | "PEND";
export type NodeKind = "milestone" | "phase" | "plan";

export interface TreeNode {
  kind: NodeKind;
  /** Human-readable name, e.g. "v1.1 comms-watch TUI Dashboard", "Phase 7: GSD Watch Tab", "07-01-PLAN.md" */
  name: string;
  status: NodeStatus;
  children: TreeNode[];
  /** Default: true for milestones and phases; true for plans (leaf nodes) */
  expanded: boolean;
}

export interface GsdTree {
  roots: TreeNode[];
  completedPlans: number;
  totalPlans: number;
}

// ---------------------------------------------------------------------------
// ROADMAP.md parser
// ---------------------------------------------------------------------------

/**
 * Represents a plan entry parsed from the ROADMAP.md Phase Details section.
 */
interface RoadmapPlanEntry {
  /** e.g. "07-01" */
  planId: string;
  /** Full plan file name, e.g. "07-01-PLAN.md" */
  planFile: string;
  /** true if marked [x] in ROADMAP */
  doneInRoadmap: boolean;
}

/**
 * Represents a phase entry parsed from the ROADMAP.md Phase Details section.
 */
interface RoadmapPhaseEntry {
  /** e.g. "Phase 7: GSD Watch Tab" */
  name: string;
  /** Phase number as string, e.g. "7" */
  number: string;
  /** true if the phase header itself was marked [x] in the active phases list */
  doneInRoadmap: boolean;
  plans: RoadmapPlanEntry[];
}

/**
 * Represents a milestone section parsed from ROADMAP.md.
 */
interface RoadmapMilestoneEntry {
  name: string;
  phases: RoadmapPhaseEntry[];
}

/**
 * Parse the ROADMAP.md content into structured milestone/phase/plan entries.
 *
 * Strategy:
 * 1. Find active milestone sections (### vX.Y ...) anywhere in the file
 *    — within ## Phases section or as standalone headers
 * 2. Parse active phase lines: `- [x] **Phase N: Name**` or `- [ ] **Phase N: Name**`
 * 3. Parse Phase Details sections to find plan entries
 *
 * This handles both the full project ROADMAP.md format (with ## Phases, <details>,
 * and ## Phase Details) and simpler test-fixture formats with just `### vX.Y` headers.
 */
function parseRoadmap(content: string): RoadmapMilestoneEntry[] {
  const lines = content.split("\n");
  const milestones: RoadmapMilestoneEntry[] = [];

  // -----------------------------------------------------------------------
  // Pass 1: Parse ## Phase Details section to collect plan entries per phase
  // -----------------------------------------------------------------------
  // Format:
  //   ### Phase N: Name
  //   Plans:
  //   - [x] NN-MM-PLAN.md — description
  //   - [ ] NN-MM-PLAN.md — description

  const phaseDetailsMap: Map<string, RoadmapPlanEntry[]> = new Map();
  let inPhaseDetails = false;
  let currentPhaseName: string | null = null;
  let inPlanList = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect ## Phase Details section
    if (/^## Phase Details\s*$/.test(line)) {
      inPhaseDetails = true;
      currentPhaseName = null;
      inPlanList = false;
      continue;
    }

    // Detect end of Phase Details (another ## heading)
    if (inPhaseDetails && /^## /.test(line)) {
      inPhaseDetails = false;
      currentPhaseName = null;
      inPlanList = false;
      continue;
    }

    if (!inPhaseDetails) continue;

    // Phase heading within Phase Details: ### Phase N: Name
    const phaseDetailHeaderMatch = line.match(/^###\s+Phase\s+(\d+)[:\s](.+)/i);
    if (phaseDetailHeaderMatch) {
      const phaseNum = phaseDetailHeaderMatch[1].trim();
      const phaseTitleRaw = phaseDetailHeaderMatch[2].trim();
      currentPhaseName = `Phase ${phaseNum}: ${phaseTitleRaw}`;
      inPlanList = false;
      if (!phaseDetailsMap.has(currentPhaseName)) {
        phaseDetailsMap.set(currentPhaseName, []);
      }
      continue;
    }

    // "Plans:" marker starts the plan list
    if (/^Plans:\s*$/.test(line.trim()) && currentPhaseName) {
      inPlanList = true;
      continue;
    }

    // Plan entry line: - [x] NN-MM-PLAN.md — description
    if (inPlanList && currentPhaseName) {
      const planLineMatch = line.match(/^-\s+\[([x ])\]\s+(\d{2}-\d{2}-[A-Za-z]+\.md)/);
      if (planLineMatch) {
        const done = planLineMatch[1] === "x";
        const planFile = planLineMatch[2];
        // Extract the plan ID (e.g. "07-01" from "07-01-PLAN.md")
        const planIdMatch = planFile.match(/^(\d{2}-\d{2})/);
        const planId = planIdMatch ? planIdMatch[1] : planFile;

        const entry: RoadmapPlanEntry = { planId, planFile, doneInRoadmap: done };
        const plans = phaseDetailsMap.get(currentPhaseName) ?? [];
        plans.push(entry);
        phaseDetailsMap.set(currentPhaseName, plans);
      } else if (line.trim() === "" || (/^[^-]/.test(line.trim()) && line.trim() !== "")) {
        // Non-list item — end the plan list for this phase
        inPlanList = false;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Pass 2: Parse milestone + phase list from the entire file
  // -----------------------------------------------------------------------
  // We handle two formats:
  //   A) ## Phases section with ### vX.Y subsections and <details> blocks
  //   B) Simple ### vX.Y headers directly followed by phase list items
  //
  // Both formats use `- [x] **Phase N: Name**` or `- [ ] **Phase N: Name**`
  // for phase entries.

  // Map from phase name -> done status (from the phases list)
  const phaseStatusMap: Map<string, boolean> = new Map();
  // Map from milestone name -> array of phase names (in order), preserves insertion order
  const milestonePhaseMap: Map<string, string[]> = new Map();

  let currentMilestoneName: string | null = null;
  let skipUntilDetailsEnd = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip archived <details>...</details> blocks (completed milestones in ## Phases)
    if (/^<details/.test(line.trim())) {
      skipUntilDetailsEnd = true;
      continue;
    }
    if (skipUntilDetailsEnd) {
      if (line.trim() === "</details>") {
        skipUntilDetailsEnd = false;
      }
      continue;
    }

    // Skip ## Phase Details section — already processed above
    if (/^## Phase Details\s*$/.test(line)) {
      // Skip until end of file or next top-level ## section
      while (i < lines.length && !/^## [^P]/.test(lines[i + 1] ?? "")) {
        i++;
      }
      continue;
    }

    // Milestone subsection header: ### vX.Y Name  (or "### v1.1 comms-watch ...")
    // Match lines that start with ### but are NOT "### Phase N:" headings
    const milestoneHeaderMatch = line.match(/^###\s+(?!Phase\s+\d+[:\s])(.+)/);
    if (milestoneHeaderMatch) {
      currentMilestoneName = milestoneHeaderMatch[1].trim();
      if (!milestonePhaseMap.has(currentMilestoneName)) {
        milestonePhaseMap.set(currentMilestoneName, []);
      }
      continue;
    }

    // Phase list entry: - [x] **Phase N: Name** - description  OR  - [ ] **Phase N: Name** ...
    // Also handles: - [x] Phase N: Name  (without bold markers)
    const phaseLineMatch = line.match(/^-\s+\[([x ])\]\s+\*?\*?Phase\s+(\d+)[:\s]([^*\n]+)/i);
    if (phaseLineMatch && currentMilestoneName) {
      const done = phaseLineMatch[1] === "x";
      const phaseNum = phaseLineMatch[2].trim();
      const phaseTitleRaw = phaseLineMatch[3].trim();
      // Remove trailing ** if bold, and trailing description after " - "
      const phaseTitle = phaseTitleRaw
        .replace(/\*\*.*$/, "")  // remove ** and everything after
        .replace(/\s+-\s+.*$/, "") // remove " - description" suffix
        .trim();
      const fullPhaseName = `Phase ${phaseNum}: ${phaseTitle}`;

      phaseStatusMap.set(fullPhaseName, done);
      const arr = milestonePhaseMap.get(currentMilestoneName) ?? [];
      if (!arr.includes(fullPhaseName)) {
        arr.push(fullPhaseName);
      }
      milestonePhaseMap.set(currentMilestoneName, arr);
    }
  }

  // -----------------------------------------------------------------------
  // Step 3: Build milestone entries, matching phases from the list and plans
  // -----------------------------------------------------------------------

  for (const [milestoneName, phaseNames] of milestonePhaseMap) {
    const phaseEntries: RoadmapPhaseEntry[] = [];

    for (const phaseName of phaseNames) {
      const doneInRoadmap = phaseStatusMap.get(phaseName) ?? false;

      // Find phase number from name "Phase N: ..."
      const numMatch = phaseName.match(/^Phase\s+(\d+)/i);
      const phaseNum = numMatch ? numMatch[1] : "0";

      // Get plans for this phase from Phase Details section
      // Try exact match first, then fuzzy (phase number match)
      let plans = phaseDetailsMap.get(phaseName);
      if (!plans) {
        // Try matching by phase number
        for (const [detailKey, detailPlans] of phaseDetailsMap) {
          const detailNumMatch = detailKey.match(/^Phase\s+(\d+)/i);
          if (detailNumMatch && detailNumMatch[1] === phaseNum) {
            plans = detailPlans;
            break;
          }
        }
      }

      phaseEntries.push({
        name: phaseName,
        number: phaseNum,
        doneInRoadmap,
        plans: plans ?? [],
      });
    }

    milestones.push({ name: milestoneName, phases: phaseEntries });
  }

  return milestones;
}

// ---------------------------------------------------------------------------
// File-based status derivation
// ---------------------------------------------------------------------------

/**
 * Derive a plan's status from the files present in its phase directory.
 *
 * Priority (highest to lowest):
 *   DONE  — marked [x] in ROADMAP
 *   VRFY  — *-VERIFICATION.md exists
 *   EXEC  — *-SUMMARY.md exists
 *   PLAN  — *-PLAN.md exists
 *   DISC  — *-CONTEXT.md exists
 *   PEND  — no relevant files
 */
function derivePlanStatus(
  planId: string,
  doneInRoadmap: boolean,
  phaseFiles: string[]
): NodeStatus {
  if (doneInRoadmap) return "DONE";

  // Check for specific files using the plan ID prefix
  const prefix = planId; // e.g. "07-01"

  const hasVerification = phaseFiles.some(
    (f) => f.startsWith(prefix) && f.endsWith("-VERIFICATION.md")
  );
  if (hasVerification) return "VRFY";

  const hasSummary = phaseFiles.some(
    (f) => f.startsWith(prefix) && f.endsWith("-SUMMARY.md")
  );
  if (hasSummary) return "EXEC";

  const hasPlan = phaseFiles.some(
    (f) => f.startsWith(prefix) && f.endsWith("-PLAN.md")
  );
  if (hasPlan) return "PLAN";

  const hasContext = phaseFiles.some(
    (f) => f.startsWith(prefix) && f.endsWith("-CONTEXT.md")
  );
  if (hasContext) return "DISC";

  return "PEND";
}

/**
 * Derive a phase's status from its child plan statuses.
 *
 * Rules (priority order):
 *   DONE — phase marked [x] in ROADMAP, or all plans DONE
 *   VRFY — any plan VRFY (and none EXEC)
 *   EXEC — any plan EXEC
 *   PLAN — any plan PLAN
 *   DISC — any plan DISC
 *   PEND — all plans PEND or no plans
 */
function derivePhaseStatus(
  doneInRoadmap: boolean,
  planStatuses: NodeStatus[]
): NodeStatus {
  if (doneInRoadmap) return "DONE";
  if (planStatuses.length === 0) return "PEND";
  if (planStatuses.every((s) => s === "DONE")) return "DONE";
  if (planStatuses.some((s) => s === "EXEC")) return "EXEC";
  if (planStatuses.some((s) => s === "VRFY")) return "VRFY";
  if (planStatuses.some((s) => s === "PLAN")) return "PLAN";
  if (planStatuses.some((s) => s === "DISC")) return "DISC";
  return "PEND";
}

// ---------------------------------------------------------------------------
// Phase directory scanner
// ---------------------------------------------------------------------------

/**
 * Find the phase directory for a given phase number by scanning the phases/ dir.
 * Phase dirs are named like "07-gsd-watch-tab" or "07-name".
 * Returns the list of files in that directory, or [] if not found.
 */
function getPhaseFiles(planningDir: string, phaseNumber: string): string[] {
  const phasesDir = path.join(planningDir, "phases");

  try {
    const entries = fs.readdirSync(phasesDir);
    // Find the directory that starts with zero-padded phase number
    const padded = phaseNumber.padStart(2, "0");
    const match = entries.find(
      (e) =>
        e.startsWith(padded + "-") &&
        fs.statSync(path.join(phasesDir, e)).isDirectory()
    );

    if (!match) return [];

    const phaseDir = path.join(phasesDir, match);
    return fs.readdirSync(phaseDir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main export: parseGsdTree
// ---------------------------------------------------------------------------

/**
 * Parse the .planning/ directory into a typed GsdTree structure.
 *
 * @param planningDir — absolute path to the .planning/ directory
 * @returns GsdTree with milestone > phase > plan nodes, statuses, and progress counts
 */
export async function parseGsdTree(planningDir: string): Promise<GsdTree> {
  // Read ROADMAP.md
  const roadmapPath = path.join(planningDir, "ROADMAP.md");
  let roadmapContent: string;
  try {
    roadmapContent = await Bun.file(roadmapPath).text();
  } catch {
    // ROADMAP.md missing — return empty tree
    return { roots: [], completedPlans: 0, totalPlans: 0 };
  }

  const milestoneEntries = parseRoadmap(roadmapContent);

  let completedPlans = 0;
  let totalPlans = 0;

  const roots: TreeNode[] = milestoneEntries.map((milestone) => {
    const phaseNodes: TreeNode[] = milestone.phases.map((phase) => {
      // Load the phase directory files once for all plans in this phase
      const phaseFiles = getPhaseFiles(planningDir, phase.number);

      const planNodes: TreeNode[] = phase.plans.map((plan) => {
        const status = derivePlanStatus(plan.planId, plan.doneInRoadmap, phaseFiles);

        totalPlans++;
        if (status === "DONE") completedPlans++;

        return {
          kind: "plan" as NodeKind,
          name: plan.planFile,
          status,
          children: [],
          expanded: true,
        };
      });

      const planStatuses = planNodes.map((n) => n.status);
      const phaseStatus = derivePhaseStatus(phase.doneInRoadmap, planStatuses);

      return {
        kind: "phase" as NodeKind,
        name: phase.name,
        status: phaseStatus,
        children: planNodes,
        expanded: true,
      };
    });

    // Milestone status: DONE if all phases done, EXEC if any EXEC, etc.
    const phaseStatuses = phaseNodes.map((n) => n.status);
    const milestoneStatus: NodeStatus =
      phaseStatuses.length === 0
        ? "PEND"
        : phaseStatuses.every((s) => s === "DONE")
        ? "DONE"
        : phaseStatuses.some((s) => s === "EXEC")
        ? "EXEC"
        : phaseStatuses.some((s) => s === "VRFY")
        ? "VRFY"
        : phaseStatuses.some((s) => s === "PLAN")
        ? "PLAN"
        : phaseStatuses.some((s) => s === "DISC")
        ? "DISC"
        : "PEND";

    return {
      kind: "milestone" as NodeKind,
      name: milestone.name,
      status: milestoneStatus,
      children: phaseNodes,
      expanded: true,
    };
  });

  return { roots, completedPlans, totalPlans };
}

// ---------------------------------------------------------------------------
// Watcher: watchPlanning
// ---------------------------------------------------------------------------

/**
 * Watch the .planning/ directory for file changes and call onChange (debounced).
 *
 * @param planningDir — absolute path to the .planning/ directory
 * @param onChange — callback called when any .planning/ file changes
 * @returns cleanup function that stops the watcher
 */
export function watchPlanning(
  planningDir: string,
  onChange: () => void
): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const debouncedOnChange = () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onChange();
    }, 100);
  };

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(planningDir, { recursive: true }, () => {
      debouncedOnChange();
    });
  } catch {
    // If the directory doesn't exist or watch fails, return no-op cleanup
    return () => {};
  }

  return () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    watcher?.close();
  };
}
