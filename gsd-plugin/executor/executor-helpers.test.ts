/**
 * executor-helpers.test.ts
 *
 * Comprehensive tests for all executor protocol helper functions.
 *
 * Strategy:
 * - executor-helpers.ts uses CLAUDE_PEERS_PORT env var at module load time,
 *   defaulting to 7899. We set CLAUDE_PEERS_PORT=17901 before importing so
 *   the helpers target our isolated test broker.
 * - We achieve this by setting the env var and spawning a dedicated test broker
 *   on port 17901 with an isolated DB.
 * - Pure function tests (shouldSkipWrite, readPlanFile) need no broker.
 *
 * Requirements covered: EXEC-01 through EXEC-09
 */

// IMPORTANT: Set port override BEFORE any imports so executor-helpers.ts picks it up.
// In Bun, top-level code runs before module initialization of static imports,
// so we use dynamic imports below for the helpers module.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "fs";

const TEST_BROKER_PORT = 17901;
const BROKER_URL = `http://127.0.0.1:${TEST_BROKER_PORT}`;
let brokerProc: ReturnType<typeof Bun.spawn>;
const dbPath = `/tmp/claude-peers-helpers-test-${Date.now()}.db`;

// Dynamic imports populated in beforeAll
let sendAck: Awaited<ReturnType<typeof import("./executor-helpers.ts")>>["sendAck"];
let gitPullRebase: Awaited<ReturnType<typeof import("./executor-helpers.ts")>>["gitPullRebase"];
let readPlanFile: Awaited<ReturnType<typeof import("./executor-helpers.ts")>>["readPlanFile"];
let checkConflicts: Awaited<ReturnType<typeof import("./executor-helpers.ts")>>["checkConflicts"];
let sendProgress: Awaited<ReturnType<typeof import("./executor-helpers.ts")>>["sendProgress"];
let sendPhaseComplete: Awaited<ReturnType<typeof import("./executor-helpers.ts")>>["sendPhaseComplete"];
let sendPhaseBlocked: Awaited<ReturnType<typeof import("./executor-helpers.ts")>>["sendPhaseBlocked"];
let sendStatusResponse: Awaited<ReturnType<typeof import("./executor-helpers.ts")>>["sendStatusResponse"];
let handleReclaim: Awaited<ReturnType<typeof import("./executor-helpers.ts")>>["handleReclaim"];
let gitPushWithJitter: Awaited<ReturnType<typeof import("./executor-helpers.ts")>>["gitPushWithJitter"];
let shouldSkipWrite: Awaited<ReturnType<typeof import("./executor-helpers.ts")>>["shouldSkipWrite"];
let callTaskStart: Awaited<ReturnType<typeof import("./executor-helpers.ts")>>["callTaskStart"];
let callTaskComplete: Awaited<ReturnType<typeof import("./executor-helpers.ts")>>["callTaskComplete"];
let callTaskBlocked: Awaited<ReturnType<typeof import("./executor-helpers.ts")>>["callTaskBlocked"];

import type {
  PhaseProgressPayload,
  PhaseCompletePayload,
  PhaseBlockedPayload,
  StatusResponsePayload,
} from "../../shared/types.ts";

// Test peer IDs
let executorId: string;
let orchestratorId: string;

async function brokerPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

// Helper to drain (ACK) all undelivered messages for a peer
async function drainMessages(peerId: string): Promise<void> {
  const result = await brokerPost<{ messages: { id: number }[] }>("/poll-messages", { id: peerId });
  if (result.messages.length > 0) {
    await brokerPost("/ack-message", { message_ids: result.messages.map((m) => m.id) });
  }
}

