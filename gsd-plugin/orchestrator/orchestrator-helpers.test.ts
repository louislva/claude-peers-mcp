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

// A long-running dummy process whose PID we can use for "other" peer registrations.
// The broker checks PID liveness via process.kill(pid, 0); we need a real, signalable PID.
let dummyProc: ReturnType<typeof Bun.spawn>;
let dummyPid: number;

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

  // Spawn a long-running dummy process for use as a second "alive" PID in tests.
  // The broker's peer-availability liveness check requires process.kill(pid, 0) to succeed.
  dummyProc = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
  dummyPid = dummyProc.pid;
});

afterAll(() => {
  brokerProc?.kill();
  dummyProc?.kill();
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
// PLAN 02 TESTS: discoverPeers, shouldDelegate, dispatchWave, etc.
// ============================================================

// Helper: register a peer via broker and return its ID.
// Uses the actual test process PID so the broker's PID-liveness check passes.
// IMPORTANT: The broker removes any existing registration for the same PID on re-register.
// Use distinct pids for peers that need to coexist: process.pid, 1 (init), 2, etc.
async function registerPeer(summary: string, idHint: string, pid: number = process.pid): Promise<string> {
  const res = await fetch(`${BROKER_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pid,
      cwd: "/tmp/test",
      git_root: null,
      tty: null,
      summary,
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function unregisterPeer(id: string): Promise<void> {
  await fetch(`${BROKER_URL}/unregister`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

describe("discoverPeers", () => {
  test("returns empty executors and null proxy when no peers registered", async () => {
    const selfId = "test-orch-discover-self-empty-" + Date.now();
    const result = await helpers.discoverPeers(selfId, "/no/such/repo");
    expect(result.proxy).toBeNull();
    expect(result.executors).toHaveLength(0);
  });

  test("classifies peer as proxy when summary contains 'Decision proxy' (case-insensitive)", async () => {
    // Use dummyPid for proxy and process.pid for executor
    // so both coexist — broker removes existing registration for the same PID
    const proxyPeerId = await registerPeer(
      "Decision proxy -- answering discuss-phase choices for autonomous runs",
      "proxy-classifier",
      dummyPid
    );
    const executorPeerId = await registerPeer("Executing phase 2 plan 1", "executor-classifier");
    const selfId = "test-orch-discover-classify-" + Date.now();

    try {
      const result = await helpers.discoverPeers(selfId, "/no/such/repo");
      expect(result.proxy).not.toBeNull();
      expect(result.proxy?.id).toBe(proxyPeerId);
      expect(result.executors.some((e) => e.id === executorPeerId)).toBe(true);
    } finally {
      await unregisterPeer(proxyPeerId);
      await unregisterPeer(executorPeerId);
    }
  });

  test("excludes self (myId) from returned peers", async () => {
    const selfId = await registerPeer("Orchestrator self-exclude test", "self-exclude");
    try {
      const result = await helpers.discoverPeers(selfId, "/no/such/repo");
      const allIds = [
        ...(result.proxy ? [result.proxy.id] : []),
        ...result.executors.map((e) => e.id),
      ];
      expect(allIds).not.toContain(selfId);
    } finally {
      await unregisterPeer(selfId);
    }
  });

  test("returns zero executors triggers sequential fallback consideration (ORCH-12)", async () => {
    // No peers registered — discoverPeers should return empty results
    // This is the condition that triggers sequential fallback in the orchestrator agent
    const selfId = "test-orch-fallback-trigger-" + Date.now();
    const result = await helpers.discoverPeers(selfId, "/no/such/repo");
    expect(result.executors.length).toBe(0);
    expect(result.proxy).toBeNull();
  });
});

describe("sendDiscussChoice/waitForAnswer re-export", () => {
  test("re-exports sendDiscussChoice from proxy-helpers (ORCH-06)", () => {
    expect(typeof helpers.sendDiscussChoice).toBe("function");
  });

  test("re-exports waitForAnswer from proxy-helpers (ORCH-06)", () => {
    expect(typeof helpers.waitForAnswer).toBe("function");
  });
});

describe("dispatch sequencing (ORCH-05)", () => {
  test("dispatchWave assigns executors to pending tasks and returns waveId > 0", async () => {
    // Register an executor peer AND an orchestrator peer in the broker.
    // Use dummyPid for executor and process.pid for orchestrator so both coexist.
    // (broker FK constraint: both from_id and to_id must exist in peers table)
    const executorId = await registerPeer("Executing phase tasks", "dispatch-executor", dummyPid);
    const orchestratorId = await registerPeer("Orchestrating wave dispatch", "dispatch-orchestrator");

    const phase: import("./orchestrator-helpers.ts").PhaseNode = {
      number: 99,
      name: "Test Phase",
      dir: "99-test-phase",
      dependencies: [],
      status: "pending",
      filesModified: ["src/test.ts"],
    };

    const executor = {
      id: executorId,
      pid: dummyPid,
      cwd: "/tmp",
      git_root: null,
      summary: "Executing phase tasks",
      idle_since: new Date().toISOString(),
    };

    try {
      const result = await helpers.dispatchWave(
        orchestratorId,
        "/tmp/test-repo",
        1,
        [phase],
        [executor]
      );

      expect(result.waveId).toBeGreaterThan(0);
      expect(result.assignments.size).toBe(1);
      expect(result.localPhases).toHaveLength(0);
    } finally {
      await unregisterPeer(executorId);
      await unregisterPeer(orchestratorId);
    }
  });

  test("dispatchWave returns local phases when no executors available", async () => {
    const phase: import("./orchestrator-helpers.ts").PhaseNode = {
      number: 98,
      name: "Local Phase",
      dir: "98-local-phase",
      dependencies: [],
      status: "pending",
      filesModified: ["src/local.ts"],
    };

    // wave-create doesn't need an orchestrator in peers table, just runs
    const orchestratorId = "test-orch-local-" + Date.now();

    const result = await helpers.dispatchWave(
      orchestratorId,
      "/tmp/test-repo-local",
      2,
      [phase],
      [] // no executors
    );

    expect(result.waveId).toBeGreaterThan(0);
    expect(result.assignments.size).toBe(0);
    expect(result.localPhases).toHaveLength(1);
    expect(result.localPhases[0].number).toBe(98);
  });
});

describe("shouldDelegate", () => {
  const makePhase = (files: string[]): import("./orchestrator-helpers.ts").PhaseNode => ({
    number: 1,
    name: "Test Phase",
    dir: "01-test",
    dependencies: [],
    status: "pending",
    filesModified: files,
  });

  test("returns false with no executors available", () => {
    const phase = makePhase(["a.ts", "b.ts", "c.ts"]);
    expect(helpers.shouldDelegate(phase, 0, [], false)).toBe(false);
  });

  test("returns false for small phase (fewer than 3 files)", () => {
    const phase = makePhase(["a.ts", "b.ts"]); // only 2 files
    expect(helpers.shouldDelegate(phase, 2, [], false)).toBe(false);
  });

  test("returns false with file conflict against running tasks", () => {
    const phase = makePhase(["src/shared.ts", "src/a.ts", "src/b.ts"]);
    expect(helpers.shouldDelegate(phase, 1, ["src/shared.ts"], false)).toBe(false);
  });

  test("returns false with human checkpoint", () => {
    const phase = makePhase(["a.ts", "b.ts", "c.ts"]);
    expect(helpers.shouldDelegate(phase, 1, [], true)).toBe(false);
  });

  test("returns true for a delegatable phase (3+ files, executor available, no conflicts, no checkpoint)", () => {
    const phase = makePhase(["a.ts", "b.ts", "c.ts"]);
    expect(helpers.shouldDelegate(phase, 1, [], false)).toBe(true);
  });
});

describe("handleExecutorDeath (ORCH-09)", () => {
  test("returns hasPartialWork and lastCommit fields with correct types", async () => {
    // Call with current project's git root — should return real git log info
    const gitRoot = "/home/joshuaduffill/dev/claude-peers-mcp";
    const result = await helpers.handleExecutorDeath(1, gitRoot);

    // Just verify the shape — actual values depend on git history
    expect(typeof result.hasPartialWork).toBe("boolean");
    expect(result.lastCommit === null || typeof result.lastCommit === "string").toBe(true);
  });
});

describe("postWaveSync (ORCH-10)", () => {
  test("returns roadmapContent string and peers with proxy/executors shape", async () => {
    const gitRoot = "/home/joshuaduffill/dev/claude-peers-mcp";
    const selfId = "test-orch-postwavesync-" + Date.now();

    const result = await helpers.postWaveSync(selfId, gitRoot);

    expect(typeof result.roadmapContent).toBe("string");
    expect(result.roadmapContent.length).toBeGreaterThan(0);
    expect(result.peers).toBeDefined();
    expect(result.peers.proxy === null || typeof result.peers.proxy === "object").toBe(true);
    expect(Array.isArray(result.peers.executors)).toBe(true);
  });
});
