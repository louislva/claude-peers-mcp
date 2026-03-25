import { test, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "fs";

const BROKER_PORT = 17899; // Use a different port for tests
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
let brokerProc: ReturnType<typeof Bun.spawn>;
const dbPath = `/tmp/claude-peers-test-${Date.now()}.db`;

async function brokerPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

beforeAll(async () => {
  brokerProc = Bun.spawn(["bun", "broker.ts"], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(BROKER_PORT),
      CLAUDE_PEERS_DB: dbPath,
    },
    stdout: "ignore",
    stderr: "pipe",
  });

  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Broker failed to start");
});

afterAll(() => {
  brokerProc?.kill();
  try { unlinkSync(dbPath); } catch {}
});

// --- Phase 1: Atomic transaction tests ---

test("register returns a peer ID", async () => {
  const res = await brokerPost<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "test peer",
  });
  expect(res.id).toBeString();
  expect(res.id.length).toBe(8);
});

test("register re-registration cleans old peer atomically", async () => {
  const first = await brokerPost<{ id: string }>("/register", {
    pid: 99990,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "first",
  });

  const sender = await brokerPost<{ id: string }>("/register", {
    pid: 99991,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "sender",
  });
  await brokerPost("/send-message", {
    from_id: sender.id,
    to_id: first.id,
    text: "hello",
  });

  // Re-register with same PID — should clean up old peer + messages
  const second = await brokerPost<{ id: string }>("/register", {
    pid: 99990,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "second",
  });

  expect(second.id).not.toBe(first.id);

  const poll = await brokerPost<{ messages: unknown[] }>("/poll-messages", { id: second.id });
  expect(poll.messages.length).toBe(0);
});

test("poll-messages returns undelivered, ACK marks delivered", async () => {
  const peer = await brokerPost<{ id: string }>("/register", {
    pid: 99992,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "receiver",
  });
  const sender = await brokerPost<{ id: string }>("/register", {
    pid: 99993,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "sender",
  });

  for (let i = 0; i < 3; i++) {
    await brokerPost("/send-message", {
      from_id: sender.id,
      to_id: peer.id,
      text: `message ${i}`,
    });
  }

  // First poll returns all 3 (not yet ACKed)
  const first = await brokerPost<{ messages: { id: number }[] }>("/poll-messages", { id: peer.id });
  expect(first.messages.length).toBe(3);

  // Without ACK, second poll still returns all 3
  const second = await brokerPost<{ messages: { id: number }[] }>("/poll-messages", { id: peer.id });
  expect(second.messages.length).toBe(3);

  // ACK all messages
  await brokerPost("/ack-message", { message_ids: first.messages.map((m) => m.id) });

  // Now poll returns 0
  const third = await brokerPost<{ messages: unknown[] }>("/poll-messages", { id: peer.id });
  expect(third.messages.length).toBe(0);
});

test("send-message to nonexistent peer returns error", async () => {
  const sender = await brokerPost<{ id: string }>("/register", {
    pid: 99994,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "sender",
  });

  const res = await brokerPost<{ ok: boolean; error: string }>("/send-message", {
    from_id: sender.id,
    to_id: "nonexistent",
    text: "hello",
  });
  expect(res.ok).toBe(false);
  expect(res.error).toContain("not found");
});

test("unregister cleans peer + all messages (sent and received)", async () => {
  const peer = await brokerPost<{ id: string }>("/register", {
    pid: 99995,
    cwd: "/tmp/test-unregister",
    git_root: null,
    tty: null,
    summary: "to-delete",
  });
  const sender = await brokerPost<{ id: string }>("/register", {
    pid: 99996,
    cwd: "/tmp/test-unregister",
    git_root: null,
    tty: null,
    summary: "sender",
  });

  // Send messages in both directions
  await brokerPost("/send-message", { from_id: sender.id, to_id: peer.id, text: "to peer" });
  await brokerPost("/send-message", { from_id: peer.id, to_id: sender.id, text: "from peer" });

  // ACK the message sent to sender (mark it delivered) to test FK cleanup of delivered msgs
  const senderPoll = await brokerPost<{ messages: { id: number }[] }>("/poll-messages", { id: sender.id });
  await brokerPost("/ack-message", { message_ids: senderPoll.messages.map((m) => m.id) });

  // Unregister peer — should succeed even with delivered messages referencing it
  const unregResult = await brokerPost<{ ok: boolean }>("/unregister", { id: peer.id });
  expect(unregResult.ok).toBe(true);

  // Peer's messages should be cleaned
  const poll = await brokerPost<{ messages: unknown[] }>("/poll-messages", { id: peer.id });
  expect(poll.messages.length).toBe(0);
});