beforeAll(async () => {
  // Override CLAUDE_PEERS_PORT so executor-helpers module targets our test broker
  process.env.CLAUDE_PEERS_PORT = String(TEST_BROKER_PORT);

  // Start isolated test broker on TEST_BROKER_PORT
  brokerProc = Bun.spawn(["bun", "/home/joshuaduffill/dev/claude-peers-mcp/broker.ts"], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(TEST_BROKER_PORT),
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
    if (i === 29) throw new Error("Test broker failed to start on port " + TEST_BROKER_PORT);
  }

  // Dynamically import executor-helpers AFTER setting the env var.
  // Note: In Bun, static imports are hoisted. Since we can't truly lazy-load with
  // static imports, we use dynamic import here so the module reads the env var we set.
  const helpers = await import("./executor-helpers.ts");
  sendAck = helpers.sendAck;
  gitPullRebase = helpers.gitPullRebase;
  readPlanFile = helpers.readPlanFile;
  checkConflicts = helpers.checkConflicts;
  sendProgress = helpers.sendProgress;
  sendPhaseComplete = helpers.sendPhaseComplete;
  sendPhaseBlocked = helpers.sendPhaseBlocked;
  sendStatusResponse = helpers.sendStatusResponse;
  handleReclaim = helpers.handleReclaim;
  gitPushWithJitter = helpers.gitPushWithJitter;
  shouldSkipWrite = helpers.shouldSkipWrite;
  callTaskStart = helpers.callTaskStart;
  callTaskComplete = helpers.callTaskComplete;
  callTaskBlocked = helpers.callTaskBlocked;

  // Register executor and orchestrator test peers on the test broker
  const exec = await brokerPost<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp/executor-test",
    git_root: null,
    tty: null,
    summary: "test executor peer",
  });
  executorId = exec.id;

  const orch = await brokerPost<{ id: string }>("/register", {
    pid: process.pid + 1,
    cwd: "/tmp/orchestrator-test",
    git_root: null,
    tty: null,
    summary: "test orchestrator peer",
  });
  orchestratorId = orch.id;
});

afterAll(async () => {
  // Clean up peers
  try {
    await brokerPost("/unregister", { id: executorId });
    await brokerPost("/unregister", { id: orchestratorId });
  } catch {}

  brokerProc?.kill();
  try { unlinkSync(dbPath); } catch {}
  delete process.env.CLAUDE_PEERS_PORT;
});

// ============================================================
// TEST GROUP 1: shouldSkipWrite (EXEC-09)
// Pure function — no broker needed.
// ============================================================

describe("shouldSkipWrite", () => {
  test("returns true for ROADMAP.md with --no-transition", () => {
    expect(shouldSkipWrite("ROADMAP.md", "--no-transition")).toBe(true);
  });

  test("returns true for STATE.md with --no-transition --auto", () => {
    expect(shouldSkipWrite("STATE.md", "--no-transition --auto")).toBe(true);
  });

  test("returns false for regular files with --no-transition", () => {
    expect(shouldSkipWrite("src/app.ts", "--no-transition")).toBe(false);
  });

  test("returns false for ROADMAP.md without --no-transition flag", () => {
    expect(shouldSkipWrite("ROADMAP.md", "")).toBe(false);
    expect(shouldSkipWrite("ROADMAP.md", "--auto")).toBe(false);
  });

  test("returns true for nested STATE.md path with --no-transition", () => {
    expect(shouldSkipWrite(".planning/phases/01/STATE.md", "--no-transition")).toBe(true);
  });

  test("returns false when flag present but file is not ROADMAP.md or STATE.md", () => {
    expect(shouldSkipWrite("ROADMAP.mdb", "--no-transition")).toBe(false);
    expect(shouldSkipWrite("src/ROADMAP.ts", "--no-transition")).toBe(false);
  });
});

// ============================================================
// TEST GROUP 2: readPlanFile path validation (EXEC-02 security)
// Pure filesystem tests — broker not needed.
// ============================================================

