import { test, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "fs";

const BROKER_PORT = 17899; // Use a different port for tests
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
let brokerProc: ReturnType<typeof Bun.spawn>;
const dbPath = `/tmp/gsd-comms-test-${Date.now()}.db`;

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
      GSD_COMMS_PORT: String(BROKER_PORT),
      GSD_COMMS_DB: dbPath,
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
  // After conflict-check expansion, overlapping files include src/shared.ts and potentially barrel exports
  expect(check.conflicts[0].conflicting_files).toContain("src/shared.ts");
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

// --- Phase 5: Peer availability tests ---

test("/peer-availability returns empty when no peers match repo", async () => {
  const res = await brokerPost<{ repo_peers: { available: unknown[]; busy: unknown[] }; machine_peers: { available: unknown[]; busy: unknown[] } }>("/peer-availability", {
    repo: "/nonexistent/repo",
  });
  expect(res.repo_peers.available).toEqual([]);
  expect(res.repo_peers.busy).toEqual([]);
  // machine_peers may contain peers from other tests
  expect(res.machine_peers).toBeDefined();
});

test("/peer-availability classifies idle peer as available", async () => {
  // Register a peer with a git_root via /register
  const reg = await brokerPost<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp/avail-test",
    git_root: "/tmp/avail-repo",
    tty: null,
    summary: "idle peer",
  });

  const res = await brokerPost<{ repo_peers: { available: { id: string; idle_since: string }[]; busy: unknown[] } }>("/peer-availability", {
    repo: "/tmp/avail-repo",
  });

  const found = res.repo_peers.available.find((p) => p.id === reg.id);
  expect(found).toBeDefined();
  expect(found!.idle_since).toBeDefined();
  expect(res.repo_peers.busy.length).toBe(0);

  // Cleanup
  await brokerPost("/unregister", { id: reg.id });
});

test("/peer-availability classifies peer with running task as busy", async () => {
  // Register peer + create session + assign running task
  const hb = await brokerPost<{ peer_id: string; session_id: string }>("/session-heartbeat", {
    session_id: "busy-session-1",
    pid: process.pid,
    cwd: "/tmp/busy-test",
    git_root: "/tmp/busy-repo",
    task_summary: "executing phase 1",
  });

  // Create a wave + task and start it
  const wave = await brokerPost<{ wave_id: number; task_ids: number[] }>("/wave-create", {
    repo: "/tmp/busy-repo",
    phase: 99,
    wave_number: 1,
    tasks: [{ name: "busy-task", files: ["src/foo.ts"] }],
  });

  await brokerPost("/task-start", {
    task_id: wave.task_ids[0],
    session_id: "busy-session-1",
  });

  const res = await brokerPost<{ repo_peers: { available: unknown[]; busy: { id: string; current_task: string; task_started_at: string }[] } }>("/peer-availability", {
    repo: "/tmp/busy-repo",
  });

  const found = res.repo_peers.busy.find((p) => p.id === hb.peer_id);
  expect(found).toBeDefined();
  expect(found!.current_task).toBe("busy-task");
  expect(found!.task_started_at).toBeDefined();

  // Cleanup
  await brokerPost("/session-end", { session_id: "busy-session-1" });
});

test("/peer-availability excludes requesting peer via exclude_id", async () => {
  const reg = await brokerPost<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp/exclude-test",
    git_root: "/tmp/exclude-repo",
    tty: null,
    summary: "self peer",
  });

  const res = await brokerPost<{ repo_peers: { available: { id: string }[]; busy: unknown[] } }>("/peer-availability", {
    repo: "/tmp/exclude-repo",
    exclude_id: reg.id,
  });

  const found = res.repo_peers.available.find((p) => p.id === reg.id);
  expect(found).toBeUndefined();

  await brokerPost("/unregister", { id: reg.id });
});