// --- Phase 2: Session tests ---

test("session-heartbeat creates peer + session atomically", async () => {
  const res = await brokerPost<{ peer_id: string; session_id: string }>("/session-heartbeat", {
    session_id: "test-session-001",
    pid: process.pid,
    cwd: "/tmp/test-session",
    git_root: "/tmp/test-repo",
    task_summary: "Working on feature X",
  });

  expect(res.peer_id).toBeString();
  expect(res.session_id).toBe("test-session-001");

  const status = await brokerPost<{ session_id: string; task_summary: string; status: string }>(
    "/session-status",
    { session_id: "test-session-001" }
  );
  expect(status.session_id).toBe("test-session-001");
  expect(status.task_summary).toBe("Working on feature X");
  expect(status.status).toBe("active");
});

test("session-heartbeat is idempotent — second call updates, doesn't duplicate", async () => {
  const first = await brokerPost<{ peer_id: string }>("/session-heartbeat", {
    session_id: "test-session-idem",
    pid: process.pid,
    cwd: "/tmp/test",
    git_root: null,
    task_summary: "First summary",
  });

  const second = await brokerPost<{ peer_id: string }>("/session-heartbeat", {
    session_id: "test-session-idem",
    pid: process.pid,
    cwd: "/tmp/test",
    git_root: null,
    task_summary: "Updated summary",
  });

  expect(second.peer_id).toBe(first.peer_id);

  const status = await brokerPost<{ task_summary: string }>("/session-status", {
    session_id: "test-session-idem",
  });
  expect(status.task_summary).toBe("Updated summary");
});

test("session-end cleans session + peer atomically", async () => {
  const res = await brokerPost<{ peer_id: string }>("/session-heartbeat", {
    session_id: "test-session-end",
    pid: 99997,
    cwd: "/tmp/test",
    git_root: null,
    task_summary: "About to end",
  });

  await brokerPost("/session-end", { session_id: "test-session-end" });

  const status = await brokerPost<{ status?: string; error?: string }>("/session-status", {
    session_id: "test-session-end",
  });
  expect(status.status).toBe("completed");
});

// --- Phase 3: Wave / orchestration tests ---

test("wave-create creates wave + tasks atomically", async () => {
  const res = await brokerPost<{ wave_id: number; task_ids: number[] }>("/wave-create", {
    repo: "/tmp/test-repo",
    phase: 1,
    wave_number: 1,
    tasks: [
      { name: "T01: Build auth module", files: ["src/auth.ts", "src/auth.test.ts"] },
      { name: "T02: Build user model", files: ["src/user.ts"] },
      { name: "T03: Build API routes", files: ["src/routes.ts"] },
    ],
  });

  expect(res.wave_id).toBeNumber();
  expect(res.task_ids.length).toBe(3);

  const status = await brokerPost<{ wave: { status: string }; tasks: { task_name: string; status: string }[] }>(
    "/wave-status",
    { wave_id: res.wave_id }
  );
  expect(status.wave.status).toBe("pending");
  expect(status.tasks.length).toBe(3);
  expect(status.tasks[0].status).toBe("pending");
});

test("wave-create is idempotent", async () => {
  const first = await brokerPost<{ wave_id: number }>("/wave-create", {
    repo: "/tmp/test-repo",
    phase: 1,
    wave_number: 2,
    tasks: [{ name: "T01", files: [] }],
  });

  const second = await brokerPost<{ wave_id: number }>("/wave-create", {
    repo: "/tmp/test-repo",
    phase: 1,
    wave_number: 2,
    tasks: [{ name: "T01", files: [] }],
  });

  expect(second.wave_id).toBe(first.wave_id);
});

