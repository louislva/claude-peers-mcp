/**
 * tui/tabs/gsd-watch-parser.test.ts — Unit tests for the GSD Watch tree parser
 *
 * Tests parseGsdTree() with mock .planning/ directory structures.
 * Uses bun:test and temp directories created with fs and Bun.write().
 */

import { test, expect, afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseGsdTree,
  type GsdTree,
  type TreeNode,
  type NodeStatus,
} from "./gsd-watch-parser.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-watch-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Create a minimal mock .planning/ directory with a given ROADMAP.md
 * and optional phase files.
 */
function createPlanningDir(
  roadmapContent: string,
  phases: Record<
    string,
    string[] // array of filenames in this phase dir
  > = {}
): string {
  const planningDir = tmpDir;

  // Write ROADMAP.md
  fs.writeFileSync(path.join(planningDir, "ROADMAP.md"), roadmapContent, "utf8");

  // Create phases/ subdirectory
  const phasesDir = path.join(planningDir, "phases");
  fs.mkdirSync(phasesDir, { recursive: true });

  // Create each phase directory and its files
  for (const [phaseDirName, files] of Object.entries(phases)) {
    const phaseDir = path.join(phasesDir, phaseDirName);
    fs.mkdirSync(phaseDir, { recursive: true });
    for (const fileName of files) {
      fs.writeFileSync(path.join(phaseDir, fileName), "", "utf8");
    }
  }

  return planningDir;
}

// ---------------------------------------------------------------------------
// Sample ROADMAP content
// ---------------------------------------------------------------------------

const SAMPLE_ROADMAP = `# Roadmap: my-project

## Milestones

- ✅ **v1.0 First Release** — Phases 1-2 (shipped 2026-01-01) — [archive](milestones/v1.0-ROADMAP.md)
- 🔄 **v1.1 Second Release** — Phases 3-4 (in progress)

## Phases

<details>
<summary>✅ v1.0 First Release (Phases 1-2) — SHIPPED 2026-01-01</summary>

- [x] Phase 1: Foundation (2/2 plans) — completed 2026-01-01
- [x] Phase 2: Core Features (3/3 plans) — completed 2026-01-01

</details>

### v1.1 Second Release

- [x] **Phase 3: Alpha** - First alpha phase (completed 2026-02-01)
- [ ] **Phase 4: Beta** - Second beta phase

## Phase Details

### Phase 3: Alpha
**Goal**: Alpha goal
Plans:
- [x] 03-01-PLAN.md — Plan one description
- [x] 03-02-PLAN.md — Plan two description

### Phase 4: Beta
**Goal**: Beta goal
Plans:
- [x] 04-01-PLAN.md — Beta plan one (done)
- [ ] 04-02-PLAN.md — Beta plan two
- [ ] 04-03-PLAN.md — Beta plan three
`;

// ---------------------------------------------------------------------------
// Test 1: parseGsdTree returns correct milestone nodes
// ---------------------------------------------------------------------------

test("parseGsdTree returns milestone nodes from ROADMAP.md", async () => {
  const planningDir = createPlanningDir(SAMPLE_ROADMAP, {
    "03-alpha": ["03-01-SUMMARY.md", "03-02-SUMMARY.md"],
    "04-beta": ["04-01-SUMMARY.md"],
  });

  const tree = await parseGsdTree(planningDir);

  expect(tree).toBeDefined();
  expect(tree.roots).toBeArray();
  // At least one milestone should be present
  expect(tree.roots.length).toBeGreaterThan(0);
  // Milestones should have kind = "milestone"
  for (const root of tree.roots) {
    expect(root.kind).toBe("milestone");
  }
});

// ---------------------------------------------------------------------------
// Test 2: Phase nodes have correct names and status from [x] markers and files
// ---------------------------------------------------------------------------

test("phase nodes have correct names and statuses", async () => {
  const planningDir = createPlanningDir(SAMPLE_ROADMAP, {
    "03-alpha": ["03-01-SUMMARY.md", "03-02-SUMMARY.md"],
    "04-beta": ["04-01-PLAN.md"],
  });

  const tree = await parseGsdTree(planningDir);

  // Find phase nodes across all milestone children
  const allNodes: TreeNode[] = [];
  function collect(node: TreeNode) {
    allNodes.push(node);
    for (const child of node.children) collect(child);
  }
  for (const root of tree.roots) collect(root);

  const phases = allNodes.filter((n) => n.kind === "phase");
  expect(phases.length).toBeGreaterThan(0);

  // Phase 3 is marked [x] in ROADMAP, should be DONE
  const phase3 = phases.find((p) => p.name.includes("3") || p.name.toLowerCase().includes("alpha"));
  expect(phase3).toBeDefined();
  if (phase3) {
    expect(phase3.status).toBe("DONE");
  }

  // Phase 4 is not marked [x] (has some files), status should not be DONE
  const phase4 = phases.find((p) => p.name.includes("4") || p.name.toLowerCase().includes("beta"));
  expect(phase4).toBeDefined();
  if (phase4) {
    expect(phase4.status).not.toBe("DONE");
  }
});