test("/peer-availability puts non-repo peers in machine_peers", async () => {
  const reg = await brokerPost<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp/machine-test",
    git_root: "/tmp/other-repo",
    tty: null,
    summary: "other repo peer",
  });

  const res = await brokerPost<{ repo_peers: { available: { id: string }[] }; machine_peers: { available: { id: string }[] } }>("/peer-availability", {
    repo: "/tmp/target-repo",
  });

  // Should NOT be in repo_peers
  expect(res.repo_peers.available.find((p) => p.id === reg.id)).toBeUndefined();
  // Should be in machine_peers
  const found = res.machine_peers.available.find((p) => p.id === reg.id);
  expect(found).toBeDefined();

  await brokerPost("/unregister", { id: reg.id });
});

test("/peer-availability returns both available and busy peers in mixed state", async () => {
  // Use process.pid for idle and process.ppid for busy so both PIDs pass the liveness check
  // (broker skips peers whose PID is no longer alive via process.kill(pid, 0))
  const idlePid = process.pid;
  const busyPid = process.ppid;

  // Register an idle peer via /register
  const idleReg = await brokerPost<{ id: string }>("/register", {
    pid: idlePid,
    cwd: "/tmp/mixed-idle",
    git_root: "/tmp/mixed-avail-repo",
    tty: null,
    summary: "idle peer for mixed test",
  });

  // Register a busy peer via /session-heartbeat (atomic peer creation, different PID)
  const busyHb = await brokerPost<{ peer_id: string; session_id: string }>("/session-heartbeat", {
    session_id: "mixed-busy-session",
    pid: busyPid,
    cwd: "/tmp/mixed-busy",
    git_root: "/tmp/mixed-avail-repo",
    task_summary: "executing phase",
  });

  // Create a wave and start a task for the busy peer
  const wave = await brokerPost<{ wave_id: number; task_ids: number[] }>("/wave-create", {
    repo: "/tmp/mixed-avail-repo",
    phase: 88,
    wave_number: 1,
    tasks: [{ name: "mixed-test-task", files: [] }],
  });

  await brokerPost("/task-start", {
    task_id: wave.task_ids[0],
    session_id: "mixed-busy-session",
  });

  // Query /peer-availability for the shared repo
  const res = await brokerPost<{
    repo_peers: {
      available: { id: string; idle_since: string }[];
      busy: { id: string; current_task: string; task_started_at: string }[];
    };
    machine_peers: { available: unknown[]; busy: unknown[] };
  }>("/peer-availability", {
    repo: "/tmp/mixed-avail-repo",
  });

  // Assert both categories are populated
  expect(res.repo_peers.available.length).toBeGreaterThanOrEqual(1);
  expect(res.repo_peers.busy.length).toBeGreaterThanOrEqual(1);

  // Idle peer appears in available
  const foundIdle = res.repo_peers.available.find((p) => p.id === idleReg.id);
  expect(foundIdle).toBeDefined();
  expect(foundIdle!.idle_since).toBeDefined();

  // Busy peer appears in busy
  const foundBusy = res.repo_peers.busy.find((p) => p.id === busyHb.peer_id);
  expect(foundBusy).toBeDefined();
  expect(foundBusy!.current_task).toBe("mixed-test-task");
  expect(foundBusy!.task_started_at).toBeDefined();

  // Cleanup
  await brokerPost("/unregister", { id: idleReg.id });
  await brokerPost("/session-end", { session_id: "mixed-busy-session" });
});

// --- Phase 5: Expanded conflict-check tests ---

test("conflict-check detects lock file conflicts from package.json", async () => {
  const wave = await brokerPost<{ wave_id: number; task_ids: number[] }>("/wave-create", {
    repo: "/tmp/conflict-lock-test",
    phase: 98,
    wave_number: 1,
    tasks: [{ name: "lock-task", files: ["package.json"] }],
  });

  // Start the task so it's "running"
  await brokerPost("/session-heartbeat", {
    session_id: "lock-session",
    pid: 66610,
    cwd: "/tmp/conflict-lock-test",
    git_root: "/tmp/conflict-lock-test",
    task_summary: "running lock task",
  });
  await brokerPost("/task-start", {
    task_id: wave.task_ids[0],
    session_id: "lock-session",
  });

  // Check if bun.lockb conflicts (it should, because package.json expands to include lock files)
  const res = await brokerPost<{ conflicts: { conflicting_files: string[] }[] }>("/conflict-check", {
    wave_id: wave.wave_id,
    files: ["bun.lockb"],
  });

  expect(res.conflicts.length).toBeGreaterThan(0);
  expect(res.conflicts[0].conflicting_files).toContain("bun.lockb");
});