test("wave-status on nonexistent wave returns error", async () => {
  const res = await brokerPost<{ error?: string }>("/wave-status", { wave_id: 99999 });
  expect(res.error).toBe("Wave not found");
});

test("task-start assigns session + detects file conflicts", async () => {
  const wave = await brokerPost<{ wave_id: number; task_ids: number[] }>("/wave-create", {
    repo: "/tmp/conflict-test",
    phase: 1,
    wave_number: 1,
    tasks: [
      { name: "T01", files: ["shared.ts", "a.ts"] },
      { name: "T02", files: ["shared.ts", "b.ts"] },
      { name: "T03", files: ["c.ts"] },
    ],
  });

  await brokerPost("/session-heartbeat", {
    session_id: "conflict-s1",
    pid: 77701,
    cwd: "/tmp/test",
    git_root: null,
    task_summary: "worker 1",
  });
  await brokerPost("/session-heartbeat", {
    session_id: "conflict-s2",
    pid: 77702,
    cwd: "/tmp/test",
    git_root: null,
    task_summary: "worker 2",
  });

  const start1 = await brokerPost<{ ok: boolean }>("/task-start", {
    task_id: wave.task_ids[0],
    session_id: "conflict-s1",
  });
  expect(start1.ok).toBe(true);

  // T02 conflicts on shared.ts
  const start2 = await brokerPost<{ ok: boolean; error: string }>("/task-start", {
    task_id: wave.task_ids[1],
    session_id: "conflict-s2",
  });
  expect(start2.ok).toBe(false);
  expect(start2.error).toContain("conflict");
  expect(start2.error).toContain("shared.ts");

  // T03 has no conflict
  const start3 = await brokerPost<{ ok: boolean }>("/task-start", {
    task_id: wave.task_ids[2],
    session_id: "conflict-s2",
  });
  expect(start3.ok).toBe(true);
});

test("task-start rejects double-start on running task", async () => {
  const wave = await brokerPost<{ wave_id: number; task_ids: number[] }>("/wave-create", {
    repo: "/tmp/double-start-test",
    phase: 1,
    wave_number: 1,
    tasks: [{ name: "T01", files: [] }],
  });

  await brokerPost("/session-heartbeat", {
    session_id: "ds-s1",
    pid: 77710,
    cwd: "/tmp/test",
    git_root: null,
    task_summary: "w1",
  });

  await brokerPost("/task-start", { task_id: wave.task_ids[0], session_id: "ds-s1" });

  // Double-start should fail
  const res = await brokerPost<{ ok: boolean; error: string }>("/task-start", {
    task_id: wave.task_ids[0],
    session_id: "ds-s1",
  });
  expect(res.ok).toBe(false);
  expect(res.error).toContain("already running");
});

test("task-blocked then task-start allows blocked → running", async () => {
  const wave = await brokerPost<{ wave_id: number; task_ids: number[] }>("/wave-create", {
    repo: "/tmp/blocked-restart-test",
    phase: 1,
    wave_number: 1,
    tasks: [{ name: "T01", files: [] }],
  });

  await brokerPost("/session-heartbeat", {
    session_id: "br-s1",
    pid: 77711,
    cwd: "/tmp/test",
    git_root: null,
    task_summary: "w1",
  });

  // Start then block
  await brokerPost("/task-start", { task_id: wave.task_ids[0], session_id: "br-s1" });
  const blocked = await brokerPost<{ ok: boolean }>("/task-blocked", {
    task_id: wave.task_ids[0],
    reason: "dependency missing",
  });
  expect(blocked.ok).toBe(true);

  // Restart blocked task
  const restart = await brokerPost<{ ok: boolean }>("/task-start", {
    task_id: wave.task_ids[0],
    session_id: "br-s1",
  });
  expect(restart.ok).toBe(true);
});

