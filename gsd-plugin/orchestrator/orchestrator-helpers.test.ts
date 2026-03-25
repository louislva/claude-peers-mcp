/**
 * orchestrator-helpers.test.ts
 *
 * Test scaffold for orchestrator-helpers.ts.
 *
 * Strategy:
 * - Set CLAUDE_PEERS_PORT=17903 before dynamic import so the module targets our isolated broker.
 * - Plan 01 functions (parseRoadmapPhases, buildExecutionWaves, checkWaveConflicts) have full
 *   real test cases that must pass.
 * - Plan 02 functions (discoverPeers, shouldDelegate, dispatchWave, etc.) use test.todo stubs.
 *
 * The isolated broker uses port 17903 (unique port to avoid conflicts with executor-helpers.test.ts
 * on 17901 and proxy-helpers.test.ts on 17902).
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";

// IMPORTANT: Set port override BEFORE dynamic import so BROKER_URL constant is set correctly.
const TEST_PORT = "17903";
process.env.CLAUDE_PEERS_PORT = TEST_PORT;
const BROKER_URL = `http://127.0.0.1:${TEST_PORT}`;

let helpers: typeof import("./orchestrator-helpers.ts");
let brokerProc: ReturnType<typeof Bun.spawn>;
const dbPath = `/tmp/claude-peers-orch-helpers-test-${Date.now()}.db`;

beforeAll(async () => {
  // Start isolated test broker
  brokerProc = Bun.spawn(["bun", "/home/joshuaduffill/dev/claude-peers-mcp/broker.ts"], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: TEST_PORT,
      CLAUDE_PEERS_DB: dbPath,
    },
    stdout: "ignore",
    stderr: "pipe",
  });

  // Wait for broker to be ready
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
    if (i === 29) throw new Error("Test broker failed to start on port " + TEST_PORT);
  }

  // Dynamic import AFTER setting env var so BROKER_URL constant picks up TEST_PORT
  helpers = await import("./orchestrator-helpers.ts");
});

afterAll(() => {
  brokerProc?.kill();
  try {
    const { unlinkSync } = require("fs");
    unlinkSync(dbPath);
  } catch {}
  delete process.env.CLAUDE_PEERS_PORT;
});

// ============================================================
// TEST GROUP 1: parseRoadmapPhases (ORCH-03)
// Pure function — no broker needed.
// ============================================================

describe("parseRoadmapPhases", () => {
  test("parses phases from real ROADMAP.md format", () => {
    const roadmap = `
## Phase Details

### Phase 1: Foundation
**Goal**: All downstream components share settled type contracts
**Depends on**: Nothing (first phase)
**Plans:** 2/2 plans complete

### Phase 2: Executor Protocol
**Goal**: Executor agent contract is fully specified
**Depends on**: Phase 1
**Plans:** 3/3 plans complete

### Phase 3: Decision Proxy
**Goal**: Decision proxy peer role is fully specified
**Depends on**: Phase 1
**Plans:** 2/2 plans complete
`;

    const phases = helpers.parseRoadmapPhases(roadmap);

    expect(phases.length).toBe(3);

    const phase1 = phases.find((p) => p.number === 1);
    expect(phase1).toBeDefined();
    // Name comes from **Goal** field when present; header title is fallback
    expect(phase1!.name).toBeTruthy();
    expect(phase1!.dependencies).toEqual([]);

    const phase2 = phases.find((p) => p.number === 2);
    expect(phase2).toBeDefined();
    expect(phase2!.dependencies).toContain(1);

    const phase3 = phases.find((p) => p.number === 3);
    expect(phase3).toBeDefined();
    expect(phase3!.dependencies).toContain(1);
  });

  test("marks phases with [x] checkbox as completed", () => {
    const roadmap = `
## Phases

- [x] **Phase 1: Foundation** - Completed phase
- [ ] **Phase 2: Executor Protocol** - Pending phase

## Phase Details

### Phase 1: Foundation
**Goal**: Foundation goal
**Depends on**: Nothing

### Phase 2: Executor Protocol
**Goal**: Executor goal
**Depends on**: Phase 1
`;

    const phases = helpers.parseRoadmapPhases(roadmap);
    const phase1 = phases.find((p) => p.number === 1);
    const phase2 = phases.find((p) => p.number === 2);

    expect(phase1?.status).toBe("completed");
    expect(phase2?.status).toBe("pending");
  });

  test("handles phase with no dependencies (standalone phase)", () => {
    const roadmap = `
### Phase 5: Standalone Phase
**Goal**: A completely independent phase
**Depends on**: Nothing
`;

    const phases = helpers.parseRoadmapPhases(roadmap);
    expect(phases.length).toBe(1);
    expect(phases[0].number).toBe(5);
    expect(phases[0].dependencies).toEqual([]);
    expect(phases[0].status).toBe("pending");
  });
});

// ============================================================
// TEST GROUP 2: buildExecutionWaves (ORCH-04)
// Pure function — no broker needed.
// ============================================================

describe("buildExecutionWaves", () => {
  const makePhase = (
    number: number,
    deps: number[] = [],
    status: "pending" | "completed" = "pending"
  ): import("./orchestrator-helpers.ts").PhaseNode => ({
    number,
    name: `Phase ${number}`,
    dir: String(number).padStart(2, "0"),
    dependencies: deps,
    status,
    filesModified: [],
  });

  test("independent phases all end up in wave 1", () => {
    const phases = [makePhase(1), makePhase(2), makePhase(3)];
    const waves = helpers.buildExecutionWaves(phases);
    expect(waves.length).toBe(1);
    expect(waves[0].length).toBe(3);
    const nums = waves[0].map((p) => p.number).sort();
    expect(nums).toEqual([1, 2, 3]);
  });

  test("chained dependencies produce sequential waves", () => {
    // 1 -> 2 -> 3
    const phases = [makePhase(1), makePhase(2, [1]), makePhase(3, [2])];
    const waves = helpers.buildExecutionWaves(phases);
    expect(waves.length).toBe(3);
    expect(waves[0].map((p) => p.number)).toEqual([1]);
    expect(waves[1].map((p) => p.number)).toEqual([2]);
    expect(waves[2].map((p) => p.number)).toEqual([3]);
  });

  test("parallel dependencies grouped correctly", () => {
    // Phases 1 and 2 are independent; Phase 3 depends on both
    const phases = [makePhase(1), makePhase(2), makePhase(3, [1, 2])];
    const waves = helpers.buildExecutionWaves(phases);
    expect(waves.length).toBe(2);
    // Wave 1: phases 1 and 2 (in any order)
    expect(waves[0].map((p) => p.number).sort()).toEqual([1, 2]);
    // Wave 2: phase 3
    expect(waves[1].map((p) => p.number)).toEqual([3]);
  });

  test("throws on dependency cycles with descriptive error", () => {
    // Phase 1 depends on 2, Phase 2 depends on 1 — cycle
    const phases = [makePhase(1, [2]), makePhase(2, [1])];
    expect(() => helpers.buildExecutionWaves(phases)).toThrow(/cycle/i);
  });

  test("completed phases are filtered out and not scheduled", () => {
    // Phase 1 is completed; Phase 2 depends on Phase 1 (already satisfied)
    const phases = [makePhase(1, [], "completed"), makePhase(2, [1])];
    const waves = helpers.buildExecutionWaves(phases);
    // Only phase 2 should be scheduled; phase 1 is done
    expect(waves.length).toBe(1);
    expect(waves[0].map((p) => p.number)).toEqual([2]);
  });
});

// ============================================================
// TEST GROUP 3: checkWaveConflicts (ORCH-13)
// Pure planning-time function — no broker needed.
// ============================================================

describe("checkWaveConflicts", () => {
  const makePhase = (
    number: number,
    files: string[]
  ): import("./orchestrator-helpers.ts").PhaseNode => ({
    number,
    name: `Phase ${number}`,
    dir: String(number).padStart(2, "0"),
    dependencies: [],
    status: "pending",
    filesModified: files,
  });

  test("no conflicts returns single sub-wave with all phases", async () => {
    const phases = [
      makePhase(1, ["src/a.ts", "src/b.ts"]),
      makePhase(2, ["src/c.ts", "src/d.ts"]),
    ];
    const subWaves = await helpers.checkWaveConflicts(phases, "/repo");
    expect(subWaves.length).toBe(1);
    expect(subWaves[0].length).toBe(2);
  });

  test("two-way conflict splits into two sub-waves", async () => {
    const phases = [
      makePhase(1, ["src/shared.ts", "src/a.ts"]),
      makePhase(2, ["src/shared.ts", "src/b.ts"]), // conflicts on shared.ts
    ];
    const subWaves = await helpers.checkWaveConflicts(phases, "/repo");
    // Phases must be split — each sub-wave should have one phase
    expect(subWaves.length).toBe(2);
    expect(subWaves[0].length).toBe(1);
    expect(subWaves[1].length).toBe(1);
    // Each phase appears exactly once
    const allPhaseNums = subWaves.flatMap((sw) => sw.map((p) => p.number)).sort();
    expect(allPhaseNums).toEqual([1, 2]);
  });

  test("three-way conflict produces at least two sub-waves", async () => {
    // All three phases conflict with each other (all touch shared.ts)
    const phases = [
      makePhase(1, ["shared.ts", "a.ts"]),
      makePhase(2, ["shared.ts", "b.ts"]),
      makePhase(3, ["shared.ts", "c.ts"]),
    ];
    const subWaves = await helpers.checkWaveConflicts(phases, "/repo");
    // Must produce 3 sub-waves since all conflict with each other
    expect(subWaves.length).toBe(3);
    // Each phase must appear exactly once
    const allPhaseNums = subWaves.flatMap((sw) => sw.map((p) => p.number)).sort();
    expect(allPhaseNums).toEqual([1, 2, 3]);
    // Each sub-wave must have exactly one phase
    for (const sw of subWaves) {
      expect(sw.length).toBe(1);
    }
  });
});

// ============================================================
// PLAN 02 STUBS: discoverPeers, shouldDelegate, dispatchWave, etc.
// These use test.todo to track pending tests without failing.
// ============================================================

describe("discoverPeers", () => {
  test.todo("returns empty executors and null proxy when no peers registered");
  test.todo("classifies peer as proxy when summary contains 'decision proxy' (case-insensitive)");
  test.todo("excludes self (myId) from returned peers");
  test.todo("deduplicates peers that appear in both repo_peers and machine_peers");
  test.todo("returns zero executors triggers sequential fallback consideration");
});

describe("shouldDelegate", () => {
  test.todo("returns false with no executors available");
  test.todo("returns false for phase with human-action checkpoint type");
  test.todo("returns false when phase has fewer than 3 tasks");
  test.todo("returns true when executor available and phase has 3+ tasks");
  test.todo("returns false when conflict-check detects file overlap with in-flight tasks");
});

describe("dispatchWave", () => {
  test.todo("creates wave via /wave-create before sending execute_phase messages");
  test.todo("sends execute_phase message to each assigned executor");
  test.todo("dispatches multiple executors in parallel (sends all before awaiting)");
  test.todo("executes locally when shouldDelegate returns false");
  test.todo("assigns task IDs from wave-create response to execute_phase payloads");
});

describe("sendDiscussChoice/waitForAnswer re-export", () => {
  test.todo("re-exports sendDiscussChoice as a callable function");
  test.todo("re-exports waitForAnswer as a callable function");
});

describe("dispatch sequencing", () => {
  test.todo("dispatchWave sends messages to executors before starting local execution");
  test.todo("orchestrator does not start next wave until all phase_complete messages received");
});

describe("handleExecutorDeath", () => {
  test.todo("detects partial work from git log since task started_at");
  test.todo("reassigns task when partial work found and executor is gone");
  test.todo("marks task complete when git log shows all plan tasks committed");
  test.todo("calls /task-blocked with reason 'unknown' on unrecoverable death");
});

describe("postWaveSync", () => {
  test.todo("runs git pull after all tasks in wave complete");
  test.todo("re-reads ROADMAP.md after git pull to pick up any dynamic phases");
  test.todo("refreshes peer list after wave completion");
  test.todo("advances to next wave after successful sync");
});
