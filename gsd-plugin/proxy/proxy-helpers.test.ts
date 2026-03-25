/**
 * proxy-helpers.test.ts
 *
 * Integration tests for all proxy protocol helper functions.
 *
 * Strategy:
 * - proxy-helpers.ts uses CLAUDE_PEERS_PORT env var at module load time,
 *   defaulting to 7899. We set CLAUDE_PEERS_PORT=17902 before importing so
 *   the helpers target our isolated test broker.
 * - We achieve this by setting the env var and spawning a dedicated test broker
 *   on port 17902 with an isolated DB.
 *
 * Requirements covered: PRXY-01 through PRXY-05
 */

// IMPORTANT: Set port override BEFORE any imports so proxy-helpers.ts picks it up.
// In Bun, top-level code runs before module initialization of static imports,
// so we use dynamic imports below for the helpers module.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "fs";

const TEST_BROKER_PORT = 17902;
const BROKER_URL = `http://127.0.0.1:${TEST_BROKER_PORT}`;
let brokerProc: ReturnType<typeof Bun.spawn>;
const dbPath = `/tmp/claude-peers-proxy-test-${Date.now()}.db`;

// Dynamic imports populated in beforeAll
let pollForChoices: Awaited<ReturnType<typeof import("./proxy-helpers.ts")>>["pollForChoices"];
let parseChoicePayload: Awaited<ReturnType<typeof import("./proxy-helpers.ts")>>["parseChoicePayload"];
let buildAnswerPayload: Awaited<ReturnType<typeof import("./proxy-helpers.ts")>>["buildAnswerPayload"];
let sendAnswer: Awaited<ReturnType<typeof import("./proxy-helpers.ts")>>["sendAnswer"];
let appendDecision: Awaited<ReturnType<typeof import("./proxy-helpers.ts")>>["appendDecision"];
let waitForAnswer: Awaited<ReturnType<typeof import("./proxy-helpers.ts")>>["waitForAnswer"];
let ackMessages: Awaited<ReturnType<typeof import("./proxy-helpers.ts")>>["ackMessages"];

// Test peer IDs
let orchestratorId: string;
let proxyId: string;

async function brokerPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

beforeAll(async () => {
  // Override CLAUDE_PEERS_PORT so proxy-helpers module targets our test broker
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

  // Dynamically import proxy-helpers AFTER setting the env var.
  // Note: In Bun, static imports are hoisted. Since we can't truly lazy-load with
  // static imports, we use dynamic import here so the module reads the env var we set.
  const mod = await import("./proxy-helpers.ts");
  pollForChoices = mod.pollForChoices;
  parseChoicePayload = mod.parseChoicePayload;
  buildAnswerPayload = mod.buildAnswerPayload;
  sendAnswer = mod.sendAnswer;
  appendDecision = mod.appendDecision;
  waitForAnswer = mod.waitForAnswer;
  ackMessages = mod.ackMessages;

  // Register orchestrator and proxy test peers on the test broker
  const orch = await brokerPost<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp/proxy-orchestrator-test",
    git_root: null,
    tty: null,
    summary: "test orchestrator peer",
  });
  orchestratorId = orch.id;

  const proxy = await brokerPost<{ id: string }>("/register", {
    pid: process.pid + 1,
    cwd: "/tmp/proxy-peer-test",
    git_root: null,
    tty: null,
    summary: "test proxy peer",
  });
  proxyId = proxy.id;
});

afterAll(async () => {
  // Clean up peers
  try {
    await brokerPost("/unregister", { id: orchestratorId });
    await brokerPost("/unregister", { id: proxyId });
  } catch {}

  brokerProc?.kill();
  try { unlinkSync(dbPath); } catch {}
  delete process.env.CLAUDE_PEERS_PORT;
});

// ============================================================
// TEST GROUP 1: PRXY-01 — pollForChoices + parseChoicePayload
// ============================================================