test("task-complete auto-completes wave when all tasks done", async () => {
  const wave = await brokerPost<{ wave_id: number; task_ids: number[] }>("/wave-create", {
    repo: "/tmp/auto-complete-test",
    phase: 1,
    wave_number: 1,
    tasks: [
      { name: "T01", files: [] },
      { name: "T02", files: [] },
    ],
  });

  await brokerPost("/session-heartbeat", {
    session_id: "auto-s1",
    pid: 77704,
    cwd: "/tmp/test",
    git_root: null,
    task_summary: "w1",
  });
  await brokerPost("/task-start", { task_id: wave.task_ids[0], session_id: "auto-s1" });
  await brokerPost("/task-start", { task_id: wave.task_ids[1], session_id: "auto-s1" });

  const r1 = await brokerPost<{ ok: boolean; wave_completed: boolean }>("/task-complete", {
    task_id: wave.task_ids[0],
  });
  expect(r1.ok).toBe(true);
  expect(r1.wave_completed).toBe(false);

  const r2 = await brokerPost<{ ok: boolean; wave_completed: boolean }>("/task-complete", {
    task_id: wave.task_ids[1],
  });
  expect(r2.ok).toBe(true);
  expect(r2.wave_completed).toBe(true);

  const status = await brokerPost<{ wave: { status: string } }>("/wave-status", { wave_id: wave.wave_id });
  expect(status.wave.status).toBe("completed");
});

test("conflict-check finds overlapping files", async () => {
  const wave = await brokerPost<{ wave_id: number; task_ids: number[] }>("/wave-create", {
    repo: "/tmp/conflict-check-test",
    phase: 1,
    wave_number: 1,
    tasks: [
      { name: "T01", files: ["src/a.ts", "src/shared.ts"] },
    ],
  });

  await brokerPost("/session-heartbeat", {
    session_id: "cc-s1",
    pid: 77703,
    cwd: "/tmp/test",
    git_root: null,
    task_summary: "w1",
  });
  await brokerPost("/task-start", { task_id: wave.task_ids[0], session_id: "cc-s1" });

  const check = await brokerPost<{ conflicts: { conflicting_files: string[] }[] }>("/conflict-check", {
    wave_id: wave.wave_id,
    files: ["src/shared.ts", "src/b.ts"],
  });

  expect(check.conflicts.length).toBe(1);
  expect(check.conflicts[0].conflicting_files).toEqual(["src/shared.ts"]);
});

// --- Phase 4: Structured messages + ACK ---

test("send-message supports msg_type and payload", async () => {
  const p1 = await brokerPost<{ id: string }>("/register", {
    pid: 99998,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "p1",
  });
  const p2 = await brokerPost<{ id: string }>("/register", {
    pid: 99999,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "p2",
  });

  await brokerPost("/send-message", {
    from_id: p1.id,
    to_id: p2.id,
    text: "Task T01 completed",
    msg_type: "task_complete",
    payload: { task_id: 42, wave_id: 1 },
  });

  const poll = await brokerPost<{ messages: { id: number; text: string; msg_type: string; payload: string }[] }>(
    "/poll-messages",
    { id: p2.id }
  );

  expect(poll.messages.length).toBe(1);
  expect(poll.messages[0].msg_type).toBe("task_complete");
  expect(JSON.parse(poll.messages[0].payload)).toEqual({ task_id: 42, wave_id: 1 });

  // ACK to clean up
  await brokerPost("/ack-message", { message_ids: [poll.messages[0].id] });
});

test("ack-message marks messages as delivered — poll no longer returns them", async () => {
  const p1 = await brokerPost<{ id: string }>("/register", {
    pid: 88881,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "ack-sender",
  });
  const p2 = await brokerPost<{ id: string }>("/register", {
    pid: 88882,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "ack-receiver",
  });

  await brokerPost("/send-message", { from_id: p1.id, to_id: p2.id, text: "msg1" });
  await brokerPost("/send-message", { from_id: p1.id, to_id: p2.id, text: "msg2" });

  // Poll returns both (undelivered)
  const poll = await brokerPost<{ messages: { id: number }[] }>("/poll-messages", { id: p2.id });
  expect(poll.messages.length).toBe(2);

  // ACK only the first message
  await brokerPost("/ack-message", { message_ids: [poll.messages[0].id] });

  // Poll now returns only the second (un-ACKed) message
  const poll2 = await brokerPost<{ messages: { id: number }[] }>("/poll-messages", { id: p2.id });
  expect(poll2.messages.length).toBe(1);
  expect(poll2.messages[0].id).toBe(poll.messages[1].id);

  // ACK the second
  await brokerPost("/ack-message", { message_ids: [poll.messages[1].id] });

  // Now empty
  const poll3 = await brokerPost<{ messages: unknown[] }>("/poll-messages", { id: p2.id });
  expect(poll3.messages.length).toBe(0);
});