describe("readPlanFile", () => {
  test("rejects path traversal attempts", async () => {
    const result = await readPlanFile("../../../etc/passwd", "/tmp");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid plan path");
  });

  test("rejects paths not starting with .planning/phases/", async () => {
    const result = await readPlanFile("src/app.ts", "/tmp");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid plan path");
  });

  test("rejects absolute paths", async () => {
    const result = await readPlanFile("/etc/passwd", "/tmp");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid plan path");
  });

  test("accepts valid plan path prefix but returns not found for nonexistent file", async () => {
    // /tmp has no .planning dir, so file won't exist — should say "not found", not "Invalid plan path"
    const result = await readPlanFile(".planning/phases/01-foundation/01-01-PLAN.md", "/tmp");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("accepts and reads an existing plan file", async () => {
    const result = await readPlanFile(
      ".planning/phases/02-executor-protocol/02-03-PLAN.md",
      "/home/joshuaduffill/dev/claude-peers-mcp"
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("executor");
  });
});

// ============================================================
// TEST GROUP 3: gitPushWithJitter (EXEC-08)
// ============================================================

describe("gitPushWithJitter", () => {
  test("function is exported and callable", () => {
    expect(typeof gitPushWithJitter).toBe("function");
  });

  test("applies jitter via Math.random — verifies jitter is called at least once", async () => {
    const randomValues: number[] = [];
    const originalRandom = Math.random;

    // Intercept Math.random calls to verify jitter is applied (0-3000ms range)
    Math.random = () => {
      const val = 0.001; // Very small value → near-zero jitter delay
      randomValues.push(val);
      return val;
    };

    // Run push against a non-git /tmp directory — exits fast, Math.random still called
    await gitPushWithJitter("/tmp", "main").catch(() => undefined);

    Math.random = originalRandom;

    // gitPushWithJitter calls Math.random at least once for the jitter delay
    expect(randomValues.length).toBeGreaterThanOrEqual(1);
    // Verify the jitter value is within 0-3000ms range
    expect(randomValues[0]).toBeGreaterThanOrEqual(0);
    expect(randomValues[0]).toBeLessThanOrEqual(1); // Math.random returns [0,1)
  });

  test("returns { ok, error? } shape on failure", async () => {
    // /tmp is not a git repo with a remote — push will fail
    const result = await gitPushWithJitter("/tmp", "main");
    expect(result).toHaveProperty("ok");
    expect(result.ok).toBe(false);
  });
});

// ============================================================
// TEST GROUP 4: gitPullRebase (EXEC-02)
// ============================================================

describe("gitPullRebase", () => {
  test("returns ok:false on non-zero exit code (/tmp has no git remote)", async () => {
    const result = await gitPullRebase("/tmp", "main");
    expect(result.ok).toBe(false);
  });

  test("returns shape { ok: boolean, error?: string } on failure", async () => {
    const result = await gitPullRebase("/tmp", "main");
    expect(result).toHaveProperty("ok");
    expect(typeof result.ok).toBe("boolean");
  });
});

// ============================================================
// TEST GROUP 5: Message sending functions (EXEC-01, EXEC-03, EXEC-04, EXEC-05, EXEC-06)
// These tests use the live test broker via executor-helpers.ts.
// ============================================================

describe("message sending functions", () => {
  test("sendAck sends status_response with acknowledged status (EXEC-01)", async () => {
    await drainMessages(orchestratorId);

    await sendAck(executorId, orchestratorId, 1, 1);

    const msgs = await brokerPost<{ messages: Array<{ id: number; msg_type: string; payload: string }> }>(
      "/poll-messages",
      { id: orchestratorId }
    );

    const ack = msgs.messages.find((m) => m.msg_type === "status_response");
    expect(ack).toBeDefined();

    const payload = JSON.parse(ack!.payload) as StatusResponsePayload;
    expect(payload.status).toBe("acknowledged");
    expect(payload.task_id).toBe(1);
    expect(payload.current_task).toBe("setup");

    await brokerPost("/ack-message", { message_ids: msgs.messages.map((m) => m.id) });
  });

  test("sendProgress sends phase_progress with correct fields (EXEC-03)", async () => {
    await drainMessages(orchestratorId);

    const progressPayload: PhaseProgressPayload = {
      task_id: 1,
      wave_id: 1,
      phase_number: 1,
      tasks_completed: 1,
      tasks_total: 3,
      last_commit: "abc123",
      current_task: "Task 2",
    };
    await sendProgress(executorId, orchestratorId, progressPayload);

    const msgs = await brokerPost<{ messages: Array<{ id: number; msg_type: string; payload: string }> }>(
      "/poll-messages",
      { id: orchestratorId }
    );

    const progress = msgs.messages.find((m) => m.msg_type === "phase_progress");
    expect(progress).toBeDefined();

    const payload = JSON.parse(progress!.payload) as PhaseProgressPayload;
    expect(payload.tasks_completed).toBe(1);
    expect(payload.tasks_total).toBe(3);
    expect(payload.last_commit).toBe("abc123");
    expect(payload.current_task).toBe("Task 2");

    await brokerPost("/ack-message", { message_ids: msgs.messages.map((m) => m.id) });
  });

  test("sendPhaseComplete sends phase_complete with verification (EXEC-04)", async () => {
    await drainMessages(orchestratorId);

    const completePayload: PhaseCompletePayload = {
      task_id: 1,
      wave_id: 1,
      phase_number: 1,
      verification: {
        passed: true,
        criteria_met: 3,
        criteria_total: 3,
        gaps: [],
      },
      commits: ["sha1", "sha2"],
      files_modified: ["src/a.ts"],
    };
    await sendPhaseComplete(executorId, orchestratorId, completePayload);

    const msgs = await brokerPost<{ messages: Array<{ id: number; msg_type: string; payload: string }> }>(
      "/poll-messages",
      { id: orchestratorId }
    );

    const complete = msgs.messages.find((m) => m.msg_type === "phase_complete");
    expect(complete).toBeDefined();

    const payload = JSON.parse(complete!.payload) as PhaseCompletePayload;
    expect(payload.verification.passed).toBe(true);
    expect(payload.verification.criteria_met).toBe(3);
    expect(payload.commits).toEqual(["sha1", "sha2"]);
    expect(payload.files_modified).toEqual(["src/a.ts"]);

    await brokerPost("/ack-message", { message_ids: msgs.messages.map((m) => m.id) });
  });

  test("sendPhaseBlocked sends phase_blocked with BlockedReason (EXEC-05)", async () => {
    await drainMessages(orchestratorId);

    const blockedPayload: PhaseBlockedPayload = {
      task_id: 1,
      wave_id: 1,
      phase_number: 1,
      reason: "git_conflict",
      detail: "Rebase conflict on main",
      tasks_completed: 0,
      tasks_total: 3,
      recoverable: true,
    };
    await sendPhaseBlocked(executorId, orchestratorId, blockedPayload);

    const msgs = await brokerPost<{ messages: Array<{ id: number; msg_type: string; payload: string }> }>(
      "/poll-messages",
      { id: orchestratorId }
    );

    const blocked = msgs.messages.find((m) => m.msg_type === "phase_blocked");
    expect(blocked).toBeDefined();

    const payload = JSON.parse(blocked!.payload) as PhaseBlockedPayload;
    expect(payload.reason).toBe("git_conflict");
    expect(payload.recoverable).toBe(true);
    expect(payload.detail).toBe("Rebase conflict on main");

    await brokerPost("/ack-message", { message_ids: msgs.messages.map((m) => m.id) });
  });

  test("sendStatusResponse sends status_response with current state (EXEC-06)", async () => {
    await drainMessages(orchestratorId);

    const statusPayload: StatusResponsePayload = {
      task_id: 1,
      status: "executing",
      tasks_completed: 2,
      tasks_total: 3,
      current_task: "Task 3",
      last_activity: new Date().toISOString(),
    };
    await sendStatusResponse(executorId, orchestratorId, statusPayload);

    const msgs = await brokerPost<{ messages: Array<{ id: number; msg_type: string; payload: string }> }>(
      "/poll-messages",
      { id: orchestratorId }
    );

    const status = msgs.messages.find((m) => m.msg_type === "status_response");
    expect(status).toBeDefined();

    const payload = JSON.parse(status!.payload) as StatusResponsePayload;
    expect(payload.status).toBe("executing");
    expect(payload.tasks_completed).toBe(2);
    expect(payload.tasks_total).toBe(3);

    await brokerPost("/ack-message", { message_ids: msgs.messages.map((m) => m.id) });
  });
});

// ============================================================
// TEST GROUP 6: Broker task lifecycle calls (EXEC-02, EXEC-04, EXEC-05)
// ============================================================

describe("broker task lifecycle", () => {
  let waveId: number;
  let taskIds: number[];
  const sessionId = `helpers-lifecycle-${Date.now()}`;

  beforeAll(async () => {
    // Create session for task lifecycle tests
    await brokerPost("/session-heartbeat", {
      session_id: sessionId,
      pid: process.pid + 10,
      cwd: "/tmp/lifecycle-test",
      git_root: null,
      task_summary: "lifecycle test worker",
    });

    // Create a wave with three tasks
    const wave = await brokerPost<{ wave_id: number; task_ids: number[] }>("/wave-create", {
      repo: "/tmp/helpers-lifecycle-test",
      phase: 50,
      wave_number: 1,
      tasks: [
        { name: "LifecycleTask01", files: ["src/lifecycle-a.ts"] },
        { name: "LifecycleTask02", files: ["src/lifecycle-b.ts"] },
        { name: "LifecycleTask03", files: ["src/lifecycle-c.ts"] },
      ],
    });
    waveId = wave.wave_id;
    taskIds = wave.task_ids;
  });

  afterAll(async () => {
    try {
      await brokerPost("/session-end", { session_id: sessionId });
    } catch {}
  });

  test("callTaskStart registers session with task (status becomes running)", async () => {
    await callTaskStart(taskIds[0], sessionId);

    const waveStatus = await brokerPost<{ tasks: Array<{ id: number; status: string }> }>(
      "/wave-status",
      { wave_id: waveId }
    );
    const task = waveStatus.tasks.find((t) => t.id === taskIds[0]);
    expect(task).toBeDefined();
    expect(task!.status).toBe("running");
  });

  test("callTaskComplete marks task done and returns wave_completed boolean", async () => {
    // Task 0 is running (from previous test) — complete it
    const result = await callTaskComplete(taskIds[0]);
    expect(result).toHaveProperty("ok");
    expect(result).toHaveProperty("wave_completed");
    expect(result.ok).toBe(true);
    // Tasks 1 and 2 are still pending, so wave is not complete
    expect(result.wave_completed).toBe(false);
  });

  test("checkConflicts returns ok:true when no conflicts exist", async () => {
    // No running tasks on lifecycle-d.ts (unique file not in any task)
    const result = await checkConflicts(waveId, ["src/lifecycle-unique-not-in-any-task.ts"]);
    expect(result.ok).toBe(true);
    expect(result.conflicts).toBeUndefined();
  });

  test("callTaskStart then callTaskBlocked marks task blocked", async () => {
    // Start task 1, then block it
    await callTaskStart(taskIds[1], sessionId);
    await callTaskBlocked(taskIds[1], "dependency missing for test");

    const waveStatus = await brokerPost<{ tasks: Array<{ id: number; status: string }> }>(
      "/wave-status",
      { wave_id: waveId }
    );
    const task = waveStatus.tasks.find((t) => t.id === taskIds[1]);
    expect(task).toBeDefined();
    expect(task!.status).toBe("blocked");
  });

  test("checkConflicts returns ok:false when conflicts exist with running task", async () => {
    // Start task 2 (lifecycle-c.ts) — now it's running and should conflict
    await callTaskStart(taskIds[2], sessionId);

    // Check for conflict with lifecycle-c.ts (which is running in task 2)
    const result = await checkConflicts(waveId, ["src/lifecycle-c.ts"]);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toBeDefined();
    expect(result.conflicts!.length).toBeGreaterThan(0);

    // Verify the conflicting file is in the response
    const allConflictFiles = result.conflicts!.flatMap((c) => c.conflicting_files);
    expect(allConflictFiles).toContain("src/lifecycle-c.ts");
  });
});

// ============================================================
// TEST GROUP 7: handleReclaim (EXEC-07)
// ============================================================

describe("handleReclaim", () => {
  test("sends status_response with reclaimed status (fire-and-forget push)", async () => {
    await drainMessages(orchestratorId);

    const reclaimPayload = {
      task_id: 99,
      wave_id: 1,
      reason: "orchestrator timeout",
    };

    // handleReclaim will attempt git add/commit/push in cwd.
    // /tmp is not a git repo — git ops fail (exit non-zero) but are fire-and-forget.
    // The status response MUST still be sent regardless of git failures.
    await handleReclaim(
      executorId,
      orchestratorId,
      reclaimPayload,
      "/tmp",
      "main",
      2,
      5
    );

    const msgs = await brokerPost<{ messages: Array<{ id: number; msg_type: string; payload: string }> }>(
      "/poll-messages",
      { id: orchestratorId }
    );

    // The status_response with "reclaimed" status should always be sent
    const reclaimed = msgs.messages.find((m) => m.msg_type === "status_response");
    expect(reclaimed).toBeDefined();

    const payload = JSON.parse(reclaimed!.payload) as StatusResponsePayload;
    expect(payload.status).toBe("reclaimed");
    expect(payload.task_id).toBe(99);
    expect(payload.tasks_completed).toBe(2);
    expect(payload.tasks_total).toBe(5);
    expect(payload.current_task).toBe("reclaimed");

    await brokerPost("/ack-message", { message_ids: msgs.messages.map((m) => m.id) });
  });
});