describe("PRXY-01: pollForChoices + parseChoicePayload", () => {
  test("pollForChoices returns discuss_choice messages", async () => {
    const choicePayload = {
      phase_number: 3,
      phase_goal: "Build the API",
      question: "Which framework?",
      options: ["express", "hono"],
      recommended: "hono",
      context: "Lightweight framework preferred",
    };

    // Send a discuss_choice from orchestrator to proxy
    await brokerPost("/send-message", {
      from_id: orchestratorId,
      to_id: proxyId,
      text: "Phase 3 choice: Which framework?",
      msg_type: "discuss_choice",
      payload: choicePayload,
    });

    const results = await pollForChoices(proxyId);

    expect(results.length).toBe(1);
    expect(results[0].choicePayload.question).toBe("Which framework?");
    expect(results[0].from_id).toBe(orchestratorId);

    // ACK the message so it doesn't appear in subsequent tests
    await ackMessages([results[0].id]);
  });

  test("parseChoicePayload parses valid JSON", () => {
    const raw = JSON.stringify({
      phase_number: 3,
      phase_goal: "test goal",
      question: "Q?",
      options: ["A", "B"],
      recommended: "A",
      context: "ctx",
    });

    const result = parseChoicePayload(raw);

    expect(result.phase_number).toBe(3);
    expect(result.phase_goal).toBe("test goal");
    expect(result.question).toBe("Q?");
    expect(result.options).toEqual(["A", "B"]);
    expect(result.recommended).toBe("A");
    expect(result.context).toBe("ctx");
  });

  test("parseChoicePayload throws on missing required field", () => {
    // Missing question, options, recommended — only phase_number present
    const raw = JSON.stringify({ phase_number: 3 });

    expect(() => parseChoicePayload(raw)).toThrow("missing required field");
  });
});

// ============================================================
// TEST GROUP 2: PRXY-02 — sendAnswer + buildAnswerPayload
// ============================================================

describe("PRXY-02: sendAnswer + buildAnswerPayload", () => {
  test("sendAnswer delivers discuss_answer to orchestrator", async () => {
    // Drain any existing messages for orchestrator
    const drain = await brokerPost<{ messages: Array<{ id: number }> }>("/poll-messages", { id: orchestratorId });
    if (drain.messages.length > 0) {
      await brokerPost("/ack-message", { message_ids: drain.messages.map((m) => m.id) });
    }

    await sendAnswer(proxyId, orchestratorId, { phase_number: 3, chosen: "A", reasoning: "test" });

    const result = await brokerPost<{ messages: Array<{ id: number; msg_type: string; payload: string }> }>(
      "/poll-messages",
      { id: orchestratorId }
    );

    const answer = result.messages.find((m) => m.msg_type === "discuss_answer");
    expect(answer).toBeDefined();

    const payload = JSON.parse(answer!.payload);
    expect(payload.phase_number).toBe(3);
    expect(payload.chosen).toBe("A");
    expect(payload.reasoning).toBe("test");

    // ACK the message
    await brokerPost("/ack-message", { message_ids: result.messages.map((m) => m.id) });
  });

  test("buildAnswerPayload constructs correct DiscussAnswerPayload shape", () => {
    const result = buildAnswerPayload(5, "option-b", "because");
    expect(result).toEqual({ phase_number: 5, chosen: "option-b", reasoning: "because" });
  });
});

// ============================================================
// TEST GROUP 3: PRXY-03 — prior_decisions round-trip
// ============================================================

describe("PRXY-03: prior_decisions round-trip", () => {
  test("prior_decisions preserved in discuss_choice payload", async () => {
    const choicePayload = {
      phase_number: 4,
      phase_goal: "Phase 4 goal",
      question: "Use TypeScript strict mode?",
      options: ["yes", "no"],
      recommended: "yes",
      context: "Strict mode catches more errors",
      prior_decisions: [{ phase: 1, question: "Q1", chosen: "A" }],
    };

    await brokerPost("/send-message", {
      from_id: orchestratorId,
      to_id: proxyId,
      text: "Phase 4 choice",
      msg_type: "discuss_choice",
      payload: choicePayload,
    });

    const results = await pollForChoices(proxyId);
    const match = results.find((r) => r.choicePayload.phase_number === 4);

    expect(match).toBeDefined();
    expect(match!.choicePayload.prior_decisions).toBeDefined();
    expect(match!.choicePayload.prior_decisions!.length).toBe(1);
    expect(match!.choicePayload.prior_decisions![0].phase).toBe(1);
    expect(match!.choicePayload.prior_decisions![0].question).toBe("Q1");
    expect(match!.choicePayload.prior_decisions![0].chosen).toBe("A");

    // ACK the message
    await ackMessages([match!.id]);
  });
});

// ============================================================
// TEST GROUP 4: PRXY-04 — appendDecision
// ============================================================