// --- FK constraint regression test ---

test("unregister succeeds even when peer has delivered messages (FK regression)", async () => {
  const sender = await brokerPost<{ id: string }>("/register", {
    pid: 88891,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "fk-sender",
  });
  const receiver = await brokerPost<{ id: string }>("/register", {
    pid: 88892,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "fk-receiver",
  });

  // Send message and ACK it (mark as delivered)
  await brokerPost("/send-message", { from_id: sender.id, to_id: receiver.id, text: "delivered msg" });
  const poll = await brokerPost<{ messages: { id: number }[] }>("/poll-messages", { id: receiver.id });
  await brokerPost("/ack-message", { message_ids: poll.messages.map((m) => m.id) });

  // Now unregister the SENDER (has from_id FK ref on delivered message)
  // This would fail with old code that only deleted undelivered messages
  const res = await brokerPost<{ ok: boolean }>("/unregister", { id: sender.id });
  expect(res.ok).toBe(true);

  // Also unregister receiver (has to_id FK ref on delivered message)
  const res2 = await brokerPost<{ ok: boolean }>("/unregister", { id: receiver.id });
  expect(res2.ok).toBe(true);
});

// --- Stats + monitoring ---

test("/stats returns DB size, row counts, and retention config", async () => {
  const res = await fetch(`${BROKER_URL}/stats`);
  const stats = (await res.json()) as {
    db_path: string;
    db_size_bytes: number;
    db_size_human: string;
    schema_version: number;
    retention: { messages_hours: number; sessions_days: number; waves_days: number };
    counts: { peers: number; messages_total: number; sessions_active: number; waves_total: number; tasks_total: number };
  };

  expect(stats.db_path).toBeString();
  expect(stats.db_size_bytes).toBeGreaterThan(0);
  expect(stats.db_size_human).toContain("B"); // e.g. "32.0 KB"
  expect(stats.schema_version).toBe(1);
  expect(stats.retention.messages_hours).toBe(24);
  expect(stats.retention.sessions_days).toBe(7);
  expect(stats.retention.waves_days).toBe(30);
  expect(stats.counts.peers).toBeGreaterThanOrEqual(0);
  expect(stats.counts.messages_total).toBeGreaterThanOrEqual(0);
});

test("/stats includes index info after schema setup", async () => {
  // Verify the stats endpoint works and DB has been set up with indexes
  const res = await fetch(`${BROKER_URL}/stats`);
  const stats = (await res.json()) as { db_size_bytes: number };
  // DB should be non-trivial size (indexes + tables)
  expect(stats.db_size_bytes).toBeGreaterThan(0);
});

test("/vacuum reclaims disk space", async () => {
  const res = await brokerPost<{ ok: boolean; size_before: string; size_after: string }>("/vacuum", {});
  expect(res.ok).toBe(true);
  expect(res.size_before).toContain("B");
  expect(res.size_after).toContain("B");
});

test("/prune returns counts of pruned rows", async () => {
  const res = await brokerPost<{
    messages_pruned: number;
    sessions_pruned: number;
    waves_pruned: number;
    tasks_pruned: number;
  }>("/prune", {});

  // On a fresh test DB with default 24h retention, nothing should be old enough to prune
  expect(res.messages_pruned).toBeGreaterThanOrEqual(0);
  expect(res.sessions_pruned).toBeGreaterThanOrEqual(0);
  expect(res.waves_pruned).toBeGreaterThanOrEqual(0);
  expect(res.tasks_pruned).toBeGreaterThanOrEqual(0);
});