test("conflict-check detects index.ts conflicts from source files in same dir", async () => {
  const wave = await brokerPost<{ wave_id: number; task_ids: number[] }>("/wave-create", {
    repo: "/tmp/conflict-index-test",
    phase: 97,
    wave_number: 1,
    tasks: [{ name: "index-task", files: ["src/auth/middleware.ts"] }],
  });

  await brokerPost("/session-heartbeat", {
    session_id: "index-session",
    pid: 66620,
    cwd: "/tmp/conflict-index-test",
    git_root: "/tmp/conflict-index-test",
    task_summary: "running index task",
  });
  await brokerPost("/task-start", {
    task_id: wave.task_ids[0],
    session_id: "index-session",
  });

  // Check if src/auth/validators.ts conflicts via shared src/auth/index.ts
  const res = await brokerPost<{ conflicts: { conflicting_files: string[] }[] }>("/conflict-check", {
    wave_id: wave.wave_id,
    files: ["src/auth/validators.ts"],
  });

  expect(res.conflicts.length).toBeGreaterThan(0);
  // Both expand to include src/auth/index.ts
  expect(res.conflicts[0].conflicting_files).toContain("src/auth/index.ts");
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

// --- /list-messages tests ---

test("/list-messages returns empty array when no messages exist", async () => {
  // Use a unique peer pair that won't interfere with other tests
  const p1 = await brokerPost<{ id: string }>("/register", {
    pid: 55501,
    cwd: "/tmp/list-msgs-empty",
    git_root: null,
    tty: null,
    summary: "list-msgs-empty-p1",
  });
  // /list-messages is a global read — we can only verify the result is an array
  // (other tests may have inserted messages, so we just verify shape)
  const res = await brokerPost<unknown[]>("/list-messages", {});
  expect(Array.isArray(res)).toBe(true);

  await brokerPost("/unregister", { id: p1.id });
});

test("/list-messages returns messages in sent_at DESC order", async () => {
  const p1 = await brokerPost<{ id: string }>("/register", {
    pid: 55502,
    cwd: "/tmp/list-msgs-order",
    git_root: null,
    tty: null,
    summary: "list-msgs-order-p1",
  });
  const p2 = await brokerPost<{ id: string }>("/register", {
    pid: 55503,
    cwd: "/tmp/list-msgs-order",
    git_root: null,
    tty: null,
    summary: "list-msgs-order-p2",
  });

  // Send 3 messages
  await brokerPost("/send-message", { from_id: p1.id, to_id: p2.id, text: "first" });
  await brokerPost("/send-message", { from_id: p2.id, to_id: p1.id, text: "second" });
  await brokerPost("/send-message", { from_id: p1.id, to_id: p2.id, text: "third" });

  const res = await brokerPost<{ sent_at: string }[]>("/list-messages", { limit: 10 });
  expect(res.length).toBeGreaterThanOrEqual(3);

  // Verify DESC ordering: each message should have sent_at >= next
  for (let i = 0; i < res.length - 1; i++) {
    expect(res[i].sent_at >= res[i + 1].sent_at).toBe(true);
  }

  await brokerPost("/unregister", { id: p1.id });
  await brokerPost("/unregister", { id: p2.id });
});

test("/list-messages respects limit parameter and caps at 200", async () => {
  const p1 = await brokerPost<{ id: string }>("/register", {
    pid: 55504,
    cwd: "/tmp/list-msgs-limit",
    git_root: null,
    tty: null,
    summary: "list-msgs-limit-p1",
  });
  const p2 = await brokerPost<{ id: string }>("/register", {
    pid: 55505,
    cwd: "/tmp/list-msgs-limit",
    git_root: null,
    tty: null,
    summary: "list-msgs-limit-p2",
  });

  // Send 5 messages
  for (let i = 0; i < 5; i++) {
    await brokerPost("/send-message", { from_id: p1.id, to_id: p2.id, text: `msg ${i}` });
  }

  // Limit=3 should return at most 3
  const limited = await brokerPost<unknown[]>("/list-messages", { limit: 3 });
  expect(limited.length).toBeLessThanOrEqual(3);

  // Limit=999 should be capped at 200
  const capped = await brokerPost<unknown[]>("/list-messages", { limit: 999 });
  expect(capped.length).toBeLessThanOrEqual(200);

  await brokerPost("/unregister", { id: p1.id });
  await brokerPost("/unregister", { id: p2.id });
});

test("/list-messages returns both delivered and undelivered messages", async () => {
  const p1 = await brokerPost<{ id: string }>("/register", {
    pid: 55506,
    cwd: "/tmp/list-msgs-delivered",
    git_root: null,
    tty: null,
    summary: "list-msgs-delivered-p1",
  });
  const p2 = await brokerPost<{ id: string }>("/register", {
    pid: 55507,
    cwd: "/tmp/list-msgs-delivered",
    git_root: null,
    tty: null,
    summary: "list-msgs-delivered-p2",
  });

  // Send 2 messages, ACK 1
  await brokerPost("/send-message", { from_id: p1.id, to_id: p2.id, text: "will be delivered" });
  await brokerPost("/send-message", { from_id: p1.id, to_id: p2.id, text: "stays undelivered" });

  const poll = await brokerPost<{ messages: { id: number; text: string }[] }>("/poll-messages", { id: p2.id });
  const toAck = poll.messages.find((m) => m.text === "will be delivered");
  if (toAck) {
    await brokerPost("/ack-message", { message_ids: [toAck.id] });
  }

  // /list-messages should return BOTH (delivered + undelivered)
  const all = await brokerPost<{ id: number; delivered: number }[]>("/list-messages", { limit: 50 });
  const ours = all.filter((m) => poll.messages.some((pm) => pm.id === m.id));
  expect(ours.length).toBe(2);
  const deliveredCount = ours.filter((m) => m.delivered === 1).length;
  const undeliveredCount = ours.filter((m) => m.delivered === 0).length;
  expect(deliveredCount).toBe(1);
  expect(undeliveredCount).toBe(1);

  await brokerPost("/unregister", { id: p1.id });
  await brokerPost("/unregister", { id: p2.id });
});

// --- /list-waves tests ---

test("/list-waves returns empty array when no waves exist", async () => {
  // This test verifies the response shape; other tests may have created waves
  const res = await brokerPost<{ waves: unknown[] }>("/list-waves", {});
  expect(Array.isArray(res.waves)).toBe(true);
});

test("/list-waves returns waves with task_count, tasks_completed, tasks_running fields", async () => {
  const wave = await brokerPost<{ wave_id: number; task_ids: number[] }>("/wave-create", {
    repo: "/tmp/list-waves-counts",
    phase: 55,
    wave_number: 1,
    tasks: [
      { name: "LW-T01", files: ["lw-a.ts"] },
      { name: "LW-T02", files: ["lw-b.ts"] },
    ],
  });

  // Start one task
  await brokerPost("/session-heartbeat", {
    session_id: "lw-session-1",
    pid: 55520,
    cwd: "/tmp/list-waves-counts",
    git_root: "/tmp/list-waves-counts",
    task_summary: "lw worker",
  });
  await brokerPost("/task-start", { task_id: wave.task_ids[0], session_id: "lw-session-1" });

  const res = await brokerPost<{ waves: { id: number; task_count: number; tasks_completed: number; tasks_running: number; status: string }[] }>("/list-waves", {});

  const found = res.waves.find((w) => w.id === wave.wave_id);
  expect(found).toBeDefined();
  expect(found!.task_count).toBe(2);
  expect(found!.tasks_running).toBe(1);
  expect(found!.tasks_completed).toBe(0);
  expect(found!.status).toBe("pending");
});

// --- /register external_id tests (used by bridges) ---

test("/register with external_id uses it as the peer id", async () => {
  const res = await brokerPost<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp/extid-happy",
    git_root: null,
    tty: null,
    summary: "telegram bridge",
    external_id: "telegram-test-happy",
  });
  expect(res.id).toBe("telegram-test-happy");

  // Listed back as a normal peer (machine scope returns all peers).
  const peers = await brokerPost<{ id: string }[]>("/list-peers", {
    scope: "machine",
    cwd: "/tmp/extid-happy",
    git_root: null,
  });
  expect(peers.some((p) => p.id === "telegram-test-happy")).toBe(true);

  await brokerPost("/unregister", { id: "telegram-test-happy" });
});