describe("PRXY-04: appendDecision", () => {
  test("creates DECISIONS.md with header on first call", async () => {
    const tmpPath = `/tmp/decisions-test-${Date.now()}.md`;

    await appendDecision(tmpPath, 3, "Q?", "A", "reason");

    const content = await Bun.file(tmpPath).text();
    expect(content.startsWith("# Autonomous Run Decisions")).toBe(true);
    expect(content).toContain("## Phase 3");
    expect(content).toContain("**Question:** Q?");
    expect(content).toContain("**Chosen:** A");
    expect(content).toContain("**Reasoning:** reason");
    expect(content).toContain("**Timestamp:**");

    try { unlinkSync(tmpPath); } catch {}
  });

  test("appends second entry without overwriting first", async () => {
    const tmpPath = `/tmp/decisions-append-test-${Date.now()}.md`;

    await appendDecision(tmpPath, 3, "First question?", "Option A", "First reason");
    await appendDecision(tmpPath, 5, "Second question?", "Option B", "Second reason");

    const content = await Bun.file(tmpPath).text();
    expect(content).toContain("## Phase 3");
    expect(content).toContain("## Phase 5");

    // Phase 3 appears before Phase 5
    const phase3Index = content.indexOf("## Phase 3");
    const phase5Index = content.indexOf("## Phase 5");
    expect(phase3Index).toBeLessThan(phase5Index);

    try { unlinkSync(tmpPath); } catch {}
  });
});

// ============================================================
// TEST GROUP 5: PRXY-05 — waitForAnswer
// ============================================================

describe("PRXY-05: waitForAnswer", () => {
  test("returns answer when sent within timeout", async () => {
    // Drain any existing messages for orchestrator
    const drain = await brokerPost<{ messages: Array<{ id: number }> }>("/poll-messages", { id: orchestratorId });
    if (drain.messages.length > 0) {
      await brokerPost("/ack-message", { message_ids: drain.messages.map((m) => m.id) });
    }

    // Start waitForAnswer for phase 3, 10s timeout
    const waitPromise = waitForAnswer(orchestratorId, 3, 10_000);

    // After 500ms, send the answer
    await new Promise((r) => setTimeout(r, 500));
    await brokerPost("/send-message", {
      from_id: proxyId,
      to_id: orchestratorId,
      text: "Phase 3 answer: A",
      msg_type: "discuss_answer",
      payload: { phase_number: 3, chosen: "A", reasoning: "makes sense" },
    });

    const result = await waitPromise;
    expect(result).not.toBeNull();
    expect(result!.chosen).toBe("A");
    expect(result!.phase_number).toBe(3);
  }, 15_000);

  test("returns null on timeout", async () => {
    // waitForAnswer with phase 99 — no answer will be sent, 3s timeout
    const result = await waitForAnswer(orchestratorId, 99, 3_000);
    expect(result).toBeNull();
  }, 10_000);

  test("discards stale answers with wrong phase_number", async () => {
    // Drain any existing messages for orchestrator
    const drain = await brokerPost<{ messages: Array<{ id: number }> }>("/poll-messages", { id: orchestratorId });
    if (drain.messages.length > 0) {
      await brokerPost("/ack-message", { message_ids: drain.messages.map((m) => m.id) });
    }

    // Send a stale answer with phase_number: 1
    await brokerPost("/send-message", {
      from_id: proxyId,
      to_id: orchestratorId,
      text: "Phase 1 answer (stale)",
      msg_type: "discuss_answer",
      payload: { phase_number: 1, chosen: "stale", reasoning: "old answer" },
    });

    // waitForAnswer for phase 5, 4s timeout — stale answer should be discarded
    const result = await waitForAnswer(orchestratorId, 5, 4_000);
    expect(result).toBeNull();
  }, 10_000);
});

// ============================================================
// TEST GROUP 6: ackMessages
// ============================================================

describe("ackMessages", () => {
  test("marks messages as delivered (subsequent poll does not return them)", async () => {
    // Send a message from orchestrator to proxy
    await brokerPost("/send-message", {
      from_id: orchestratorId,
      to_id: proxyId,
      text: "Test ACK message",
      msg_type: "discuss_choice",
      payload: {
        phase_number: 99,
        question: "ACK test?",
        options: ["yes"],
        recommended: "yes",
      },
    });

    // Poll to get the message ID
    const firstPoll = await brokerPost<{ messages: Array<{ id: number; msg_type: string }> }>(
      "/poll-messages",
      { id: proxyId }
    );
    const msg = firstPoll.messages.find((m) => m.msg_type === "discuss_choice");
    expect(msg).toBeDefined();
    const messageId = msg!.id;

    // ACK the message
    await ackMessages([messageId]);

    // Poll again — should not contain the ACKed message
    const secondPoll = await brokerPost<{ messages: Array<{ id: number }> }>(
      "/poll-messages",
      { id: proxyId }
    );
    const stillPresent = secondPoll.messages.find((m) => m.id === messageId);
    expect(stillPresent).toBeUndefined();
  });
});