// ---------------------------------------------------------------------------
// Test 3: Plan node statuses derived correctly from file presence
// ---------------------------------------------------------------------------

test("plan status derived correctly from file presence", async () => {
  // For phase 4: 04-01 has SUMMARY, 04-02 has PLAN, 04-03 has CONTEXT, 04-04 has nothing
  const roadmap = `# Roadmap

### v1.1 Release

- [ ] **Phase 4: Test Phase** - Test

## Phase Details

### Phase 4: Test Phase
**Goal**: Testing status derivation
Plans:
- [x] 04-01-PLAN.md — Summary plan (done in roadmap)
- [ ] 04-02-PLAN.md — Summary plan (EXEC from summary file)
- [ ] 04-03-PLAN.md — Plan only (PLAN status)
- [ ] 04-04-PLAN.md — Context only (DISC status)
- [ ] 04-05-PLAN.md — Nothing (PEND status)
`;

  const planningDir = createPlanningDir(roadmap, {
    "04-test-phase": [
      // 04-01: [x] in ROADMAP -> DONE (no file needed)
      "04-02-SUMMARY.md", // -> EXEC
      "04-03-PLAN.md",    // -> PLAN
      "04-04-CONTEXT.md", // -> DISC
      // 04-05: nothing -> PEND
    ],
  });

  const tree = await parseGsdTree(planningDir);

  const allNodes: TreeNode[] = [];
  function collect(node: TreeNode) {
    allNodes.push(node);
    for (const child of node.children) collect(child);
  }
  for (const root of tree.roots) collect(root);

  const plans = allNodes.filter((n) => n.kind === "plan");
  expect(plans.length).toBeGreaterThan(0);

  // Find plans by their names (should reference plan numbers)
  const plan01 = plans.find((p) => p.name.includes("04-01"));
  const plan02 = plans.find((p) => p.name.includes("04-02"));
  const plan03 = plans.find((p) => p.name.includes("04-03"));
  const plan04 = plans.find((p) => p.name.includes("04-04"));
  const plan05 = plans.find((p) => p.name.includes("04-05"));

  expect(plan01).toBeDefined();
  expect(plan01?.status).toBe("DONE");

  expect(plan02).toBeDefined();
  expect(plan02?.status).toBe("EXEC");

  expect(plan03).toBeDefined();
  expect(plan03?.status).toBe("PLAN");

  expect(plan04).toBeDefined();
  expect(plan04?.status).toBe("DISC");

  expect(plan05).toBeDefined();
  expect(plan05?.status).toBe("PEND");
});

// ---------------------------------------------------------------------------
// Test 4: Progress calculation returns correct completedPlans / totalPlans
// ---------------------------------------------------------------------------

test("progress calculation is accurate", async () => {
  const roadmap = `# Roadmap

### v1.1 Release

- [ ] **Phase 5: Progress Phase** - Progress test

## Phase Details

### Phase 5: Progress Phase
**Goal**: Testing progress
Plans:
- [x] 05-01-PLAN.md — Done plan
- [x] 05-02-PLAN.md — Done plan 2
- [ ] 05-03-PLAN.md — Pending plan
- [ ] 05-04-PLAN.md — Pending plan 2
`;

  const planningDir = createPlanningDir(roadmap, {
    "05-progress-phase": [],
  });

  const tree = await parseGsdTree(planningDir);

  expect(tree.totalPlans).toBe(4);
  expect(tree.completedPlans).toBe(2);
});

// ---------------------------------------------------------------------------
// Test 5: Phase status derivation rules
// ---------------------------------------------------------------------------