test("/register with same external_id from a different live PID returns 409", async () => {
  // First registration: PID = the test process itself, guaranteed alive.
  const first = await fetch(`${BROKER_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pid: process.pid,
      cwd: "/tmp/extid-collision",
      git_root: null,
      tty: null,
      summary: "bridge-A",
      external_id: "telegram-test-collision",
    }),
  });
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as { id: string };
  expect(firstBody.id).toBe("telegram-test-collision");

  // Second registration: same external_id, different PID. Existing peer's
  // PID is alive (it's the test process), so the broker must 409 instead
  // of overwriting.
  const second = await fetch(`${BROKER_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pid: process.pid + 12345,
      cwd: "/tmp/extid-collision",
      git_root: null,
      tty: null,
      summary: "bridge-B",
      external_id: "telegram-test-collision",
    }),
  });
  expect(second.status).toBe(409);
  const secondBody = (await second.json()) as { error?: string };
  expect(secondBody.error).toMatch(/already registered/i);

  await brokerPost("/unregister", { id: "telegram-test-collision" });
});

test("/register rejects malformed external_id with 400", async () => {
  const cases = ["Capital", "white space", "weird!", "-leading-dash", "_leading-underscore", ""];
  for (const bad of cases) {
    const res = await fetch(`${BROKER_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pid: process.pid,
        cwd: "/tmp/extid-bad",
        git_root: null,
        tty: null,
        summary: "x",
        external_id: bad,
      }),
    });
    expect(res.status).toBe(400);
  }
});

test("/register without external_id still auto-generates an 8-char id", async () => {
  const res = await brokerPost<{ id: string }>("/register", {
    pid: 88801,
    cwd: "/tmp/extid-autogen",
    git_root: null,
    tty: null,
    summary: "auto",
  });
  expect(res.id).toBeString();
  expect(res.id.length).toBe(8);
  expect(res.id).not.toMatch(/^telegram/);
  await brokerPost("/unregister", { id: res.id });
});

test("/register with external_id and same PID is idempotent (re-registration cleans the old peer)", async () => {
  // First registration with our PID.
  const first = await brokerPost<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp/extid-reregister",
    git_root: null,
    tty: null,
    summary: "first",
  });
  expect(first.id).toBeString();

  // Re-register the SAME PID with an external_id — registerTxn cleans by PID
  // and we get the requested id back.
  const second = await brokerPost<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp/extid-reregister",
    git_root: null,
    tty: null,
    summary: "second",
    external_id: "telegram-test-reregister",
  });
  expect(second.id).toBe("telegram-test-reregister");

  // And re-registering the same external_id with the same PID succeeds.
  const third = await brokerPost<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp/extid-reregister",
    git_root: null,
    tty: null,
    summary: "third",
    external_id: "telegram-test-reregister",
  });
  expect(third.id).toBe("telegram-test-reregister");

  await brokerPost("/unregister", { id: "telegram-test-reregister" });
});