test("phase status derived from child plan statuses", async () => {
  const roadmap = `# Roadmap

### v1.1 Release

- [ ] **Phase 6: Derivation Phase** - Derivation test

## Phase Details

### Phase 6: Derivation Phase
**Goal**: Testing phase status derivation
Plans:
- [ ] 06-01-PLAN.md — Exec plan
- [ ] 06-02-PLAN.md — Plan plan
- [ ] 06-03-PLAN.md — Pend plan
`;

  const planningDir = createPlanningDir(roadmap, {
    "06-derivation-phase": [
      "06-01-SUMMARY.md", // -> EXEC
      "06-02-PLAN.md",    // -> PLAN
      // 06-03: nothing -> PEND
    ],
  });

  const tree = await parseGsdTree(planningDir);

  const allNodes: TreeNode[] = [];
  function collect(node: TreeNode) {
    allNodes.push(node);
    for (const child of node.children) collect(child);
  }
  for (const root of tree.roots) collect(root);

  const phase6 = allNodes.find((n) => n.kind === "phase" && (n.name.includes("6") || n.name.toLowerCase().includes("derivation")));
  expect(phase6).toBeDefined();
  // Phase has at least one EXEC child -> phase should be EXEC
  expect(phase6?.status).toBe("EXEC");
});

// ---------------------------------------------------------------------------
// Test 6: Missing ROADMAP.md returns empty tree
// ---------------------------------------------------------------------------

test("missing ROADMAP.md returns empty tree", async () => {
  // Create planning dir with no ROADMAP.md
  const planningDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-watch-empty-"));
  try {
    fs.mkdirSync(path.join(planningDir, "phases"), { recursive: true });
    const tree = await parseGsdTree(planningDir);
    expect(tree.roots).toBeArray();
    expect(tree.roots.length).toBe(0);
    expect(tree.completedPlans).toBe(0);
    expect(tree.totalPlans).toBe(0);
  } finally {
    fs.rmSync(planningDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 7: Empty phase directory handled gracefully
// ---------------------------------------------------------------------------

test("empty phase directory handled gracefully", async () => {
  const roadmap = `# Roadmap

### v1.1 Release

- [ ] **Phase 7: Empty Phase** - Empty

## Phase Details

### Phase 7: Empty Phase
**Goal**: Empty phase
Plans:
- [ ] 07-01-PLAN.md — Empty plan
`;

  // Create phases dir but leave phase subdir absent
  const planningDir = createPlanningDir(roadmap, {
    // "07-empty-phase": [] — intentionally omitted to test missing dir
  });

  const tree = await parseGsdTree(planningDir);

  // Should not throw, should return tree with PEND plans
  expect(tree).toBeDefined();
  expect(tree.roots.length).toBeGreaterThan(0);

  const allNodes: TreeNode[] = [];
  function collect(node: TreeNode) {
    allNodes.push(node);
    for (const child of node.children) collect(child);
  }
  for (const root of tree.roots) collect(root);

  const plan01 = allNodes.find((n) => n.kind === "plan" && n.name.includes("07-01"));
  expect(plan01).toBeDefined();
  expect(plan01?.status).toBe("PEND");
});

// ---------------------------------------------------------------------------
// Test 8: VRFY status from VERIFICATION.md file
// ---------------------------------------------------------------------------

test("VRFY status detected from VERIFICATION.md file", async () => {
  const roadmap = `# Roadmap

### v1.1 Release

- [ ] **Phase 8: Verify Phase** - Verify test

## Phase Details

### Phase 8: Verify Phase
**Goal**: Testing VRFY status
Plans:
- [ ] 08-01-PLAN.md — Verified plan
`;

  const planningDir = createPlanningDir(roadmap, {
    "08-verify-phase": [
      "08-01-VERIFICATION.md", // -> VRFY
    ],
  });

  const tree = await parseGsdTree(planningDir);

  const allNodes: TreeNode[] = [];
  function collect(node: TreeNode) {
    allNodes.push(node);
    for (const child of node.children) collect(child);
  }
  for (const root of tree.roots) collect(root);

  const plan01 = allNodes.find((n) => n.kind === "plan" && n.name.includes("08-01"));
  expect(plan01).toBeDefined();
  expect(plan01?.status).toBe("VRFY");
});

// ---------------------------------------------------------------------------
// Test 9: TreeNode defaults
// ---------------------------------------------------------------------------

test("TreeNode has correct default expanded state", async () => {
  const planningDir = createPlanningDir(SAMPLE_ROADMAP, {
    "03-alpha": [],
    "04-beta": [],
  });

  const tree = await parseGsdTree(planningDir);

  // Milestones should be expanded by default
  for (const root of tree.roots) {
    expect(root.expanded).toBe(true);
    // Phases within milestones should be expanded
    for (const phase of root.children) {
      expect(phase.expanded).toBe(true);
    }
  }
});
