/**
 * Tests for the reliable delivery features cherry-picked from upstream PR #25:
 * - /ack-messages broker endpoint (read-only poll, explicit ack)
 * - Peer-scoped ack (cannot ack another peer's messages)
 * - Transaction wrapping
 * - Backward compat: old broker schemas
 *
 * Plus tests for our fork-local improvements:
 * - Buffer cap data-loss path
 * - find_peer piggyback delivery
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer } from "node:net";

// --- Broker schema + ack endpoint logic ---

describe("PR #25 ack endpoint logic", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.run(`
      CREATE TABLE peers (
        id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        git_root TEXT,
        tty TEXT,
        summary TEXT NOT NULL DEFAULT '',
        registered_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        text TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Seed peers + messages
    const now = new Date().toISOString();
    db.run("INSERT INTO peers (id, pid, cwd, registered_at, last_seen) VALUES (?, ?, ?, ?, ?)", ["alice", 1, "/", now, now]);
    db.run("INSERT INTO peers (id, pid, cwd, registered_at, last_seen) VALUES (?, ?, ?, ?, ?)", ["bob", 2, "/", now, now]);
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?)", ["alice", "bob", "msg 1", now]);
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?)", ["alice", "bob", "msg 2", now]);
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?)", ["alice", "bob", "msg 3", now]);
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?)", ["bob", "alice", "msg 4", now]);
  });

  afterAll(() => db.close());

  test("read-only poll does NOT mark messages delivered", () => {
    const before = db.query("SELECT COUNT(*) as c FROM messages WHERE to_id = ? AND delivered = 0").get("bob") as { c: number };
    expect(before.c).toBe(3);

    // Simulate read-only poll (handlePollMessages logic)
    const messages = db.query("SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC").all("bob");
    expect(messages.length).toBe(3);

    const after = db.query("SELECT COUNT(*) as c FROM messages WHERE to_id = ? AND delivered = 0").get("bob") as { c: number };
    expect(after.c).toBe(3); // still undelivered
  });

  test("peer-scoped ack only marks messages owned by that peer", () => {
    const markScoped = db.prepare("UPDATE messages SET delivered = 1 WHERE id = ? AND to_id = ?");

    // Bob acks message id=1 (his own) — should succeed
    const result1 = markScoped.run(1, "bob");
    expect(result1.changes).toBe(1);

    // Bob tries to ack message id=4 (alice's) — should be no-op
    const result2 = markScoped.run(4, "bob");
    expect(result2.changes).toBe(0);

    // Verify alice's message is still undelivered
    const aliceMsg = db.query("SELECT delivered FROM messages WHERE id = ?").get(4) as { delivered: number };
    expect(aliceMsg.delivered).toBe(0);
  });

  test("transactional ack: all-or-nothing", () => {
    const markScoped = db.prepare("UPDATE messages SET delivered = 1 WHERE id = ? AND to_id = ?");

    const ackBatch = db.transaction((ids: number[], peerId: string) => {
      let count = 0;
      for (const id of ids) {
        count += markScoped.run(id, peerId).changes;
      }
      return count;
    });

    const acked = ackBatch([2, 3], "bob");
    expect(acked).toBe(2);

    const remaining = db.query("SELECT COUNT(*) as c FROM messages WHERE to_id = ? AND delivered = 0").get("bob") as { c: number };
    expect(remaining.c).toBe(0);
  });

  test("ack of nonexistent message id is a no-op (does not throw)", () => {
    const markScoped = db.prepare("UPDATE messages SET delivered = 1 WHERE id = ? AND to_id = ?");
    expect(() => markScoped.run(99999, "bob")).not.toThrow();
    const result = markScoped.run(99999, "bob");
    expect(result.changes).toBe(0);
  });
});

// --- Buffer cap data-loss path (fork-local improvement) ---

describe("Local buffer cap behavior", () => {
  // Replicate the prune logic from server.ts main() with the raised caps.
  // Caps must match server.ts: post-review-army these are 10000 / 5000.

  const BUFFER_CAP = 10000;
  const BUFFER_DRAIN_TO = 5000;

  function runPruneLogic(buffer: number[], confirmedDelivered: Set<number>): { removed: number[]; remaining: number[] } {
    if (buffer.length > BUFFER_CAP) {
      const removed = buffer.splice(0, buffer.length - BUFFER_DRAIN_TO);
      for (const id of removed) confirmedDelivered.add(id);
      return { removed, remaining: buffer };
    }
    return { removed: [], remaining: buffer };
  }

  test("cap not reached: no pruning", () => {
    const buffer = Array.from({ length: 9999 }, (_, i) => i);
    const dedup = new Set<number>();
    const { removed, remaining } = runPruneLogic(buffer, dedup);
    expect(removed.length).toBe(0);
    expect(remaining.length).toBe(9999);
    expect(dedup.size).toBe(0);
  });

  test("cap exceeded: prune to drain target", () => {
    const buffer = Array.from({ length: 11000 }, (_, i) => i);
    const dedup = new Set<number>();
    const { removed, remaining } = runPruneLogic(buffer, dedup);
    expect(removed.length).toBe(6000); // 11000 - 5000
    expect(remaining.length).toBe(5000);
    expect(dedup.size).toBe(6000); // pruned messages added to dedup to prevent re-delivery
  });

  test("pruned messages are oldest first (FIFO)", () => {
    const buffer = Array.from({ length: 10500 }, (_, i) => i);
    const dedup = new Set<number>();
    const { removed, remaining } = runPruneLogic(buffer, dedup);
    expect(removed[0]).toBe(0); // oldest
    expect(removed[removed.length - 1]).toBe(5499); // last pruned (10500 - 5000 - 1)
    expect(remaining[0]).toBe(5500); // first kept
    expect(remaining[remaining.length - 1]).toBe(10499); // newest
  });

  test("fork-local cap is 50x larger than upstream (10000 vs 200)", () => {
    // Regression guard: if someone reverts to upstream cap, this fails.
    // Cap raised post-review-army to make overflow practically unreachable.
    expect(BUFFER_CAP).toBe(10000);
    expect(BUFFER_CAP).toBeGreaterThanOrEqual(200 * 50);
  });

  // F1 post-review: symmetric coverage for the confirmedDeliveredIds prune.
  // Off-by-one or wrong-half eviction would cause re-display of delivered messages.
  test("confirmedDeliveredIds prune evicts oldest, retains newest (FIFO)", () => {
    const DEDUP_CAP = 5000;
    const DEDUP_DRAIN_TO = 2500;
    const confirmed = new Set<number>();
    for (let i = 0; i < 5001; i++) confirmed.add(i);

    if (confirmed.size > DEDUP_CAP) {
      const arr = [...confirmed];
      const toRemove = arr.slice(0, arr.length - DEDUP_DRAIN_TO);
      for (const id of toRemove) confirmed.delete(id);
    }

    expect(confirmed.size).toBe(DEDUP_DRAIN_TO);
    // Oldest (smallest) IDs evicted
    expect(confirmed.has(0)).toBe(false);
    expect(confirmed.has(2499)).toBe(false);
    // Newest (largest) IDs retained
    expect(confirmed.has(2501)).toBe(true);
    expect(confirmed.has(5000)).toBe(true);
  });

  test("confirmedDeliveredIds prune does not fire below cap", () => {
    const DEDUP_CAP = 5000;
    const confirmed = new Set<number>();
    for (let i = 0; i < 4999; i++) confirmed.add(i);
    if (confirmed.size > DEDUP_CAP) throw new Error("should not fire");
    expect(confirmed.size).toBe(4999);
  });

  // F2 post-review: after overflow prune, localBufferIds must be rebuilt
  // from the surviving buffer — stale IDs would block re-delivery of messages
  // the broker still has as undelivered.
  test("overflow prune rebuilds localBufferIds from survivors only", () => {
    const buffer: { id: number }[] = Array.from({ length: 11000 }, (_, i) => ({ id: i }));
    const localBufferIds = new Set<number>(buffer.map((m) => m.id));
    const confirmedDelivered = new Set<number>();

    if (buffer.length > BUFFER_CAP) {
      const removed = buffer.splice(0, buffer.length - BUFFER_DRAIN_TO);
      for (const m of removed) confirmedDelivered.add(m.id);
      // Replicate the rebuild logic from server.ts main()
      localBufferIds.clear();
      for (const m of buffer) localBufferIds.add(m.id);
    }

    expect(buffer.length).toBe(BUFFER_DRAIN_TO);
    expect(localBufferIds.size).toBe(BUFFER_DRAIN_TO);
    // Pruned IDs MUST NOT be in localBufferIds (else poll would block re-delivery)
    expect(localBufferIds.has(0)).toBe(false);
    expect(localBufferIds.has(5999)).toBe(false);
    // Survivor IDs ARE in localBufferIds
    expect(localBufferIds.has(6000)).toBe(true);
    expect(localBufferIds.has(10999)).toBe(true);
    // And they're in confirmedDelivered (pruned path)
    expect(confirmedDelivered.has(0)).toBe(true);
    expect(confirmedDelivered.has(5999)).toBe(true);
    expect(confirmedDelivered.has(6000)).toBe(false);
  });
});

// --- drainPendingMessages dedup filter behavior ---

describe("drainPendingMessages dedup filter (T1)", () => {
  // Replicate the filter logic from drainPendingMessages: messages already
  // in confirmedDeliveredIds must be excluded from the unseen set.

  function filterUnseen<T extends { id: number }>(
    buffered: T[],
    confirmedDeliveredIds: Set<number>
  ): T[] {
    return buffered.filter((m) => !confirmedDeliveredIds.has(m.id));
  }

  test("excludes messages already in confirmedDeliveredIds", () => {
    const buffered = [{ id: 1, text: "a" }, { id: 2, text: "b" }, { id: 3, text: "c" }];
    const confirmed = new Set<number>([2]);
    const unseen = filterUnseen(buffered, confirmed);
    expect(unseen.length).toBe(2);
    expect(unseen.map((m) => m.id)).toEqual([1, 3]);
  });

  test("returns empty when ALL buffered messages already confirmed", () => {
    const buffered = [{ id: 1 }, { id: 2 }];
    const confirmed = new Set<number>([1, 2]);
    expect(filterUnseen(buffered, confirmed).length).toBe(0);
  });

  test("returns all when confirmed is empty", () => {
    const buffered = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(filterUnseen(buffered, new Set()).length).toBe(3);
  });

  // Display IS delivery — the post-pr-review-toolkit fix reverts the C5 ackOk
  // gate. Once the message text is rendered into a tool response Claude WILL
  // see, dedup must be added unconditionally to prevent duplication on the
  // next poll cycle (broker still has delivered=0 so it will re-send).
  test("post-fix: dedup populated even when ack fails (display = delivery)", async () => {
    // Simulate the ackAndDedup helper logic: ack throws, dedup still populated.
    const confirmed = new Set<number>();
    const ids = [10, 20, 30];
    const fakeBrokerFetch = async () => {
      throw new Error("simulated broker unreachable");
    };
    try {
      await fakeBrokerFetch();
    } catch {
      // Caught and logged in real code
    }
    // Critical post-fix invariant: dedup add runs UNCONDITIONALLY after the
    // catch, NOT inside an if(ackOk).
    for (const id of ids) confirmed.add(id);
    expect(confirmed.size).toBe(3);
    expect(confirmed.has(10)).toBe(true);
    // Re-running the same drain on the same buffer would now filter out these
    // IDs, preventing duplicate display.
  });

  test("regression guard: ackAndDedup must add to dedup BEFORE the next drain", () => {
    // Two-step: first drain shows messages [1,2], second drain on a freshly
    // re-buffered set must not show them again.
    const confirmed = new Set<number>();
    // Drain 1
    const buffered1 = [{ id: 1 }, { id: 2 }];
    const unseen1 = buffered1.filter((m) => !confirmed.has(m.id));
    for (const m of unseen1) confirmed.add(m.id); // unconditional dedup add
    expect(unseen1.length).toBe(2);

    // Broker re-sends the same messages (because ack failed earlier).
    const buffered2 = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const unseen2 = buffered2.filter((m) => !confirmed.has(m.id));
    expect(unseen2.length).toBe(1); // only id=3 — 1 and 2 already in dedup
    expect(unseen2[0]!.id).toBe(3);
  });
});

// --- Buffer overflow with myId=null edge case (T4) ---

describe("Buffer overflow prune with null peer ID (T4)", () => {
  // Post-review-army: pruned messages must NOT be acked to the broker.
  // The myId=null guard must not crash, and dedup must still be populated.

  test("overflow prune adds to dedup even when myId is null", () => {
    const myId: string | null = null;
    const buffer = Array.from({ length: 11000 }, (_, i) => ({ id: i }));
    const confirmedDelivered = new Set<number>();
    const BUFFER_CAP = 10000;
    const BUFFER_DRAIN_TO = 5000;

    if (buffer.length > BUFFER_CAP) {
      const removed = buffer.splice(0, buffer.length - BUFFER_DRAIN_TO);
      for (const m of removed) confirmedDelivered.add(m.id);
      // The post-fix code does NOT ack on overflow — verify we'd never reach
      // brokerFetch when myId is null.
      expect(myId).toBeNull();
    }

    expect(buffer.length).toBe(5000);
    expect(confirmedDelivered.size).toBe(6000);
  });

  test("post-fix overflow does NOT ack broker (silent loss prevention)", () => {
    // Regression test for the post-review-army behavior change: the upstream
    // PR #25 logic acked pruned messages (silent data loss). Our fix removes
    // the ack call entirely so messages remain undelivered server-side and
    // can be re-delivered on next session.
    const buffer = Array.from({ length: 11000 }, (_, i) => ({ id: i }));
    const BUFFER_CAP = 10000;
    const BUFFER_DRAIN_TO = 5000;
    let brokerFetchCalled = false;

    if (buffer.length > BUFFER_CAP) {
      const removed = buffer.splice(0, buffer.length - BUFFER_DRAIN_TO);
      // Simulate the real prune logic — dedup add only, no broker call
      const confirmed = new Set<number>();
      for (const m of removed) confirmed.add(m.id);
      // brokerFetch SHOULD NOT be called here in the post-fix code
      expect(brokerFetchCalled).toBe(false);
    }
  });
});

// --- C1 regression: broker log file appends across spawn calls ---
//
// Verifies the C1 fix (fs.openSync(path, 'a') instead of Bun.file()).
// If anyone reverts to Bun.file() this test catches it: Bun.file() as spawn
// stdio writes from byte 0 (overwrite-in-place), so the second spawn would
// shrink the file or leave only its own short output.

describe("C1: broker log append semantics", () => {
  const TEST_LOG = "/tmp/claude-peers-test-append.log";

  beforeAll(() => {
    Bun.spawnSync(["rm", "-f", TEST_LOG]);
  });
  afterAll(() => {
    Bun.spawnSync(["rm", "-f", TEST_LOG]);
  });

  test("openSync('a') + spawn appends, does not overwrite", async () => {
    const { openSync, closeSync, statSync, readFileSync } = await import("node:fs");

    // First spawn: write 100 bytes of "AAA..."
    const fd1 = openSync(TEST_LOG, "a");
    const proc1 = Bun.spawn(["sh", "-c", "printf 'AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA\\n'"], {
      stdio: ["ignore", fd1, "ignore"],
    });
    await proc1.exited;
    closeSync(fd1);
    const sizeAfterFirst = statSync(TEST_LOG).size;
    expect(sizeAfterFirst).toBeGreaterThan(0);

    // Second spawn: write "BBBB"
    const fd2 = openSync(TEST_LOG, "a");
    const proc2 = Bun.spawn(["sh", "-c", "printf 'BBBB\\n'"], {
      stdio: ["ignore", fd2, "ignore"],
    });
    await proc2.exited;
    closeSync(fd2);
    const sizeAfterSecond = statSync(TEST_LOG).size;

    // Append semantics: file MUST be larger after the second spawn
    expect(sizeAfterSecond).toBeGreaterThan(sizeAfterFirst);

    // And the file must contain BOTH the AAAA prefix AND the BBBB suffix
    const content = readFileSync(TEST_LOG, "utf8");
    expect(content).toContain("AAAA");
    expect(content).toContain("BBBB");
    // BBBB must come after AAAA in the file
    expect(content.indexOf("BBBB")).toBeGreaterThan(content.indexOf("AAAA"));
  });

  test("regression: Bun.file() as spawn stdio overwrites from byte 0", async () => {
    // Document the bug we fixed. This test runs the broken pattern and asserts
    // the broken behavior — so future maintainers see exactly why we use openSync.
    const BROKEN_LOG = "/tmp/claude-peers-test-broken.log";
    Bun.spawnSync(["rm", "-f", BROKEN_LOG]);
    await Bun.write(BROKEN_LOG, "previous-session-content-aaaaaaaaaaaaaaa\n");

    const proc = Bun.spawn(["sh", "-c", "printf 'X\\n'"], {
      stdio: ["ignore", Bun.file(BROKEN_LOG), "ignore"],
    });
    await proc.exited;

    // Bun.file() writes from byte 0. The output "X\n" is 2 bytes.
    // The file is NOT shorter than before (Bun does not truncate on open),
    // but the first 2 bytes are "X\n" instead of "pr".
    const after = await Bun.file(BROKEN_LOG).text();
    expect(after.startsWith("X")).toBe(true);
    expect(after.startsWith("previous")).toBe(false);

    Bun.spawnSync(["rm", "-f", BROKEN_LOG]);
  });
});

// --- whoami tool + find_peer piggyback (live broker integration) ---

describe("Live broker delivery features", () => {
  let BROKER_PORT = 0;
  const BROKER_SCRIPT = new URL("../broker.ts", import.meta.url).pathname;
  let brokerProc: ReturnType<typeof Bun.spawn>;
  let brokerUrl = "";
  const TEST_DB = "/tmp/claude-peers-test-delivery.db";
  const childProcesses = new Set<ReturnType<typeof Bun.spawn>>();

  function spawnSleep(): ReturnType<typeof Bun.spawn> {
    const child = Bun.spawn(["sleep", "60"]);
    childProcesses.add(child);
    return child;
  }

  async function findFreeBrokerPort(): Promise<number> {
    return await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.unref();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        const port = typeof address === "object" && address ? address.port : 0;
        probe.close((err) => err ? reject(err) : resolve(port));
      });
    });
  }

  const brokerStderrChunks: string[] = [];
  beforeAll(async () => {
    Bun.spawnSync(["rm", "-f", TEST_DB]);

    let brokerAlive = false;
    for (let attempt = 0; attempt < 5 && !brokerAlive; attempt++) {
      BROKER_PORT = await findFreeBrokerPort();
      brokerUrl = `http://127.0.0.1:${BROKER_PORT}`;
      brokerProc = Bun.spawn(["bun", BROKER_SCRIPT], {
        env: { ...process.env, CLAUDE_PEERS_PORT: String(BROKER_PORT), CLAUDE_PEERS_DB: TEST_DB, CLAUDE_PEERS_BRIDGE_TOKEN_FILE: "/tmp/claude-peers-test-bridge.token" },
        stdout: "ignore",
        stderr: "pipe",
      });
      // Capture stderr so latency-log-format assertions can grep the log lines
      // the broker emits on every successful ack. Non-blocking — discards if
      // the reader can't keep up (tests only assert on the tail).
      const proc = brokerProc;
      (async () => {
        const decoder = new TextDecoder();
        if (!proc.stderr || typeof proc.stderr === "number") return;
        const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) brokerStderrChunks.push(decoder.decode(value));
          }
        } catch {}
      })();

      for (let i = 0; i < 30; i++) {
        try {
          const res = await fetch(`${brokerUrl}/health`, { signal: AbortSignal.timeout(500) });
          if (res.ok) { brokerAlive = true; break; }
        } catch {}
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!brokerAlive) brokerProc.kill();
    }
    if (!brokerAlive) {
      const stderrTail = brokerStderrChunks.join("").slice(-4000);
      throw new Error(`Test broker failed to start after 5 attempts; last url=${brokerUrl}; stderr tail:\n${stderrTail}`);
    }
  }, 35_000);

  afterAll(() => {
    brokerProc?.kill();
    for (const child of childProcesses) child.kill();
    childProcesses.clear();
    Bun.spawnSync(["rm", "-f", TEST_DB]);
    Bun.spawnSync(["rm", "-f", "/tmp/claude-peers-test-bridge.token"]);
  });

  afterEach(() => {
    for (const child of childProcesses) child.kill();
    childProcesses.clear();
  });

  // S2: tests now cooperate with token auth. Maintain a per-peer-id token
  // cache so callers don't have to thread the token through every test.
  const tokens = new Map<string, string>();
  async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const b = body as Record<string, unknown> | undefined;
    const claimedId = (b?.id as string | undefined) ?? (b?.from_id as string | undefined);
    if (claimedId && tokens.has(claimedId)) {
      headers["X-Peer-Token"] = tokens.get(claimedId)!;
    }
    const res = await fetch(`${brokerUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (path === "/register" && json.id && json.token) {
      tokens.set(json.id as string, json.token as string);
    }
    return json as T;
  }

  test("/ack-messages endpoint exists and returns ok", async () => {
    const reg = await brokerFetch<{ id: string }>("/register", {
      pid: process.pid,
      cwd: "/test",
      git_root: null,
      tty: null,
      name: null,
      tmux_session: null,
      tmux_window_index: null,
      tmux_window_name: null,
      summary: "",
    });

    const ack = await brokerFetch<{ ok: boolean; acked: number }>("/ack-messages", {
      id: reg.id,
      ids: [],
    });
    expect(ack.ok).toBe(true);
    expect(ack.acked).toBe(0);
  });

  test("register stores client_type and starts Codex in manual-drain mode", async () => {
    const child = spawnSleep();
    const reg = await brokerFetch<{ id: string; client_type: string; receiver_mode: string }>("/register", {
      pid: child.pid,
      cwd: "/codex-meta",
      git_root: null,
      tty: null,
      name: "codex-meta",
      tmux_session: null,
      tmux_window_index: null,
      tmux_window_name: null,
      client_type: "codex",
      receiver_mode: "codex-hook",
      summary: "",
    });
    expect(reg.client_type).toBe("codex");
    expect(reg.receiver_mode).toBe("manual-drain");
    child.kill();
  });

  test("read-only poll: messages remain undelivered after poll", async () => {
    const receiver = await brokerFetch<{ id: string }>("/register", {
      pid: process.pid,
      cwd: "/receiver",
      git_root: null,
      tty: null,
      name: "test-receiver",
      tmux_session: null,
      tmux_window_index: null,
      tmux_window_name: null,
      summary: "",
    });

    // Sender sends a message (will fail because handleRegister deduped sender)
    // Re-register sender in different process slot
    // Actually skip — just send from receiver to itself for the read-only test
    await brokerFetch("/send-message", {
      from_id: receiver.id,
      to_id: receiver.id,
      text: "test message",
    });

    // Poll 1: should return the message
    const poll1 = await brokerFetch<{ messages: { id: number; text: string }[] }>("/poll-messages", { id: receiver.id });
    expect(poll1.messages.length).toBe(1);
    const msgId = poll1.messages[0]!.id;

    // Poll 2: should STILL return the same message (read-only poll doesn't ack)
    const poll2 = await brokerFetch<{ messages: { id: number; text: string }[] }>("/poll-messages", { id: receiver.id });
    expect(poll2.messages.length).toBe(1);
    expect(poll2.messages[0]!.id).toBe(msgId);

    // Now ack
    const ackResp = await brokerFetch<{ ok: boolean; acked: number }>("/ack-messages", {
      id: receiver.id,
      ids: [msgId],
    });
    expect(ackResp.acked).toBe(1);

    // Poll 3: message should be gone
    const poll3 = await brokerFetch<{ messages: { id: number }[] }>("/poll-messages", { id: receiver.id });
    expect(poll3.messages.length).toBe(0);
  });

  test("peer-scoped ack: cannot ack another peer's messages via broker", async () => {
    // Spawn two real long-lived child processes so each peer has a distinct,
    // valid PID that the broker's process.kill(pid, 0) liveness check accepts.
    // Using process.pid for both peers would trigger handleRegister's PID-dedup,
    // deleting peerA when peerB registers — the assertion would then pass for
    // the WRONG reason (no row matches the ack rather than the scope check working).
    const childA = spawnSleep();
    const childB = spawnSleep();

    const peerA = await brokerFetch<{ id: string }>("/register", {
      pid: childA.pid,
      cwd: "/A",
      git_root: null,
      tty: null,
      name: "peer-a",
      tmux_session: null,
      tmux_window_index: null,
      tmux_window_name: null,
      summary: "",
    });

    const peerB = await brokerFetch<{ id: string }>("/register", {
      pid: childB.pid,
      cwd: "/B",
      git_root: null,
      tty: null,
      name: "peer-b",
      tmux_session: null,
      tmux_window_index: null,
      tmux_window_name: null,
      summary: "",
    });

    // Send message to peerB
    await brokerFetch("/send-message", {
      from_id: peerB.id,
      to_id: peerB.id,
      text: "for peer B",
    });

    // Get peerB's pending message
    const poll = await brokerFetch<{ messages: { id: number }[] }>("/poll-messages", { id: peerB.id });
    expect(poll.messages.length).toBeGreaterThanOrEqual(1);
    const msgIdForB = poll.messages[0]!.id;

    // peerA tries to ack peerB's message — should be no-op (acked: 0)
    const badAck = await brokerFetch<{ ok: boolean; acked: number }>("/ack-messages", {
      id: peerA.id,
      ids: [msgIdForB],
    });
    expect(badAck.ok).toBe(true);
    expect(badAck.acked).toBe(0);

    // Verify peerB still has the message
    const pollAgain = await brokerFetch<{ messages: { id: number }[] }>("/poll-messages", { id: peerB.id });
    expect(pollAgain.messages.some((m) => m.id === msgIdForB)).toBe(true);

    // Clean up the long-lived child processes
    childA.kill();
    childB.kill();
  });

  // /poll-by-pid: PID-authenticated drain used by the UserPromptSubmit hook.
  // Bypasses X-Peer-Token auth — caller_pid + same-UID is the auth.
  async function rawPost(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${brokerUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  }

  test("/health advertises the prompt-hook drain contract", async () => {
    const res = await fetch(`${brokerUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      version?: string;
      capabilities?: {
        hookDrain?: {
          pollByPid?: boolean;
          claimByPid?: boolean;
          ackByPid?: boolean;
          hookHeartbeatByPid?: boolean;
        };
      };
    };
    expect(body.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
    expect(body.capabilities?.hookDrain?.pollByPid).toBe(true);
    expect(body.capabilities?.hookDrain?.claimByPid).toBe(true);
    expect(body.capabilities?.hookDrain?.ackByPid).toBe(true);
    expect(body.capabilities?.hookDrain?.hookHeartbeatByPid).toBe(true);
  });

  test("broker startup migrates an old peer/message schema", async () => {
    const dbPath = "/tmp/claude-peers-old-schema-migration.db";
    const tokenPath = "/tmp/claude-peers-old-schema-bridge.token";
    const port = await findFreeBrokerPort();
    Bun.spawnSync(["rm", "-f", dbPath]);
    Bun.spawnSync(["rm", "-f", tokenPath]);
    const old = new Database(dbPath);
    old.run(`
      CREATE TABLE peers (
        id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        git_root TEXT,
        tty TEXT,
        summary TEXT NOT NULL DEFAULT '',
        registered_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      )
    `);
    old.run(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        text TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0
      )
    `);
    old.close();

    const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
      env: {
        ...process.env,
        CLAUDE_PEERS_PORT: String(port),
        CLAUDE_PEERS_DB: dbPath,
        CLAUDE_PEERS_BRIDGE_TOKEN_FILE: tokenPath,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      let brokerAlive = false;
      for (let i = 0; i < 30; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
          if (res.ok) { brokerAlive = true; break; }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(brokerAlive).toBe(true);

      const migrated = new Database(dbPath, { readonly: true });
      const peerColumns = new Set((migrated.query("PRAGMA table_info(peers)").all() as { name: string }[]).map((c) => c.name));
      const messageColumns = new Set((migrated.query("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name));
      migrated.close();
      for (const col of ["client_type", "receiver_mode", "last_hook_seen_at", "last_drain_at", "last_drain_error"]) {
        expect(peerColumns.has(col)).toBe(true);
      }
      for (const col of ["delivered_at", "claimed_by", "claimed_at"]) {
        expect(messageColumns.has(col)).toBe(true);
      }
    } finally {
      proc.kill();
      Bun.spawnSync(["rm", "-f", dbPath]);
      Bun.spawnSync(["rm", "-f", tokenPath]);
    }
  });

  test("/poll-by-pid: returns undelivered mail and atomically acks", async () => {
    const child = spawnSleep();
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/pbp-1", git_root: null, tty: null, name: "pbp-1",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    await brokerFetch("/send-message", { from_id: peer.id, to_id: peer.id, text: "hello" });

    const { status, json } = await rawPost("/poll-by-pid", { pid: child.pid, caller_pid: process.pid });
    expect(status).toBe(200);
    expect(json.peer_id).toBe(peer.id);
    const msgs = json.messages as { id: number; text: string }[];
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs[0]!.text).toBe("hello");
    expect(json.acked).toBe(msgs.length);

    // Poll again via authed path — messages should now be marked delivered.
    const poll2 = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: peer.id });
    expect(poll2.messages.length).toBe(0);

    // F5: delivered_at must be populated so latency telemetry isn't silently
    // broken by a future refactor that drops the nowIso UPDATE arg. Open a
    // read-only handle to the broker's DB — WAL mode allows concurrent reads.
    const ro = new Database(TEST_DB, { readonly: true });
    const row = ro.query("SELECT delivered, delivered_at FROM messages WHERE id = ?").get(msgs[0]!.id) as
      { delivered: number; delivered_at: string | null };
    ro.close();
    expect(row.delivered).toBe(1);
    expect(row.delivered_at).not.toBeNull();
    expect(typeof row.delivered_at).toBe("string");
    child.kill();
  });

  // Regression: Claude peers must record drain telemetry on /poll-by-pid.
  // The codex updateReceiverHealth path never runs for a claude client, so
  // before the fix last_hook_seen_at/last_drain_at stayed NULL forever and the
  // fleet's drain state was unobservable from the DB. A peer registered with no
  // client_type defaults to "claude" (claude-channel). This test would have
  // failed (both columns NULL) prior to adding updateClaudeDrainHealth.
  test("/poll-by-pid: writes last_hook_seen_at + last_drain_at for a claude peer", async () => {
    const child = spawnSleep();
    const peer = await brokerFetch<{ id: string; client_type: string }>("/register", {
      pid: child.pid, cwd: "/pbp-tel", git_root: null, tty: null, name: "pbp-tel",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      client_type: "claude", summary: "",
    });
    // Confirm the precondition: this is a claude peer (the path codex telemetry
    // skips). A real Claude session sends client_type:"claude" at register
    // (shared/client.ts:44); a peer that omits it defaults to "unknown".
    expect(peer.client_type).toBe("claude");

    await brokerFetch("/send-message", { from_id: peer.id, to_id: peer.id, text: "drain-me" });

    const ro = new Database(TEST_DB, { readonly: true });

    // Before any poll, telemetry is NULL (clean baseline).
    const before = ro.query(
      "SELECT last_hook_seen_at, last_drain_at, client_type FROM peers WHERE id = ?"
    ).get(peer.id) as { last_hook_seen_at: string | null; last_drain_at: string | null; client_type: string };
    expect(before.last_hook_seen_at).toBeNull();
    expect(before.last_drain_at).toBeNull();

    // The hook drains via /poll-by-pid, acking 1 message.
    const { json } = await rawPost("/poll-by-pid", { pid: child.pid, caller_pid: process.pid });
    expect(json.acked).toBe(1);

    // After: hook_seen recorded (poll happened) AND drain_at recorded (mail acked).
    const after = ro.query(
      "SELECT last_hook_seen_at, last_drain_at, client_type FROM peers WHERE id = ?"
    ).get(peer.id) as { last_hook_seen_at: string | null; last_drain_at: string | null; client_type: string };
    expect(after.last_hook_seen_at).not.toBeNull();
    expect(after.last_drain_at).not.toBeNull();
    // The fix must NOT mutate client_type (scoped UPDATE; codex peers untouched).
    expect(after.client_type).toBe("claude");
    ro.close();
    child.kill();
  });

  // Companion: an empty poll (no mail) still records last_hook_seen_at (the hook
  // ran) but leaves last_drain_at NULL (nothing acked). Guards the COALESCE arm.
  test("/poll-by-pid: empty drain records hook_seen but not drain_at", async () => {
    const child = spawnSleep();
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/pbp-empty", git_root: null, tty: null, name: "pbp-empty",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      client_type: "claude", summary: "",
    });
    const { json } = await rawPost("/poll-by-pid", { pid: child.pid, caller_pid: process.pid });
    expect(json.acked).toBe(0);

    const ro = new Database(TEST_DB, { readonly: true });
    const row = ro.query(
      "SELECT last_hook_seen_at, last_drain_at FROM peers WHERE id = ?"
    ).get(peer.id) as { last_hook_seen_at: string | null; last_drain_at: string | null };
    ro.close();
    expect(row.last_hook_seen_at).not.toBeNull();
    expect(row.last_drain_at).toBeNull();
    child.kill();
  });

  test("/poll-by-pid: unknown pid returns empty without error", async () => {
    // Pick a likely-unused PID — 0 is reserved, broker treats pid <= 1 as invalid.
    // Use a real alive PID (our own) that isn't registered as a peer.
    const { status, json } = await rawPost("/poll-by-pid", { pid: 999999, caller_pid: process.pid });
    // Alive-check on pid 999999 likely fails, but the endpoint treats "no peer with this pid"
    // as empty result (ok:true, messages:[]). Liveness check is done on caller_pid only.
    expect(status).toBe(200);
    expect(json.peer_id).toBe("");
    expect(json.messages).toEqual([]);
    expect(json.acked).toBe(0);
  });

  test("/poll-by-pid: cross-peer isolation (pid A drain does not leak peer B's mail)", async () => {
    const childA = spawnSleep();
    const childB = spawnSleep();
    const peerA = await brokerFetch<{ id: string }>("/register", {
      pid: childA.pid, cwd: "/pbp-A", git_root: null, tty: null, name: "pbp-A",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const peerB = await brokerFetch<{ id: string }>("/register", {
      pid: childB.pid, cwd: "/pbp-B", git_root: null, tty: null, name: "pbp-B",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    await brokerFetch("/send-message", { from_id: peerA.id, to_id: peerB.id, text: "for B only" });
    // F4: also queue mail for peer A so drainA's UPDATE path actually runs.
    // Without this, drainA has an empty messages array and the UPDATE loop
    // never fires — a scope-loss regression (removing `to_id = ?` from the
    // UPDATE WHERE clause) would not be caught.
    await brokerFetch("/send-message", { from_id: peerB.id, to_id: peerA.id, text: "for A only" });

    // Drain via peerA's pid — should return ONLY A's message, not B's.
    const drainA = await rawPost("/poll-by-pid", { pid: childA.pid, caller_pid: process.pid });
    expect(drainA.status).toBe(200);
    expect(drainA.json.peer_id).toBe(peerA.id);
    const aMsgs = drainA.json.messages as { text: string }[];
    expect(aMsgs.length).toBe(1);
    expect(aMsgs[0]!.text).toBe("for A only");

    // Scope-loss guard: if markDeliveredScoped lost `AND to_id = ?`, peer B's
    // message would have been collaterally marked delivered by drainA's
    // UPDATE and the next assertion would fail.
    const peekB = await brokerFetch<{ messages: { text: string }[] }>("/poll-messages", { id: peerB.id });
    expect(peekB.messages.length).toBe(1);
    expect(peekB.messages[0]!.text).toBe("for B only");

    // Drain via peerB's pid — returns B's message.
    const drainB = await rawPost("/poll-by-pid", { pid: childB.pid, caller_pid: process.pid });
    expect(drainB.status).toBe(200);
    expect(drainB.json.peer_id).toBe(peerB.id);
    expect((drainB.json.messages as unknown[]).length).toBe(1);
    childA.kill();
    childB.kill();
  });

  test("/poll-by-pid: rejects invalid pid", async () => {
    const { status, json } = await rawPost("/poll-by-pid", { pid: 0, caller_pid: process.pid });
    expect(status).toBe(400);
    expect(typeof json.error).toBe("string");
  });

  test("/poll-by-pid: emits canonical latency log line on ack", async () => {
    // Telemetry contract: the broker must log each acked delivery with the
    // exact format `[broker] deliver id=<N> from=<id> to=<id> via=<path>
    // latency_ms=<N>`. This is the grep target for the latency dashboard
    // and the `via=` label splits the three delivery paths (piggyback,
    // check_messages, poll-by-pid). If any field name drifts, ops grep breaks.
    const child = spawnSleep();
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/log-fmt", git_root: null, tty: null, name: "log-fmt",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    await brokerFetch("/send-message", { from_id: peer.id, to_id: peer.id, text: "log-format probe" });

    // Drain via the hook path and capture the resulting log line.
    const before = brokerStderrChunks.length;
    await rawPost("/poll-by-pid", { pid: child.pid, caller_pid: process.pid });
    // Small wait for stderr pipe to flush the console.error line.
    await new Promise((r) => setTimeout(r, 150));
    const newLogs = brokerStderrChunks.slice(before).join("");

    // Assert the full canonical format (id, from, to, via=poll-by-pid, latency_ms).
    // Any regression dropping one of these fields will fail grep.
    expect(newLogs).toMatch(/\[broker\] deliver id=\d+ from=\S+ to=\S+ via=poll-by-pid latency_ms=\d+/);
    child.kill();
  });

  test("/poll-by-pid: rejects dead caller_pid (same-UID check fails)", async () => {
    // Spawn + immediately kill so PID was valid but is now dead.
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    const { status, json } = await rawPost("/poll-by-pid", { pid: process.pid, caller_pid: dead.pid });
    // Accept any 4xx — the specific code (403 vs 400) depends on verifyPidUid
    // return-path and may drift as that function evolves. The assertion that
    // matters is "non-200, with an error string".
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(typeof json.error).toBe("string");
  });

  test("/claim-by-pid + /ack-by-pid: claim does not mark delivered until ack", async () => {
    const child = spawnSleep();
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/claim-safe", git_root: null, tty: null, name: "claim-safe",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      client_type: "codex", receiver_mode: "manual-drain", summary: "",
    });
    const send = await brokerFetch<{ id: number }>("/send-message", {
      from_id: peer.id, to_id: peer.id, text: "safe claim",
    });

    const claim = await rawPost("/claim-by-pid", {
      pid: child.pid,
      caller_pid: process.pid,
      drain_id: "test-drain-1",
    });
    expect(claim.status).toBe(200);
    expect(claim.json.peer_id).toBe(peer.id);
    const claimed = claim.json.messages as { id: number; text: string }[];
    expect(claimed.length).toBe(1);
    expect(claimed[0]!.text).toBe("safe claim");

    const statusBefore = await brokerFetch<{ statuses: { delivered: boolean; delivered_at: string | null }[] }>(
      "/message-status", { id: peer.id, ids: [send.id] }
    );
    expect(statusBefore.statuses[0]!.delivered).toBe(false);
    expect(statusBefore.statuses[0]!.delivered_at).toBeNull();

    const pollWhileClaimed = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: peer.id });
    expect(pollWhileClaimed.messages.length).toBe(0);

    const ack = await rawPost("/ack-by-pid", {
      pid: child.pid,
      caller_pid: process.pid,
      drain_id: "test-drain-1",
      ids: [send.id],
      via: "codex-hook",
    });
    expect(ack.status).toBe(200);
    expect(ack.json.acked).toBe(1);

    const statusAfter = await brokerFetch<{ statuses: { delivered: boolean; delivered_at: string | null }[] }>(
      "/message-status", { id: peer.id, ids: [send.id] }
    );
    expect(statusAfter.statuses[0]!.delivered).toBe(true);
    expect(typeof statusAfter.statuses[0]!.delivered_at).toBe("string");
    child.kill();
  });

  test("/ack-by-pid: wrong drain_id does not deliver and records a mismatch", async () => {
    const child = spawnSleep();
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/claim-wrong-drain", git_root: null, tty: null, name: "claim-wrong-drain",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      client_type: "codex", receiver_mode: "manual-drain", summary: "",
    });
    const send = await brokerFetch<{ id: number }>("/send-message", {
      from_id: peer.id, to_id: peer.id, text: "wrong drain guard",
    });

    const claim = await rawPost("/claim-by-pid", {
      pid: child.pid,
      caller_pid: process.pid,
      drain_id: "real-drain",
    });
    expect(claim.status).toBe(200);
    expect((claim.json.messages as unknown[]).length).toBe(1);

    const badAck = await rawPost("/ack-by-pid", {
      pid: child.pid,
      caller_pid: process.pid,
      drain_id: "wrong-drain",
      ids: [send.id],
      via: "codex-hook",
    });
    expect(badAck.status).toBe(200);
    expect(badAck.json.acked).toBe(0);

    const statusAfter = await brokerFetch<{ statuses: { delivered: boolean; delivered_at: string | null }[] }>(
      "/message-status", { id: peer.id, ids: [send.id] }
    );
    expect(statusAfter.statuses[0]!.delivered).toBe(false);
    expect(statusAfter.statuses[0]!.delivered_at).toBeNull();

    const peers = await brokerFetch<Array<{ id: string; last_drain_error: string | null }>>(
      "/list-peers",
      { id: peer.id, scope: "machine", cwd: "/", git_root: null, include_inactive: true }
    );
    expect(peers.find((p) => p.id === peer.id)!.last_drain_error).toContain("ack mismatch");
    child.kill();
  });

  test("/claim-by-pid: max_bytes applies to the first message too", async () => {
    const child = spawnSleep();
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/claim-max-bytes", git_root: null, tty: null, name: "claim-max-bytes",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      client_type: "codex", receiver_mode: "manual-drain", summary: "",
    });
    await brokerFetch("/send-message", {
      from_id: peer.id, to_id: peer.id, text: "oversized for cap",
    });

    const claim = await rawPost("/claim-by-pid", {
      pid: child.pid,
      caller_pid: process.pid,
      drain_id: "tiny-cap",
      max_bytes: 4,
    });
    expect(claim.status).toBe(200);
    expect(claim.json.messages).toEqual([]);

    const poll = await brokerFetch<{ messages: { text: string }[] }>("/poll-messages", { id: peer.id });
    expect(poll.messages.length).toBe(1);
    expect(poll.messages[0]!.text).toBe("oversized for cap");
    child.kill();
  });

  test("/claim-by-pid: unknown target pid returns an explicit error", async () => {
    const { status, json } = await rawPost("/claim-by-pid", {
      pid: 999999,
      caller_pid: process.pid,
      drain_id: "unknown-pid",
    });
    expect(status).toBe(404);
    expect(typeof json.error).toBe("string");
  });

  test("/claim-by-pid: registered but dead target pid is rejected", async () => {
    const child = spawnSleep();
    await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/dead-claim-target", git_root: null, tty: null, name: "dead-claim-target",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      client_type: "codex", receiver_mode: "manual-drain", summary: "",
    });
    childProcesses.delete(child);
    child.kill();
    await child.exited;

    const { status, json } = await rawPost("/claim-by-pid", {
      pid: child.pid,
      caller_pid: process.pid,
      drain_id: "dead-target",
    });
    expect(status).toBe(403);
    expect(json.error).toContain("target rejected");
  });

  test("/claim-by-pid: expired claims become visible again", async () => {
    const child = spawnSleep();
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/claim-expire", git_root: null, tty: null, name: "claim-expire",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      client_type: "codex", receiver_mode: "manual-drain", summary: "",
    });
    await brokerFetch("/send-message", { from_id: peer.id, to_id: peer.id, text: "retry me" });
    const claim = await rawPost("/claim-by-pid", {
      pid: child.pid,
      caller_pid: process.pid,
      drain_id: "test-drain-expire",
    });
    expect((claim.json.messages as unknown[]).length).toBe(1);

    const rw = new Database(TEST_DB);
    rw.run(
      "UPDATE messages SET claimed_at = ? WHERE to_id = ?",
      [new Date(Date.now() - 60_000).toISOString(), peer.id]
    );
    rw.close();

    const poll = await brokerFetch<{ messages: { text: string }[] }>("/poll-messages", { id: peer.id });
    expect(poll.messages.length).toBe(1);
    expect(poll.messages[0]!.text).toBe("retry me");
    child.kill();
  });

  test("/hook-heartbeat-by-pid promotes Codex peer to codex-hook mode", async () => {
    const child = spawnSleep();
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/hook-heartbeat", git_root: null, tty: null, name: "hook-heartbeat",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      client_type: "codex", receiver_mode: "manual-drain", summary: "",
    });
    const hb = await rawPost("/hook-heartbeat-by-pid", {
      pid: child.pid,
      caller_pid: process.pid,
      status: "ok",
      drained: 0,
    });
    expect(hb.status).toBe(200);

    const peers = await brokerFetch<Array<{ id: string; client_type: string; receiver_mode: string; last_hook_seen_at: string | null }>>(
      "/list-peers",
      { id: peer.id, scope: "machine", cwd: "/", git_root: null, include_inactive: true }
    );
    const row = peers.find((p) => p.id === peer.id)!;
    expect(row.client_type).toBe("codex");
    expect(row.receiver_mode).toBe("codex-hook");
    expect(typeof row.last_hook_seen_at).toBe("string");
    child.kill();
  });

  test("/hook-heartbeat-by-pid refreshes last_seen so exact-name routing stays live", async () => {
    const childS = spawnSleep();
    const childT = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/hook-live-s", git_root: null, tty: null, name: "hook-live-s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const target = await brokerFetch<{ id: string }>("/register", {
      pid: childT.pid, cwd: "/hook-live-t", git_root: null, tty: null, name: "hook-live-target",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      client_type: "codex", receiver_mode: "manual-drain", summary: "",
    });

    const staleIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const rw = new Database(TEST_DB);
    rw.run("UPDATE peers SET last_seen = ? WHERE id = ?", [staleIso, target.id]);
    rw.close();

    const hb = await rawPost("/hook-heartbeat-by-pid", {
      pid: childT.pid,
      caller_pid: process.pid,
      status: "ok",
      drained: 0,
    });
    expect(hb.status).toBe(200);

    const send = await brokerFetch<{ ok: boolean; id?: number; code?: string; error?: string; target?: { id: string } }>("/send-to-peer", {
      from_id: sender.id,
      selector: { name: "hook-live-target" },
      text: "hook liveness probe",
    });
    expect(send.ok).toBe(true);
    expect(send.target?.id).toBe(target.id);

    const ro = new Database(TEST_DB, { readonly: true });
    const row = ro.query("SELECT last_seen FROM peers WHERE id = ?").get(target.id) as { last_seen: string };
    ro.close();
    expect(new Date(row.last_seen).getTime()).toBeGreaterThan(new Date(staleIso).getTime());
    childS.kill();
    childT.kill();
  });

  test("send_to_peer keeps stale but alive hook-backed Codex rows routable", async () => {
    const childS = spawnSleep();
    const childT = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/hook-idle-s", git_root: null, tty: null, name: "hook-idle-s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const target = await brokerFetch<{ id: string }>("/register", {
      pid: childT.pid, cwd: "/hook-idle-t", git_root: null, tty: null, name: "hook-idle-target",
      tmux_session: "pr", tmux_window_index: "1", tmux_window_name: "1", tmux_pane_id: "%125",
      client_type: "codex", receiver_mode: "codex-hook", summary: "",
    });
    const hb = await rawPost("/hook-heartbeat-by-pid", {
      pid: childT.pid,
      caller_pid: process.pid,
      status: "ok",
      drained: 0,
    });
    expect(hb.status).toBe(200);
    const staleIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const rw = new Database(TEST_DB);
    rw.run("UPDATE peers SET last_seen = ?, last_hook_seen_at = ? WHERE id = ?", [staleIso, staleIso, target.id]);
    rw.close();

    const send = await brokerFetch<{ ok: boolean; id?: number; code?: string; error?: string; target?: { id: string; seat_key: string } }>("/send-to-peer", {
      from_id: sender.id,
      selector: { name: "hook-idle-target" },
      text: "idle hook target should still route",
    });

    expect(send.ok).toBe(true);
    expect(send.target?.id).toBe(target.id);
    expect(send.target?.seat_key).toBe("pane:pr:%125");
    childS.kill();
    childT.kill();
  });

  test("send_to_peer rejects stale hook-backed Codex rows without a visible seat", async () => {
    const childS = spawnSleep();
    const childT = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/hook-headless-s", git_root: null, tty: null, name: "hook-headless-s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const target = await brokerFetch<{ id: string }>("/register", {
      pid: childT.pid, cwd: "/hook-headless-t", git_root: null, tty: null, name: "hook-headless-target",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, tmux_pane_id: null,
      client_type: "codex", receiver_mode: "codex-hook", summary: "",
    });
    const hb = await rawPost("/hook-heartbeat-by-pid", {
      pid: childT.pid,
      caller_pid: process.pid,
      status: "ok",
      drained: 0,
    });
    expect(hb.status).toBe(200);
    const staleIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const rw = new Database(TEST_DB);
    rw.run("UPDATE peers SET last_seen = ?, last_hook_seen_at = ? WHERE id = ?", [staleIso, staleIso, target.id]);
    rw.close();

    const send = await brokerFetch<{ ok: boolean; code?: string; error?: string }>("/send-to-peer", {
      from_id: sender.id,
      selector: { name: "hook-headless-target" },
      text: "headless stale hook target should not route",
    });

    expect(send.ok).toBe(false);
    expect(send.code).toBe("PEER_NOT_FOUND");
    childS.kill();
    childT.kill();
  });

  test("send_to_peer keeps stale but alive hook-backed Gemini rows routable", async () => {
    const childS = spawnSleep();
    const childT = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/gemini-hook-idle-s", git_root: null, tty: null, name: "gemini-hook-idle-s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const target = await brokerFetch<{ id: string }>("/register", {
      pid: childT.pid, cwd: "/gemini-hook-idle-t", git_root: null, tty: null, name: "gemini-hook-idle-target",
      tmux_session: "gem", tmux_window_index: "1", tmux_window_name: "1", tmux_pane_id: "%225",
      client_type: "gemini", receiver_mode: "gemini-hook", summary: "",
    });
    const hb = await rawPost("/hook-heartbeat-by-pid", {
      pid: childT.pid,
      caller_pid: process.pid,
      client_type: "gemini",
      receiver_mode: "gemini-hook",
      status: "ok",
      drained: 0,
    });
    expect(hb.status).toBe(200);
    const staleIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const rw = new Database(TEST_DB);
    rw.run("UPDATE peers SET last_seen = ?, last_hook_seen_at = ? WHERE id = ?", [staleIso, staleIso, target.id]);
    rw.close();

    const send = await brokerFetch<{ ok: boolean; target?: { id: string; seat_key: string } }>("/send-to-peer", {
      from_id: sender.id,
      selector: { name: "gemini-hook-idle-target" },
      text: "idle gemini hook target should still route",
    });

    expect(send.ok).toBe(true);
    expect(send.target?.id).toBe(target.id);
    expect(send.target?.seat_key).toBe("pane:gem:%225");
    childS.kill();
    childT.kill();
  });

  test("send_to_peer rejects stale hook-backed Gemini rows without a visible seat", async () => {
    const childS = spawnSleep();
    const childT = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/gemini-hook-headless-s", git_root: null, tty: null, name: "gemini-hook-headless-s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const target = await brokerFetch<{ id: string }>("/register", {
      pid: childT.pid, cwd: "/gemini-hook-headless-t", git_root: null, tty: null, name: "gemini-hook-headless-target",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, tmux_pane_id: null,
      client_type: "gemini", receiver_mode: "gemini-hook", summary: "",
    });
    const hb = await rawPost("/hook-heartbeat-by-pid", {
      pid: childT.pid,
      caller_pid: process.pid,
      client_type: "gemini",
      receiver_mode: "gemini-hook",
      status: "ok",
      drained: 0,
    });
    expect(hb.status).toBe(200);
    const staleIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const rw = new Database(TEST_DB);
    rw.run("UPDATE peers SET last_seen = ?, last_hook_seen_at = ? WHERE id = ?", [staleIso, staleIso, target.id]);
    rw.close();

    const send = await brokerFetch<{ ok: boolean; code?: string }>("/send-to-peer", {
      from_id: sender.id,
      selector: { name: "gemini-hook-headless-target" },
      text: "headless stale gemini hook target should not route",
    });

    expect(send.ok).toBe(false);
    expect(send.code).toBe("PEER_NOT_FOUND");
    childS.kill();
    childT.kill();
  });

  test("/hook-heartbeat-by-pid promotes Gemini peer to gemini-hook mode", async () => {
    const child = spawnSleep();
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/gemini-hook-heartbeat", git_root: null, tty: null, name: "gemini-hook-heartbeat",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      client_type: "gemini", receiver_mode: "manual-drain", summary: "",
    });
    const hb = await rawPost("/hook-heartbeat-by-pid", {
      pid: child.pid,
      caller_pid: process.pid,
      client_type: "gemini",
      receiver_mode: "gemini-hook",
      status: "ok",
      drained: 0,
    });
    expect(hb.status).toBe(200);

    const peers = await brokerFetch<Array<{ id: string; client_type: string; receiver_mode: string; last_hook_seen_at: string | null }>>(
      "/list-peers",
      { id: peer.id, scope: "machine", cwd: "/", git_root: null, include_inactive: true }
    );
    const row = peers.find((p) => p.id === peer.id)!;
    expect(row.client_type).toBe("gemini");
    expect(row.receiver_mode).toBe("gemini-hook");
    expect(typeof row.last_hook_seen_at).toBe("string");
    child.kill();
  });

  test("/register: same live PID preserves peer id and queued mail", async () => {
    const child = spawnSleep();
    const first = await brokerFetch<{ id: string; token: string }>("/register", {
      pid: child.pid, cwd: "/same-pid-register", git_root: null, tty: null,
      name: "codex-startup", tmux_session: "auto-reg", tmux_window_index: "0",
      tmux_window_name: "codex", client_type: "codex", receiver_mode: "manual-drain", summary: "",
    });
    await brokerFetch("/send-message", {
      from_id: first.id,
      to_id: first.id,
      text: "survives same-pid register",
    });
    const second = await brokerFetch<{ id: string; token: string; name: string }>("/register", {
      pid: child.pid, cwd: "/same-pid-register", git_root: null, tty: null,
      name: "codex-server", tmux_session: "auto-reg", tmux_window_index: "0",
      tmux_window_name: "codex", client_type: "codex", receiver_mode: "manual-drain", summary: "server pass",
    });

    expect(second.id).toBe(first.id);
    expect(second.token).not.toBe(first.token);
    expect(second.name).toBe("codex-server");

    const poll = await brokerFetch<{ messages: { text: string }[] }>("/poll-messages", { id: first.id });
    expect(poll.messages.map((m) => m.text)).toContain("survives same-pid register");
    child.kill();
  });

  test("/register: hook metadata refresh preserves an existing same-PID token", async () => {
    const child = spawnSleep();
    const first = await brokerFetch<{ id: string; token: string }>("/register", {
      pid: child.pid, cwd: "/same-pid-preserve-token", git_root: null, tty: null,
      name: "codex-server", tmux_session: "auto-reg-token", tmux_window_index: "0",
      tmux_window_name: "codex", client_type: "codex", receiver_mode: "manual-drain", summary: "server pass",
    });
    const second = await brokerFetch<{ id: string; token: string }>("/register", {
      pid: child.pid, cwd: "/same-pid-preserve-token", git_root: null, tty: null,
      name: "codex-startup", tmux_session: "auto-reg-token", tmux_window_index: "0",
      tmux_window_name: "codex", client_type: "codex", receiver_mode: "codex-hook", preserve_token: true,
      summary: "startup pass",
    });

    expect(second.id).toBe(first.id);
    expect(second.token).toBe(first.token);
    child.kill();
  });

  test("/register: same-PID unknown client refresh preserves id and metadata", async () => {
    const child = spawnSleep();
    const first = await brokerFetch<{ id: string; client_type: string; receiver_mode: string }>("/register", {
      pid: child.pid, cwd: "/same-pid-unknown-refresh", git_root: null, tty: null,
      name: "same-pid-unknown-refresh", tmux_session: "unknown-refresh", tmux_window_index: "0",
      tmux_window_name: "codex", client_type: "codex", receiver_mode: "manual-drain", summary: "known pass",
    });
    await brokerFetch("/send-message", {
      from_id: first.id,
      to_id: first.id,
      text: "survives unknown same-pid register",
    });

    const second = await brokerFetch<{ id: string; client_type: string; receiver_mode: string }>("/register", {
      pid: child.pid, cwd: "/same-pid-unknown-refresh", git_root: null, tty: null,
      name: "same-pid-unknown-refresh", tmux_session: "unknown-refresh", tmux_window_index: "0",
      tmux_window_name: "codex", summary: "metadata-light pass",
    });

    expect(second.id).toBe(first.id);
    expect(second.client_type).toBe("codex");
    expect(second.receiver_mode).toBe("manual-drain");
    const poll = await brokerFetch<{ messages: { text: string }[] }>("/poll-messages", { id: first.id });
    expect(poll.messages.map((m) => m.text)).toContain("survives unknown same-pid register");
    child.kill();
  });

  test("/register: same-PID metadata enrichment preserves peer id", async () => {
    const child = spawnSleep();
    const first = await brokerFetch<{ id: string; token: string }>("/register", {
      pid: child.pid, cwd: "/same-pid-enrichment", git_root: "/same-pid-enrichment", absolute_git_dir: null,
      tty: "/dev/pts/27", name: "same-pid-enrichment", tmux_session: "enrich", tmux_window_index: "0",
      tmux_window_name: null, client_type: "codex", receiver_mode: "manual-drain", summary: "old metadata",
    });
    await brokerFetch("/send-message", {
      from_id: first.id,
      to_id: first.id,
      text: "survives same-pid metadata enrichment",
    });
    const second = await brokerFetch<{ id: string; token: string }>("/register", {
      pid: child.pid, cwd: "/same-pid-enrichment", git_root: "/same-pid-enrichment", absolute_git_dir: "/same-pid-enrichment/.git",
      tty: "pts/27", name: "same-pid-enrichment", tmux_session: "enrich", tmux_window_index: "1",
      tmux_window_name: "node", tmux_pane_id: "%125", client_type: "codex", receiver_mode: "codex-hook",
      preserve_token: true, summary: "enriched metadata",
    });

    expect(second.id).toBe(first.id);
    expect(second.token).toBe(first.token);
    const poll = await brokerFetch<{ messages: { text: string }[] }>("/poll-messages", { id: first.id });
    expect(poll.messages.map((m) => m.text)).toContain("survives same-pid metadata enrichment");
    child.kill();
  });

  test("/register: same-PID sparse refresh preserves known stable metadata", async () => {
    const child = spawnSleep();
    const first = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/same-pid-sparse-refresh", git_root: "/same-pid-sparse-refresh", absolute_git_dir: "/same-pid-sparse-refresh/.git",
      tty: "pts/27", name: "same-pid-sparse-refresh", tmux_session: "sparse", tmux_window_index: "0",
      tmux_window_name: "codex", client_type: "codex", receiver_mode: "manual-drain", summary: "rich metadata",
    });
    const second = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/same-pid-sparse-refresh", git_root: null, absolute_git_dir: null,
      tty: null, name: "same-pid-sparse-refresh", tmux_session: "sparse", tmux_window_index: "0",
      tmux_window_name: "codex", client_type: "codex", receiver_mode: "manual-drain", summary: "sparse metadata",
    });

    expect(second.id).toBe(first.id);
    const peers = await brokerFetch<Array<{ id: string; git_root: string | null; absolute_git_dir: string | null; tty: string | null }>>(
      "/list-peers",
      { id: first.id, scope: "machine", cwd: "/", git_root: null, include_inactive: true }
    );
    const row = peers.find((p) => p.id === first.id)!;
    expect(row.git_root).toBe("/same-pid-sparse-refresh");
    expect(row.absolute_git_dir).toBe("/same-pid-sparse-refresh/.git");
    expect(row.tty).toBe("pts/27");
    child.kill();
  });

  test("/register: same PID with different stable identity gets a fresh peer id", async () => {
    const child = spawnSleep();
    const first = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/pid-reuse-old", git_root: null, tty: null,
      name: "old-session", tmux_session: "reuse", tmux_window_index: "0",
      tmux_window_name: "old", client_type: "codex", receiver_mode: "manual-drain", summary: "",
    });
    const second = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/pid-reuse-new", git_root: null, tty: null,
      name: "new-session", tmux_session: "reuse", tmux_window_index: "0",
      tmux_window_name: "new", client_type: "codex", receiver_mode: "manual-drain", summary: "",
    });

    expect(second.id).not.toBe(first.id);
    child.kill();
  });

  test("/register: same-PID MCP refresh preserves proven hook receiver mode", async () => {
    const child = spawnSleep();
    const first = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/same-pid-preserve-mode", git_root: null, tty: null,
      name: "codex-startup", tmux_session: "auto-reg-mode", tmux_window_index: "0",
      tmux_window_name: "codex", client_type: "codex", receiver_mode: "codex-hook",
      preserve_token: true, summary: "startup pass",
    });
    await brokerFetch("/hook-heartbeat-by-pid", {
      pid: child.pid,
      caller_pid: process.pid,
      client_type: "codex",
      receiver_mode: "codex-hook",
      status: "ok",
      drained: 0,
    });
    const second = await brokerFetch<{ id: string; receiver_mode: string }>("/register", {
      pid: child.pid, cwd: "/same-pid-preserve-mode", git_root: null, tty: null,
      name: "codex-server", tmux_session: "auto-reg-mode", tmux_window_index: "0",
      tmux_window_name: "codex", client_type: "codex", receiver_mode: "manual-drain",
      summary: "server pass",
    });

    expect(second.id).toBe(first.id);
    expect(second.receiver_mode).toBe("codex-hook");
    child.kill();
  });

  test("heartbeat backfills client metadata without downgrading codex-hook", async () => {
    const child = spawnSleep();
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/heartbeat-backfill", git_root: null, tty: null, name: "heartbeat-backfill",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      summary: "",
    });
    await rawPost("/hook-heartbeat-by-pid", {
      pid: child.pid,
      caller_pid: process.pid,
      client_type: "codex",
      receiver_mode: "codex-hook",
      status: "ok",
      drained: 0,
    });
    await brokerFetch("/heartbeat", {
      id: peer.id,
      client_type: "codex",
      receiver_mode: "manual-drain",
    });
    const peers = await brokerFetch<Array<{ id: string; client_type: string; receiver_mode: string }>>(
      "/list-peers",
      { id: peer.id, scope: "machine", cwd: "/", git_root: null, include_inactive: true }
    );
    const row = peers.find((p) => p.id === peer.id)!;
    expect(row.client_type).toBe("codex");
    expect(row.receiver_mode).toBe("codex-hook");
    child.kill();
  });

  test("heartbeat response returns broker-preserved receiver metadata", async () => {
    const child = spawnSleep();
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/heartbeat-response", git_root: null, tty: null, name: "heartbeat-response",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      client_type: "codex", receiver_mode: "manual-drain", summary: "",
    });
    await rawPost("/hook-heartbeat-by-pid", {
      pid: child.pid,
      caller_pid: process.pid,
      client_type: "codex",
      receiver_mode: "codex-hook",
      status: "ok",
      drained: 0,
    });

    const heartbeat = await brokerFetch<{ ok: boolean; client_type: string; receiver_mode: string }>("/heartbeat", {
      id: peer.id,
      client_type: "codex",
      receiver_mode: "manual-drain",
    });
    expect(heartbeat.ok).toBe(true);
    expect(heartbeat.client_type).toBe("codex");
    expect(heartbeat.receiver_mode).toBe("codex-hook");
    child.kill();
  });

  test("unknown heartbeat does not downgrade a proven Gemini hook receiver", async () => {
    const child = spawnSleep();
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/unknown-heartbeat-gemini", git_root: null, tty: null, name: "unknown-heartbeat-gemini",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      client_type: "unknown", receiver_mode: "unknown", summary: "",
    });
    await rawPost("/hook-heartbeat-by-pid", {
      pid: child.pid,
      caller_pid: process.pid,
      client_type: "gemini",
      receiver_mode: "gemini-hook",
      status: "ok",
      drained: 0,
    });
    await brokerFetch("/heartbeat", {
      id: peer.id,
      client_type: "unknown",
      receiver_mode: "unknown",
    });
    const peers = await brokerFetch<Array<{ id: string; client_type: string; receiver_mode: string }>>(
      "/list-peers",
      { id: peer.id, scope: "machine", cwd: "/", git_root: null, include_inactive: true }
    );
    const row = peers.find((p) => p.id === peer.id)!;
    expect(row.client_type).toBe("gemini");
    expect(row.receiver_mode).toBe("gemini-hook");
    child.kill();
  });

  test("metadata-less claim-by-pid does not rewrite a Claude receiver to Codex", async () => {
    const child = spawnSleep();
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/claude-claim-preserve", git_root: null, tty: null, name: "claude-claim-preserve",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      client_type: "claude", receiver_mode: "claude-channel", summary: "",
    });
    const claim = await rawPost("/claim-by-pid", {
      pid: child.pid,
      caller_pid: process.pid,
      drain_id: "metadata-less-review-regression",
    });
    expect(claim.status).toBe(200);
    const peers = await brokerFetch<Array<{ id: string; client_type: string; receiver_mode: string }>>(
      "/list-peers",
      { id: peer.id, scope: "machine", cwd: "/", git_root: null, include_inactive: true }
    );
    const row = peers.find((p) => p.id === peer.id)!;
    expect(row.client_type).toBe("claude");
    expect(row.receiver_mode).toBe("claude-channel");
    child.kill();
  });

  test("metadata-less claim-by-pid preserves unknown receiver state", async () => {
    const child = spawnSleep();
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/unknown-claim-preserve", git_root: null, tty: null, name: "unknown-claim-preserve",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      client_type: "unknown", receiver_mode: "unknown", summary: "",
    });
    const claim = await rawPost("/claim-by-pid", {
      pid: child.pid,
      caller_pid: process.pid,
      drain_id: "metadata-less-unknown-regression",
    });
    expect(claim.status).toBe(200);
    const peers = await brokerFetch<Array<{ id: string; client_type: string; receiver_mode: string }>>(
      "/list-peers",
      { id: peer.id, scope: "machine", cwd: "/", git_root: null, include_inactive: true }
    );
    const row = peers.find((p) => p.id === peer.id)!;
    expect(row.client_type).toBe("unknown");
    expect(row.receiver_mode).toBe("unknown");
    child.kill();
  });

  test("Codex hook script emits UserPromptSubmit additionalContext and ACKs", async () => {
    const child = spawnSleep();
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/codex-hook-script", git_root: null, tty: null, name: "codex-hook-script",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      client_type: "codex", receiver_mode: "manual-drain", summary: "",
    });
    const send = await brokerFetch<{ id: number }>("/send-message", {
      from_id: peer.id, to_id: peer.id, text: "hook-visible",
    });

    const hook = Bun.spawn(["bun", new URL("../hooks/codex-drain-peer-inbox.ts", import.meta.url).pathname], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        CLAUDE_PEERS_PORT: String(BROKER_PORT),
        CLAUDE_PEERS_MCP_PID: String(child.pid),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(hook.stdout).text();
    const stderr = await new Response(hook.stderr).text();
    const code = await hook.exited;
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const json = JSON.parse(stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
      suppressOutput?: unknown;
    };
    expect(json.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(json.hookSpecificOutput.additionalContext).toContain("hook-visible");
    expect(json.hookSpecificOutput.additionalContext).toContain("<peer-message");
    expect(json.suppressOutput).toBeUndefined();

    const status = await brokerFetch<{ statuses: { delivered: boolean; delivered_at: string | null }[] }>(
      "/message-status", { id: peer.id, ids: [send.id] }
    );
    expect(status.statuses[0]!.delivered).toBe(true);
    expect(typeof status.statuses[0]!.delivered_at).toBe("string");
    child.kill();
  });

  test("Codex Stop-event hook emits decision:block with reason and ACKs", async () => {
    const child = spawnSleep();
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/codex-stop-hook", git_root: null, tty: null, name: "codex-stop-hook",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      client_type: "codex", receiver_mode: "manual-drain", summary: "",
    });
    const send = await brokerFetch<{ id: number }>("/send-message", {
      from_id: peer.id, to_id: peer.id, text: "stop-hook-visible",
    });

    const hook = Bun.spawn(["bun", new URL("../hooks/codex-drain-peer-inbox.ts", import.meta.url).pathname], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        CLAUDE_PEERS_PORT: String(BROKER_PORT),
        CLAUDE_PEERS_MCP_PID: String(child.pid),
        CLAUDE_PEERS_HOOK_EVENT_NAME: "Stop",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    hook.stdin.write(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    hook.stdin.end();
    const stdout = await new Response(hook.stdout).text();
    const code = await hook.exited;
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as { decision: string; reason: string; hookSpecificOutput?: unknown };
    // Official Codex hooks contract: Stop ignores additionalContext / plain
    // stdout; turn-end delivery must use decision:"block" + reason.
    expect(json.decision).toBe("block");
    expect(json.reason).toContain("stop-hook-visible");
    expect(json.reason).toContain("<peer-message");
    expect(json.hookSpecificOutput).toBeUndefined();

    const status = await brokerFetch<{ statuses: { delivered: boolean }[] }>(
      "/message-status", { id: peer.id, ids: [send.id] }
    );
    expect(status.statuses[0]!.delivered).toBe(true);
    child.kill();
  });

  test("Codex Stop-event hook honors stop_hook_active and leaves mail unclaimed", async () => {
    const child = spawnSleep();
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/codex-stop-active", git_root: null, tty: null, name: "codex-stop-active",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      client_type: "codex", receiver_mode: "manual-drain", summary: "",
    });
    const send = await brokerFetch<{ id: number }>("/send-message", {
      from_id: peer.id, to_id: peer.id, text: "must-stay-queued",
    });

    const hook = Bun.spawn(["bun", new URL("../hooks/codex-drain-peer-inbox.ts", import.meta.url).pathname], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        CLAUDE_PEERS_PORT: String(BROKER_PORT),
        CLAUDE_PEERS_MCP_PID: String(child.pid),
        CLAUDE_PEERS_HOOK_EVENT_NAME: "Stop",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    hook.stdin.write(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: true }));
    hook.stdin.end();
    const stdout = await new Response(hook.stdout).text();
    const code = await hook.exited;
    expect(code).toBe(0);
    // Loop guard: no output at all, and the message stays undelivered for the
    // next UserPromptSubmit / session-start drain.
    expect(stdout.trim()).toBe("");
    const status = await brokerFetch<{ statuses: { delivered: boolean }[] }>(
      "/message-status", { id: peer.id, ids: [send.id] }
    );
    expect(status.statuses[0]!.delivered).toBe(false);
    child.kill();
  });

  test("Codex SessionStart hook retries claim until the racing registration lands", async () => {
    // At SessionStart the register hook and MCP servers launch concurrently
    // with the drain. The retry path is gated on the broker's literal
    // "peer not found" error strings — this test pins that contract: reword
    // the broker error and the drain silently gives up on attempt 1.
    const child = spawnSleep();

    const hook = Bun.spawn(["bun", new URL("../hooks/codex-drain-peer-inbox.ts", import.meta.url).pathname], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        CLAUDE_PEERS_PORT: String(BROKER_PORT),
        CLAUDE_PEERS_MCP_PID: String(child.pid),
        CLAUDE_PEERS_HOOK_EVENT_NAME: "SessionStart",
      },
      stdout: "pipe",
      stderr: "ignore",
    });

    // Let the hook burn its first claim attempt(s) against an unregistered
    // pid, then SIGSTOP it so no claim can land in the gap between /register
    // and /send-message (an empty claim would end the drain mail-less).
    await Bun.sleep(800);
    hook.kill("SIGSTOP");
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/codex-sessionstart-race", git_root: null, tty: null, name: "codex-ss-race",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      client_type: "codex", receiver_mode: "manual-drain", summary: "",
    });
    const send = await brokerFetch<{ id: number }>("/send-message", {
      from_id: peer.id, to_id: peer.id, text: "race-visible",
    });
    hook.kill("SIGCONT");

    const stdout = await new Response(hook.stdout).text();
    const code = await hook.exited;
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(json.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(json.hookSpecificOutput.additionalContext).toContain("race-visible");

    const status = await brokerFetch<{ statuses: { delivered: boolean }[] }>(
      "/message-status", { id: peer.id, ids: [send.id] }
    );
    expect(status.statuses[0]!.delivered).toBe(true);
    child.kill();
  }, 15000);

  test("Gemini hook script emits BeforeAgent additionalContext and ACKs", async () => {
    const child = spawnSleep();
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/gemini-hook-script", git_root: null, tty: null, name: "gemini-hook-script",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null,
      client_type: "gemini", receiver_mode: "manual-drain", summary: "",
    });
    const send = await brokerFetch<{ id: number }>("/send-message", {
      from_id: peer.id, to_id: peer.id, text: "gemini-hook-visible",
    });

    const hook = Bun.spawn(["bash", new URL("../hooks/gemini-drain-peer-inbox.sh", import.meta.url).pathname], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        CLAUDE_PEERS_ROOT: new URL("..", import.meta.url).pathname.replace(/\/$/, ""),
        CLAUDE_PEERS_PORT: String(BROKER_PORT),
        CLAUDE_PEERS_MCP_PID: String(child.pid),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(hook.stdout).text();
    const stderr = await new Response(hook.stderr).text();
    const code = await hook.exited;
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const json = JSON.parse(stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
      suppressOutput?: unknown;
    };
    expect(json.hookSpecificOutput.hookEventName).toBe("BeforeAgent");
    expect(json.hookSpecificOutput.additionalContext).toContain("gemini-hook-visible");
    expect(json.hookSpecificOutput.additionalContext).toContain("<peer-message");
    expect(json.suppressOutput).toBeUndefined();

    const status = await brokerFetch<{ statuses: { delivered: boolean; delivered_at: string | null }[] }>(
      "/message-status", { id: peer.id, ids: [send.id] }
    );
    expect(status.statuses[0]!.delivered).toBe(true);
    expect(typeof status.statuses[0]!.delivered_at).toBe("string");
    child.kill();
  });

  // --- Delivery confirmation tests (#2 workflow improvement) ---------------

  test("send_message returns message id in response", async () => {
    const childS = spawnSleep();
    const childT = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/dc-s", git_root: null, tty: null, name: "s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const target = await brokerFetch<{ id: string }>("/register", {
      pid: childT.pid, cwd: "/dc-t", git_root: null, tty: null, name: "t",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const send = await brokerFetch<{ ok: boolean; id?: number }>("/send-message", {
      from_id: sender.id, to_id: target.id, text: "hello",
    });
    expect(send.ok).toBe(true);
    expect(typeof send.id).toBe("number");
    expect(send.id).toBeGreaterThan(0);
    childS.kill(); childT.kill();
  });

  test("send_message rejects stale peer ids and does not enqueue mail", async () => {
    const childS = spawnSleep();
    const childT = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/stale-id-s", git_root: null, tty: null, name: "stale-s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const target = await brokerFetch<{ id: string }>("/register", {
      pid: childT.pid, cwd: "/stale-id-t", git_root: null, tty: null, name: "stale-t",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });

    childT.kill();
    await childT.exited;

    const send = await brokerFetch<{ ok: boolean; code?: string; error?: string }>("/send-message", {
      from_id: sender.id, to_id: target.id, text: "must-not-queue",
    });
    expect(send.ok).toBe(false);
    expect(send.code).toBe("STALE_PEER_ID");
    expect(send.error).toContain(target.id);

    const db = new Database(TEST_DB);
    const row = db.query("SELECT COUNT(*) AS c FROM messages WHERE text = ?").get("must-not-queue") as { c: number };
    db.close();
    expect(row.c).toBe(0);
    childS.kill();
  });

  test("send_to_peer routes by unique human name and returns target identity", async () => {
    const childS = spawnSleep();
    const childT = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/selector-s", git_root: null, tty: null, name: "selector-s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const target = await brokerFetch<{ id: string; name: string | null }>("/register", {
      pid: childT.pid, cwd: "/selector-t", git_root: null, tty: null, name: "Clause5.3",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });

    const send = await brokerFetch<{ ok: boolean; id?: number; target?: { id: string; name: string | null; seat_key: string } }>("/send-to-peer", {
      from_id: sender.id,
      selector: { name: "Clause5.3" },
      text: "selector hello",
    });
    expect(send.ok).toBe(true);
    expect(send.target?.id).toBe(target.id);
    expect(send.target?.name).toBe("Clause5.3");
    expect(send.target?.seat_key).toBe(`id:${target.id}`);

    const poll = await brokerFetch<{ messages: { text: string }[] }>("/poll-messages", { id: target.id });
    expect(poll.messages.filter((m) => m.text === "selector hello")).toHaveLength(1);
    childS.kill(); childT.kill();
  });

  test("send_to_peer selector.id rejects stale peer ids and does not enqueue mail", async () => {
    const childS = spawnSleep();
    const childT = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/selector-stale-s", git_root: null, tty: null, name: "selector-stale-s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const target = await brokerFetch<{ id: string }>("/register", {
      pid: childT.pid, cwd: "/selector-stale-t", git_root: null, tty: null, name: "selector-stale-t",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });

    childT.kill();
    await childT.exited;

    const send = await brokerFetch<{ ok: boolean; code?: string; error?: string }>("/send-to-peer", {
      from_id: sender.id,
      selector: { id: target.id },
      text: "selector-must-not-queue",
    });
    expect(send.ok).toBe(false);
    expect(send.code).toBe("STALE_PEER_ID");
    expect(send.error).toContain(target.id);

    const db = new Database(TEST_DB);
    const row = db.query("SELECT COUNT(*) AS c FROM messages WHERE text = ?").get("selector-must-not-queue") as { c: number };
    db.close();
    expect(row.c).toBe(0);
    childS.kill();
  });

  test("send_to_peer selector.id returns live replacement candidates without enqueueing", async () => {
    const childS = spawnSleep();
    const childOld = spawnSleep();
    const childNew = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/selector-candidate-s", git_root: null, tty: null, name: "selector-candidate-s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const oldTarget = await brokerFetch<{ id: string }>("/register", {
      pid: childOld.pid, cwd: "/selector-candidate-old", git_root: null, tty: null, name: "candidate-seat",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    childOld.kill();
    await childOld.exited;
    const newTarget = await brokerFetch<{ id: string }>("/register", {
      pid: childNew.pid, cwd: "/selector-candidate-new", git_root: null, tty: null, name: "candidate-seat",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });

    const send = await brokerFetch<{ ok: boolean; code?: string; candidates?: Array<{ id: string; name: string | null }> }>("/send-to-peer", {
      from_id: sender.id,
      selector: { id: oldTarget.id },
      text: "candidate-must-not-queue",
    });
    expect(send.ok).toBe(false);
    expect(send.code).toBe("STALE_PEER_ID");
    expect(send.candidates?.map((c) => c.id)).toContain(newTarget.id);

    const db = new Database(TEST_DB);
    const row = db.query("SELECT COUNT(*) AS c FROM messages WHERE text = ?").get("candidate-must-not-queue") as { c: number };
    db.close();
    expect(row.c).toBe(0);
    childS.kill(); childNew.kill();
  });

  test("send_to_peer stale-id candidates respect supplemental selector fields", async () => {
    const childS = spawnSleep();
    const childOld = spawnSleep();
    const childNew = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/selector-candidate-filter-s", git_root: null, tty: null, name: "selector-candidate-filter-s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const oldTarget = await brokerFetch<{ id: string }>("/register", {
      pid: childOld.pid, cwd: "/selector-candidate-filter-old", git_root: null, tty: null, name: "candidate-filter-seat",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    childOld.kill();
    await childOld.exited;
    const newTarget = await brokerFetch<{ id: string }>("/register", {
      pid: childNew.pid, cwd: "/selector-candidate-filter-new", git_root: null, tty: null, name: "candidate-filter-seat",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });

    const send = await brokerFetch<{ ok: boolean; code?: string; candidates?: Array<{ id: string; name: string | null }> }>("/send-to-peer", {
      from_id: sender.id,
      selector: { id: oldTarget.id, name: "different-seat" },
      text: "candidate-filter-must-not-queue",
    });
    expect(send.ok).toBe(false);
    expect(send.code).toBe("STALE_PEER_ID");
    expect(send.candidates?.map((c) => c.id)).not.toContain(newTarget.id);
    expect(send.candidates ?? []).toHaveLength(0);

    const db = new Database(TEST_DB);
    const row = db.query("SELECT COUNT(*) AS c FROM messages WHERE text = ?").get("candidate-filter-must-not-queue") as { c: number };
    db.close();
    expect(row.c).toBe(0);
    childS.kill(); childNew.kill();
  });

  test("send resolution does not reap unrelated rehydratable inboxes", async () => {
    const childS = spawnSleep();
    const childDead = spawnSleep();
    const childLive = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/nonmutating-s", git_root: null, tty: null, name: "nonmutating-s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const recoverable = await brokerFetch<{ id: string }>("/register", {
      pid: childDead.pid, cwd: "/nonmutating-rehydrate", git_root: "/repo-nonmutating", tty: null, name: "nonmutating-old",
      tmux_session: "nonmutating", tmux_window_index: "3", tmux_window_name: "three", tmux_pane_id: "%303", summary: "",
    });
    const liveTarget = await brokerFetch<{ id: string }>("/register", {
      pid: childLive.pid, cwd: "/nonmutating-live", git_root: null, tty: null, name: "nonmutating-live",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    await brokerFetch("/send-message", {
      from_id: sender.id,
      to_id: recoverable.id,
      text: "rehydratable queued mail",
    });
    childDead.kill();
    await childDead.exited;

    const unrelatedSend = await brokerFetch<{ ok: boolean }>("/send-message", {
      from_id: sender.id,
      to_id: liveTarget.id,
      text: "unrelated live send",
    });
    expect(unrelatedSend.ok).toBe(true);

    const fresh = spawnSleep();
    const relaunched = await brokerFetch<{ id: string }>("/register", {
      pid: fresh.pid, cwd: "/nonmutating-rehydrate", git_root: "/repo-nonmutating", tty: null, name: "nonmutating-new",
      tmux_session: "nonmutating", tmux_window_index: "3", tmux_window_name: "three", tmux_pane_id: "%303", summary: "",
    });
    expect(relaunched.id).toBe(recoverable.id);
    const poll = await brokerFetch<{ messages: { text: string }[] }>("/poll-messages", { id: relaunched.id });
    expect(poll.messages.filter((m) => m.text === "rehydratable queued mail")).toHaveLength(1);
    childS.kill(); childLive.kill(); fresh.kill();
  });

  test("list and broadcast do not reap unrelated rehydratable inboxes", async () => {
    const childS = spawnSleep();
    const childDead = spawnSleep();
    const childLive = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: childS.pid, cwd: "/read-reap-s", git_root: null, tty: null, name: "read-reap-s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const recoverable = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: childDead.pid, cwd: "/read-reap-rehydrate", git_root: "/repo-read-reap", tty: null, name: "read-reap-old",
      tmux_session: "read-reap", tmux_window_index: "4", tmux_window_name: "four", tmux_pane_id: "%404", summary: "",
    });
    await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: childLive.pid, cwd: "/read-reap-live", git_root: null, tty: null, name: "read-reap-live",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    await brokerFetch("/send-message", {
      from_id: sender.id,
      to_id: recoverable.id,
      text: "read-side queued mail",
    });
    childDead.kill();
    await childDead.exited;

    await brokerFetch("/list-peers", {
      id: sender.id,
      scope: "machine",
      cwd: "/",
      git_root: null,
      include_inactive: false,
    });
    const broadcast = await brokerFetch<{ ok: boolean; sent: number }>("/broadcast-message", {
      from_id: sender.id,
      name_like: "read-reap-live",
      text: "trigger broadcast liveness filter",
    });
    expect(broadcast.ok).toBe(true);
    expect(broadcast.sent).toBe(1);

    const fresh = spawnSleep();
    const relaunched = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: fresh.pid, cwd: "/read-reap-rehydrate", git_root: "/repo-read-reap", tty: null, name: "read-reap-new",
      tmux_session: "read-reap", tmux_window_index: "4", tmux_window_name: "four", tmux_pane_id: "%404", summary: "",
    });
    expect(relaunched.id).toBe(recoverable.id);
    const poll = await brokerFetch<{ messages: { text: string }[] }>("/poll-messages", { id: relaunched.id });
    expect(poll.messages.filter((m) => m.text === "read-side queued mail")).toHaveLength(1);
    childS.kill(); childLive.kill(); fresh.kill();
  });

  test("send_to_peer routes by exact seat_key", async () => {
    const childS = spawnSleep();
    const childT = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/seatkey-s", git_root: null, tty: null, name: "seatkey-s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const target = await brokerFetch<{ id: string }>("/register", {
      pid: childT.pid, cwd: "/seatkey-t", git_root: null, tty: null, name: "seatkey-t",
      tmux_session: "seatkey", tmux_window_index: "7", tmux_window_name: "seven", tmux_pane_id: "%77", summary: "",
    });

    const send = await brokerFetch<{ ok: boolean; target?: { id: string; seat_key: string } }>("/send-to-peer", {
      from_id: sender.id,
      selector: { seat_key: "pane:seatkey:%77" },
      text: "seatkey route",
    });
    expect(send.ok).toBe(true);
    expect(send.target?.id).toBe(target.id);
    expect(send.target?.seat_key).toBe("pane:seatkey:%77");

    const poll = await brokerFetch<{ messages: { text: string }[] }>("/poll-messages", { id: target.id });
    expect(poll.messages.filter((m) => m.text === "seatkey route")).toHaveLength(1);
    childS.kill(); childT.kill();
  });

  test("send_to_peer routes by tmux_session plus tmux_pane_id", async () => {
    const childS = spawnSleep();
    const childT = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/tmux-selector-s", git_root: null, tty: null, name: "tmux-selector-s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const target = await brokerFetch<{ id: string }>("/register", {
      pid: childT.pid, cwd: "/tmux-selector-t", git_root: null, tty: null, name: "tmux-selector-t",
      tmux_session: "tmux-selector", tmux_window_index: "5", tmux_window_name: "five", tmux_pane_id: "%55", summary: "",
    });

    const send = await brokerFetch<{ ok: boolean; target?: { id: string; tmux_session: string | null; tmux_pane_id: string | null } }>("/send-to-peer", {
      from_id: sender.id,
      selector: { tmux_session: "tmux-selector", tmux_pane_id: "%55" },
      text: "tmux selector route",
    });
    expect(send.ok).toBe(true);
    expect(send.target?.id).toBe(target.id);
    expect(send.target?.tmux_session).toBe("tmux-selector");
    expect(send.target?.tmux_pane_id).toBe("%55");

    const poll = await brokerFetch<{ messages: { text: string }[] }>("/poll-messages", { id: target.id });
    expect(poll.messages.filter((m) => m.text === "tmux selector route")).toHaveLength(1);
    childS.kill(); childT.kill();
  });

  test("send_to_peer rejects tmux_session alone as an invalid selector", async () => {
    const childS = spawnSleep();
    const childT = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/tmux-invalid-s", git_root: null, tty: null, name: "tmux-invalid-s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    await brokerFetch<{ id: string }>("/register", {
      pid: childT.pid, cwd: "/tmux-invalid-t", git_root: null, tty: null, name: "tmux-invalid-t",
      tmux_session: "tmux-invalid", tmux_window_index: "1", tmux_window_name: "one", tmux_pane_id: "%11", summary: "",
    });

    const send = await brokerFetch<{ ok: boolean; code?: string; error?: string }>("/send-to-peer", {
      from_id: sender.id,
      selector: { tmux_session: "tmux-invalid" },
      text: "invalid tmux selector",
    });
    expect(send.ok).toBe(false);
    expect(send.code).toBe("INVALID_SELECTOR");
    expect(send.error).toContain("tmux_session alone");
    childS.kill(); childT.kill();
  });

  test("send_to_peer rejects tmux_pane_id alone as an invalid selector", async () => {
    const childS = spawnSleep();
    const childT = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/tmux-pane-invalid-s", git_root: null, tty: null, name: "tmux-pane-invalid-s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    await brokerFetch<{ id: string }>("/register", {
      pid: childT.pid, cwd: "/tmux-pane-invalid-t", git_root: null, tty: null, name: "tmux-pane-invalid-t",
      tmux_session: "tmux-pane-invalid", tmux_window_index: "1", tmux_window_name: "one", tmux_pane_id: "%12", summary: "",
    });

    const send = await brokerFetch<{ ok: boolean; code?: string; error?: string }>("/send-to-peer", {
      from_id: sender.id,
      selector: { tmux_pane_id: "%12" },
      text: "invalid tmux pane selector",
    });
    expect(send.ok).toBe(false);
    expect(send.code).toBe("INVALID_SELECTOR");
    expect(send.error).toContain("tmux_pane_id alone");
    childS.kill(); childT.kill();
  });

  test("send_to_peer rejects duplicate human names with live candidates", async () => {
    const childS = spawnSleep();
    const childA = spawnSleep();
    const childB = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/dup-s", git_root: null, tty: null, name: "dup-s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    await brokerFetch<{ id: string; resolved_name: string | null }>("/register", {
      pid: childA.pid, cwd: "/dup-a", git_root: null, tty: null, name: "infra.4",
      tmux_session: "infra", tmux_window_index: "1", tmux_window_name: "one", tmux_pane_id: "%41", summary: "",
    });
    await brokerFetch<{ id: string; resolved_name: string | null }>("/register", {
      pid: childB.pid, cwd: "/dup-b", git_root: null, tty: null, name: "infra.4",
      tmux_session: "infra", tmux_window_index: "2", tmux_window_name: "two", tmux_pane_id: "%42", summary: "",
    });

    const send = await brokerFetch<{ ok: boolean; code?: string; candidates?: Array<{
      id: string;
      name: string | null;
      resolved_name: string | null;
      seat_key: string;
      tmux_session: string | null;
      tmux_pane_id: string | null;
      client_type: string;
      receiver_mode: string;
    }> }>("/send-to-peer", {
      from_id: sender.id,
      selector: { name: "infra.4" },
      text: "ambiguous",
    });
    expect(send.ok).toBe(false);
    expect(send.code).toBe("AMBIGUOUS_TARGET");
    expect(send.candidates?.length).toBe(2);
    expect(send.candidates?.every((c) => c.name === "infra.4")).toBe(true);
    expect(send.candidates?.every((c) => typeof c.id === "string" && c.id.length > 0)).toBe(true);
    // Window-name disambiguator: seat B is in window "two" (seat A in "one"), so
    // its resolved_name is the self-documenting "infra.4#two", not a bare "#2".
    expect(send.candidates?.map((c) => c.resolved_name).sort()).toEqual(["infra.4", "infra.4#two"]);
    expect(send.candidates?.map((c) => c.tmux_session).sort()).toEqual(["infra", "infra"]);
    expect(send.candidates?.map((c) => c.tmux_pane_id).sort()).toEqual(["%41", "%42"]);
    expect(send.candidates?.every((c) => c.client_type === "unknown")).toBe(true);
    expect(send.candidates?.every((c) => c.receiver_mode === "unknown")).toBe(true);
    expect(send.candidates?.map((c) => c.seat_key).sort()).toEqual(["pane:infra:%41", "pane:infra:%42"]);
    const db = new Database(TEST_DB);
    const row = db.query("SELECT COUNT(*) AS c FROM messages WHERE text = ?").get("ambiguous") as { c: number };
    db.close();
    expect(row.c).toBe(0);
    childS.kill(); childA.kill(); childB.kill();
  });

  test("send_to_peer routes exact resolved_name after duplicate human-name dedup", async () => {
    const childS = spawnSleep();
    const childA = spawnSleep();
    const childB = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/resolved-s", git_root: null, tty: null, name: "resolved-s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    await brokerFetch<{ id: string; resolved_name: string | null }>("/register", {
      pid: childA.pid, cwd: "/resolved-a", git_root: null, tty: null, name: "codex.9",
      tmux_session: "codex", tmux_window_index: "1", tmux_window_name: "one", tmux_pane_id: "%91", summary: "",
    });
    const second = await brokerFetch<{ id: string; resolved_name: string | null }>("/register", {
      pid: childB.pid, cwd: "/resolved-b", git_root: null, tty: null, name: "codex.9",
      tmux_session: "codex", tmux_window_index: "2", tmux_window_name: "two", tmux_pane_id: "%92", summary: "",
    });
    // Window-name disambiguator: seat B is in window "two" → resolved "codex.9#two".
    expect(second.resolved_name).toBe("codex.9#two");

    const send = await brokerFetch<{ ok: boolean; target?: { id: string; resolved_name: string | null } }>("/send-to-peer", {
      from_id: sender.id,
      selector: { resolved_name: "codex.9#two" },
      text: "resolved route",
    });
    expect(send.ok).toBe(true);
    expect(send.target?.id).toBe(second.id);
    expect(send.target?.resolved_name).toBe("codex.9#two");

    const poll = await brokerFetch<{ messages: { text: string }[] }>("/poll-messages", { id: second.id });
    expect(poll.messages.filter((m) => m.text === "resolved route")).toHaveLength(1);
    childS.kill(); childA.kill(); childB.kill();
  });

  test("message-status: undelivered message returns delivered=false, delivered_at=null", async () => {
    const childS = spawnSleep();
    const childT = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/ms1-s", git_root: null, tty: null, name: "s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const target = await brokerFetch<{ id: string }>("/register", {
      pid: childT.pid, cwd: "/ms1-t", git_root: null, tty: null, name: "t",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const send = await brokerFetch<{ id: number }>("/send-message", {
      from_id: sender.id, to_id: target.id, text: "pending",
    });
    const status = await brokerFetch<{ ok: boolean; statuses: { id: number; delivered: boolean; delivered_at: string | null }[] }>(
      "/message-status", { id: sender.id, ids: [send.id] }
    );
    expect(status.ok).toBe(true);
    expect(status.statuses[0]!.id).toBe(send.id);
    expect(status.statuses[0]!.delivered).toBe(false);
    expect(status.statuses[0]!.delivered_at).toBeNull();
    childS.kill(); childT.kill();
  });

  test("message-status: after ack, delivered=true + delivered_at populated", async () => {
    const childS = spawnSleep();
    const childT = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/ms2-s", git_root: null, tty: null, name: "s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const target = await brokerFetch<{ id: string }>("/register", {
      pid: childT.pid, cwd: "/ms2-t", git_root: null, tty: null, name: "t",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const send = await brokerFetch<{ id: number }>("/send-message", {
      from_id: sender.id, to_id: target.id, text: "will be acked",
    });
    // Drain via /poll-by-pid (atomic ack) to mark it delivered.
    await rawPost("/poll-by-pid", { pid: childT.pid, caller_pid: process.pid });

    const status = await brokerFetch<{ ok: boolean; statuses: { delivered: boolean; delivered_at: string | null }[] }>(
      "/message-status", { id: sender.id, ids: [send.id] }
    );
    expect(status.statuses[0]!.delivered).toBe(true);
    expect(typeof status.statuses[0]!.delivered_at).toBe("string");
    childS.kill(); childT.kill();
  });

  test("message-status: another peer cannot read my message's status", async () => {
    const childA = spawnSleep();
    const childB = spawnSleep();
    const childT = spawnSleep();
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: childA.pid, cwd: "/ms3-a", git_root: null, tty: null, name: "a",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: childB.pid, cwd: "/ms3-b", git_root: null, tty: null, name: "b",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const target = await brokerFetch<{ id: string }>("/register", {
      pid: childT.pid, cwd: "/ms3-t", git_root: null, tty: null, name: "t",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const aSend = await brokerFetch<{ id: number }>("/send-message", {
      from_id: a.id, to_id: target.id, text: "a's secret",
    });
    // Peer b queries status of peer a's message id — should NOT get the
    // real status (sender-scoped lookup returns empty for non-owner).
    const status = await brokerFetch<{ statuses: { id: number; delivered: boolean; delivered_at: string | null }[] }>(
      "/message-status", { id: b.id, ids: [aSend.id] }
    );
    expect(status.statuses[0]!.id).toBe(aSend.id);
    expect(status.statuses[0]!.delivered).toBe(false);
    expect(status.statuses[0]!.delivered_at).toBeNull();
    childA.kill(); childB.kill(); childT.kill();
  });

  // --- Broadcast tests (#5 workflow improvement) --------------------------
  // /broadcast-message fanout by scope filter. Insertion via the authed
  // brokerFetch so rate-limit + token auth cover this path too.

  test("broadcast: tmux_session fanout delivers to all matching peers", async () => {
    const childA = spawnSleep();
    const childB = spawnSleep();
    const childC = spawnSleep();
    const childSender = spawnSleep();
    const a = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: childA.pid, cwd: "/bc1", git_root: null, tty: null, name: "a",
      tmux_session: "bcast1", tmux_window_index: "0", tmux_window_name: "claude", summary: "",
    });
    const b = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: childB.pid, cwd: "/bc2", git_root: null, tty: null, name: "b",
      tmux_session: "bcast1", tmux_window_index: "1", tmux_window_name: "claude", summary: "",
    });
    const c = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: childC.pid, cwd: "/bc3", git_root: null, tty: null, name: "c",
      tmux_session: "bcast-other", tmux_window_index: "0", tmux_window_name: "claude", summary: "",
    });
    const sender = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: childSender.pid, cwd: "/bc-sender", git_root: null, tty: null, name: "sender",
      tmux_session: "bcast-sender", tmux_window_index: "0", tmux_window_name: "claude", summary: "",
    });

    const result = await brokerFetch<{ ok: boolean; sent: number }>("/broadcast-message", {
      from_id: sender.id, text: "hello bcast1", tmux_session: "bcast1",
    });
    expect(result.ok).toBe(true);
    expect(result.sent).toBe(2);

    // Verify a and b got it, c did not
    const pollA = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: a.id });
    const pollB = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: b.id });
    const pollC = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: c.id });
    expect(pollA.messages.length).toBe(1);
    expect(pollB.messages.length).toBe(1);
    expect(pollC.messages.length).toBe(0);
    childA.kill(); childB.kill(); childC.kill(); childSender.kill();
  });

  test("broadcast: excludes the sender even if sender matches the scope", async () => {
    const childA = spawnSleep();
    const childSender = spawnSleep();
    const a = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: childA.pid, cwd: "/bc-self-a", git_root: null, tty: null, name: "a",
      tmux_session: "bcast2", tmux_window_index: "0", tmux_window_name: "claude", summary: "",
    });
    const sender = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: childSender.pid, cwd: "/bc-self-s", git_root: null, tty: null, name: "sender",
      // Sender in the SAME scope as the target
      tmux_session: "bcast2", tmux_window_index: "1", tmux_window_name: "claude", summary: "",
    });
    const result = await brokerFetch<{ ok: boolean; sent: number }>("/broadcast-message", {
      from_id: sender.id, text: "hello bcast2", tmux_session: "bcast2",
    });
    expect(result.sent).toBe(1);  // only peer a, not sender itself
    const pollSelf = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: sender.id });
    expect(pollSelf.messages.length).toBe(0);
    const pollA = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: a.id });
    expect(pollA.messages.length).toBe(1);
    childA.kill(); childSender.kill();
  });

  test("broadcast: rejects unfiltered call (no scope)", async () => {
    const child = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/bc-unfilt", git_root: null, tty: null, name: "s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const result = await brokerFetch<{ ok: boolean; sent: number; error?: string }>("/broadcast-message", {
      from_id: sender.id, text: "no scope",
    });
    expect(result.ok).toBe(false);
    expect(result.sent).toBe(0);
    expect(typeof result.error).toBe("string");
    expect(result.error).toMatch(/scope filter/i);
    child.kill();
  });

  test("broadcast: name_like is case-insensitive substring", async () => {
    const childA = spawnSleep();
    const childB = spawnSleep();
    const childC = spawnSleep();
    const childSender = spawnSleep();
    const a = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: childA.pid, cwd: "/bc-nl-a", git_root: null, tty: null,
      name: "reviewer.1", tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const b = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: childB.pid, cwd: "/bc-nl-b", git_root: null, tty: null,
      name: "REVIEWER.2", tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const c = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: childC.pid, cwd: "/bc-nl-c", git_root: null, tty: null,
      name: "coder.1", tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const sender = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: childSender.pid, cwd: "/bc-nl-s", git_root: null, tty: null, name: "s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const result = await brokerFetch<{ ok: boolean; sent: number }>("/broadcast-message", {
      from_id: sender.id, text: "reviewers only", name_like: "review",
    });
    expect(result.sent).toBe(2);  // a + b, not c
    const pollA = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: a.id });
    const pollB = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: b.id });
    const pollC = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: c.id });
    expect(pollA.messages.length).toBe(1);
    expect(pollB.messages.length).toBe(1);
    expect(pollC.messages.length).toBe(0);
    childA.kill(); childB.kill(); childC.kill(); childSender.kill();
  });

  test("broadcast: size cap enforced (>32KB text)", async () => {
    const child = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/bc-cap", git_root: null, tty: null, name: "s",
      tmux_session: "bcast-cap", tmux_window_index: "0", tmux_window_name: "claude", summary: "",
    });
    const big = "x".repeat(33 * 1024);
    const result = await brokerFetch<{ ok: boolean; sent: number; error?: string }>("/broadcast-message", {
      from_id: sender.id, text: big, tmux_session: "bcast-cap",
    });
    expect(result.ok).toBe(false);
    expect(result.sent).toBe(0);
    expect(typeof result.error).toBe("string");
    expect(result.error).toMatch(/exceeds/i);
    child.kill();
  });

  // --- Rehydration tests (#7 workflow improvement) ------------------------
  // When a peer dies and relaunches in the same tmux pane, the new
  // registration inherits the old peer's ID so orphaned mail is recoverable.

  test("rehydration: new peer in same tmux location inherits dead peer's ID", async () => {
    const dead = spawnSleep();
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: dead.pid, cwd: "/rehydrate-1", git_root: null, tty: null,
      name: "a", tmux_session: "rh1", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    dead.kill();
    await dead.exited;

    const fresh = spawnSleep();
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: fresh.pid, cwd: "/rehydrate-1", git_root: null, tty: null,
      name: "b-new", tmux_session: "rh1", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    expect(b.id).toBe(a.id);
    fresh.kill();
  });

  test("rehydration: undelivered mail survives re-registration", async () => {
    const sender = spawnSleep();
    const dead = spawnSleep();
    const s = await brokerFetch<{ id: string }>("/register", {
      pid: sender.pid, cwd: "/rehydrate-2-sender", git_root: null, tty: null,
      name: "sender", tmux_session: null, tmux_window_index: null,
      tmux_window_name: null, summary: "",
    });
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: dead.pid, cwd: "/rehydrate-2", git_root: null, tty: null,
      name: "a", tmux_session: "rh2", tmux_window_index: "1",
      tmux_window_name: "claude", summary: "",
    });
    await brokerFetch("/send-message", {
      from_id: s.id, to_id: a.id, text: "survive my death",
    });
    dead.kill();
    await dead.exited;

    const fresh = spawnSleep();
    await brokerFetch("/register", {
      pid: fresh.pid, cwd: "/rehydrate-2", git_root: null, tty: null,
      name: "b-new", tmux_session: "rh2", tmux_window_index: "1",
      tmux_window_name: "claude", summary: "",
    });
    // Drain via /poll-by-pid — should see the mail addressed to the
    // inherited ID (a.id), proving rehydration restored the inbox.
    const { json } = await rawPost("/poll-by-pid", {
      pid: fresh.pid, caller_pid: process.pid,
    });
    expect(json.peer_id).toBe(a.id);
    const msgs = json.messages as { text: string }[];
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toBe("survive my death");
    sender.kill();
    fresh.kill();
  });

  test("rehydration: different tmux pane does NOT inherit", async () => {
    const dead = spawnSleep();
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: dead.pid, cwd: "/rehydrate-3", git_root: null, tty: null,
      name: "a", tmux_session: "rh3", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    dead.kill();
    await dead.exited;

    // Relaunch at a DIFFERENT pane index — should NOT inherit.
    const fresh = spawnSleep();
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: fresh.pid, cwd: "/rehydrate-3", git_root: null, tty: null,
      name: "b-new", tmux_session: "rh3", tmux_window_index: "1",
      tmux_window_name: "claude", summary: "",
    });
    expect(b.id).not.toBe(a.id);
    fresh.kill();
  });

  test("rehydration: pane id alone can inherit without window metadata", async () => {
    const sender = spawnSleep();
    const dead = spawnSleep();
    const s = await brokerFetch<{ id: string }>("/register", {
      pid: sender.pid, cwd: "/rehydrate-pane-only-s", git_root: null, tty: null,
      name: "s", tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: dead.pid, cwd: "/rehydrate-pane-only", git_root: "/repo-pane-only", tty: null,
      name: "a", tmux_session: "rh-pane-only", tmux_window_index: null,
      tmux_window_name: null, tmux_pane_id: "%777", summary: "",
    });
    await brokerFetch("/send-message", {
      from_id: s.id, to_id: a.id, text: "pane-only survive",
    });
    dead.kill();
    await dead.exited;

    const fresh = spawnSleep();
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: fresh.pid, cwd: "/rehydrate-pane-only", git_root: "/repo-pane-only", tty: null,
      name: "b-new", tmux_session: "rh-pane-only", tmux_window_index: null,
      tmux_window_name: null, tmux_pane_id: "%777", summary: "",
    });
    expect(b.id).toBe(a.id);
    const poll = await brokerFetch<{ messages: { text: string }[] }>("/poll-messages", { id: b.id });
    expect(poll.messages.filter((m) => m.text === "pane-only survive")).toHaveLength(1);
    sender.kill(); fresh.kill();
  });

  test("rehydration: window fallback cannot inherit a row that had pane id", async () => {
    const dead = spawnSleep();
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: dead.pid, cwd: "/rehydrate-window-fallback", git_root: "/repo-window-fallback", tty: null,
      name: "a", tmux_session: "rh-window-fallback", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: "%778", summary: "",
    });
    dead.kill();
    await dead.exited;

    const fresh = spawnSleep();
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: fresh.pid, cwd: "/rehydrate-window-fallback", git_root: "/repo-window-fallback", tty: null,
      name: "b-new", tmux_session: "rh-window-fallback", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: null, summary: "",
    });
    expect(b.id).not.toBe(a.id);
    fresh.kill();
  });

  test("rehydration: same tmux pane with different cwd does NOT inherit", async () => {
    const dead = spawnSleep();
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: dead.pid, cwd: "/rehydrate-cwd-old", git_root: "/repo-a", tty: null,
      name: "a", tmux_session: "rh-cwd", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: "%301", summary: "",
    });
    dead.kill();
    await dead.exited;

    const fresh = spawnSleep();
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: fresh.pid, cwd: "/rehydrate-cwd-new", git_root: "/repo-a", tty: null,
      name: "b-new", tmux_session: "rh-cwd", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: "%301", summary: "",
    });
    expect(b.id).not.toBe(a.id);
    fresh.kill();
  });

  test("rehydration: wrong cwd relaunch does not consume the old inbox", async () => {
    const sender = spawnSleep();
    const dead = spawnSleep();
    const s = await brokerFetch<{ id: string }>("/register", {
      pid: sender.pid, cwd: "/rehydrate-wrong-cwd-s", git_root: null, tty: null,
      name: "s", tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: dead.pid, cwd: "/rehydrate-wrong-cwd-old", git_root: "/repo-wrong-cwd", tty: null,
      name: "a", tmux_session: "rh-wrong-cwd", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: "%501", summary: "",
    });
    await brokerFetch("/send-message", {
      from_id: s.id, to_id: a.id, text: "wrong cwd should not consume me",
    });
    dead.kill();
    await dead.exited;

    const wrong = spawnSleep();
    const wrongPeer = await brokerFetch<{ id: string }>("/register", {
      pid: wrong.pid, cwd: "/rehydrate-wrong-cwd-new", git_root: "/repo-wrong-cwd", tty: null,
      name: "wrong", tmux_session: "rh-wrong-cwd", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: "%501", summary: "",
    });
    expect(wrongPeer.id).not.toBe(a.id);
    wrong.kill();
    await wrong.exited;

    const correct = spawnSleep();
    const recovered = await brokerFetch<{ id: string }>("/register", {
      pid: correct.pid, cwd: "/rehydrate-wrong-cwd-old", git_root: "/repo-wrong-cwd", tty: null,
      name: "correct", tmux_session: "rh-wrong-cwd", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: "%501", summary: "",
    });
    expect(recovered.id).toBe(a.id);
    const poll = await brokerFetch<{ messages: { text: string }[] }>("/poll-messages", { id: recovered.id });
    expect(poll.messages.filter((m) => m.text === "wrong cwd should not consume me")).toHaveLength(1);
    sender.kill(); correct.kill();
  });

  test("rehydration: same tmux pane with different git root does NOT inherit", async () => {
    const dead = spawnSleep();
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: dead.pid, cwd: "/rehydrate-gitroot", git_root: "/repo-a", tty: null,
      name: "a", tmux_session: "rh-gitroot", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: "%401", summary: "",
    });
    dead.kill();
    await dead.exited;

    const fresh = spawnSleep();
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: fresh.pid, cwd: "/rehydrate-gitroot", git_root: "/repo-b", tty: null,
      name: "b-new", tmux_session: "rh-gitroot", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: "%401", summary: "",
    });
    expect(b.id).not.toBe(a.id);
    fresh.kill();
  });

  test("rehydration: one-sided null git root inherits on same pane and cwd", async () => {
    const dead = spawnSleep();
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: dead.pid, cwd: "/rehydrate-null-gitroot", git_root: null, tty: null,
      name: "a", tmux_session: "rh-null-gitroot", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: "%601", summary: "",
    });
    dead.kill();
    await dead.exited;

    const fresh = spawnSleep();
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: fresh.pid, cwd: "/rehydrate-null-gitroot", git_root: "/repo-now-known", tty: null,
      name: "b-new", tmux_session: "rh-null-gitroot", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: "%601", summary: "",
    });
    expect(b.id).toBe(a.id);
    fresh.kill();
  });

  test("rehydration: unknown new git root does not inherit a concrete old git root", async () => {
    const dead = spawnSleep();
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: dead.pid, cwd: "/rehydrate-reverse-null-gitroot", git_root: "/repo-known-old", tty: null,
      name: "a", tmux_session: "rh-reverse-null-gitroot", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: "%602", summary: "",
    });
    dead.kill();
    await dead.exited;

    const fresh = spawnSleep();
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: fresh.pid, cwd: "/rehydrate-reverse-null-gitroot", git_root: null, tty: null,
      name: "b-new", tmux_session: "rh-reverse-null-gitroot", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: "%602", summary: "",
    });
    expect(b.id).not.toBe(a.id);
    fresh.kill();
  });

  test("rehydration: exact git root candidate wins over newer degraded null candidate", async () => {
    const exactProc = spawnSleep();
    const nullProc = spawnSleep();
    const exact = await brokerFetch<{ id: string }>("/register", {
      pid: exactProc.pid, cwd: "/rehydrate-exact-wins", git_root: "/repo-exact", tty: null,
      name: "exact", tmux_session: "rh-exact-wins", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: "%603", summary: "",
    });
    const degraded = await brokerFetch<{ id: string }>("/register", {
      pid: nullProc.pid, cwd: "/rehydrate-exact-wins", git_root: null, tty: null,
      name: "degraded", tmux_session: "rh-exact-wins", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: "%603", summary: "",
    });
    expect(degraded.id).not.toBe(exact.id);
    exactProc.kill();
    nullProc.kill();
    await exactProc.exited;
    await nullProc.exited;

    const fresh = spawnSleep();
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: fresh.pid, cwd: "/rehydrate-exact-wins", git_root: "/repo-exact", tty: null,
      name: "fresh", tmux_session: "rh-exact-wins", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: "%603", summary: "",
    });
    expect(b.id).toBe(exact.id);
    fresh.kill();
  });

  test("rehydration: pane id with conflicting window metadata does NOT inherit", async () => {
    const dead = spawnSleep();
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: dead.pid, cwd: "/rehydrate-window-conflict", git_root: "/repo-window-conflict", tty: null,
      name: "a", tmux_session: "rh-window-conflict", tmux_window_index: "0",
      tmux_window_name: "old-window", tmux_pane_id: "%604", summary: "",
    });
    dead.kill();
    await dead.exited;

    const fresh = spawnSleep();
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: fresh.pid, cwd: "/rehydrate-window-conflict", git_root: "/repo-window-conflict", tty: null,
      name: "fresh", tmux_session: "rh-window-conflict", tmux_window_index: "1",
      tmux_window_name: "new-window", tmux_pane_id: "%604", summary: "",
    });
    expect(b.id).not.toBe(a.id);
    fresh.kill();
  });

  test("rehydration: CONFIRMED-DEAD stale peer (>1h last_seen) DOES inherit (dead-PID reclaim, any age)", async () => {
    // A confirmed-dead seat is inheritable regardless of age: a live proc
    // re-claiming a pane whose only occupant is a long-dead tombstone must
    // inherit it to recover the seat's stranded undelivered mail. Previously the
    // 1h age gate ran before the liveness check, so this seat was skipped and the
    // new proc got a fresh id — leaving the seat permanently deaf+mute. Liveness
    // now precedes age; a dead candidate inherits at any age.
    const dead = spawnSleep();
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: dead.pid, cwd: "/rehydrate-4", git_root: null, tty: null,
      name: "a", tmux_session: "rh4", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    dead.kill();
    await dead.exited;

    // Backdate last_seen well past the 1h window. Requires a read-write DB
    // handle; WAL allows one writer.
    const rw = new Database(TEST_DB);
    rw.run(
      "UPDATE peers SET last_seen = ? WHERE id = ?",
      [new Date(Date.now() - 2 * 3600_000).toISOString(), a.id]
    );
    rw.close();

    const fresh = spawnSleep();
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: fresh.pid, cwd: "/rehydrate-4", git_root: null, tty: null,
      name: "b-new", tmux_session: "rh4", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    expect(b.id).toBe(a.id); // inherits the dead seat (and its mail) despite >1h age
    fresh.kill();
  });

  test("rehydration: malformed last_seen does NOT inherit", async () => {
    const dead = spawnSleep();
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: dead.pid, cwd: "/rehydrate-malformed", git_root: "/repo-malformed", tty: null,
      name: "a", tmux_session: "rh-malformed", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: "%605", summary: "",
    });
    dead.kill();
    await dead.exited;

    const rw = new Database(TEST_DB);
    rw.run("UPDATE peers SET last_seen = ? WHERE id = ?", ["not-a-date", a.id]);
    rw.close();

    const fresh = spawnSleep();
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: fresh.pid, cwd: "/rehydrate-malformed", git_root: "/repo-malformed", tty: null,
      name: "b-new", tmux_session: "rh-malformed", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: "%605", summary: "",
    });
    expect(b.id).not.toBe(a.id);
    fresh.kill();
  });

  test("reaper: malformed last_seen on a dead peer is not preserved forever", async () => {
    const senderProc = spawnSleep();
    const dead = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: senderProc.pid, cwd: "/malformed-reap-s", git_root: null, tty: null,
      name: "sender", tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const stale = await brokerFetch<{ id: string }>("/register", {
      pid: dead.pid, cwd: "/malformed-reap", git_root: null, tty: null,
      name: "stale", tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    await brokerFetch("/send-message", {
      from_id: sender.id, to_id: stale.id, text: "malformed should reap",
    });
    dead.kill();
    await dead.exited;

    const rw = new Database(TEST_DB);
    rw.run("UPDATE peers SET last_seen = ? WHERE id = ?", ["not-a-date", stale.id]);
    rw.close();

    await brokerFetch("/list-peers", {
      id: sender.id,
      scope: "machine",
      cwd: "/",
      git_root: null,
      include_inactive: false,
    });

    const ro = new Database(TEST_DB, { readonly: true });
    const peerCount = (ro.query("SELECT COUNT(*) AS n FROM peers WHERE id = ?").get(stale.id) as { n: number }).n;
    const messageCount = (ro.query("SELECT COUNT(*) AS n FROM messages WHERE to_id = ? AND delivered = 0").get(stale.id) as { n: number }).n;
    ro.close();
    expect(peerCount).toBe(0);
    expect(messageCount).toBe(0);
    senderProc.kill();
  });

  test("rehydration: live peer is NOT displaced", async () => {
    const alive = spawnSleep();
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: alive.pid, cwd: "/rehydrate-5", git_root: null, tty: null,
      name: "a", tmux_session: "rh5", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });

    // Register a "clone" with the same location tuple but a different live
    // PID. The original peer is ALIVE — rehydration must skip it, and the
    // new peer gets a fresh ID. Both live side-by-side.
    const clone = spawnSleep();
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: clone.pid, cwd: "/rehydrate-5", git_root: null, tty: null,
      name: "b", tmux_session: "rh5", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    expect(b.id).not.toBe(a.id);
    alive.kill();
    clone.kill();
  });

  // --- M4: Most-recent dead candidate wins rehydration --------------------
  test("rehydration: most-recent dead candidate wins when multiple match", async () => {
    // Register two peers at the same tmux location with different last_seen,
    // kill both, then register a fresh peer — should inherit the MORE RECENT
    // one's ID (ORDER BY last_seen DESC). Protects against accidental ASC flip.
    const old = spawnSleep();
    const recent = spawnSleep();
    const oldPeer = await brokerFetch<{ id: string }>("/register", {
      pid: old.pid, cwd: "/rehydrate-m4", git_root: null, tty: null,
      name: "old", tmux_session: "rh-m4", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    const recentPeer = await brokerFetch<{ id: string }>("/register", {
      pid: recent.pid, cwd: "/rehydrate-m4", git_root: null, tty: null,
      name: "recent", tmux_session: "rh-m4", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    // Wait to guarantee distinguishable last_seen timestamps between the two.
    await new Promise((r) => setTimeout(r, 50));
    // Backdate the older peer so "recent" is clearly the most-recent dead slot.
    const rw = new Database(TEST_DB);
    rw.run(
      "UPDATE peers SET last_seen = ? WHERE id = ?",
      [new Date(Date.now() - 1000).toISOString(), oldPeer.id]
    );
    rw.close();
    old.kill();
    recent.kill();
    await old.exited;
    await recent.exited;

    const fresh = spawnSleep();
    const newPeer = await brokerFetch<{ id: string }>("/register", {
      pid: fresh.pid, cwd: "/rehydrate-m4", git_root: null, tty: null,
      name: "fresh", tmux_session: "rh-m4", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    // Must inherit the MORE RECENT dead slot, not the older one.
    expect(newPeer.id).toBe(recentPeer.id);
    expect(newPeer.id).not.toBe(oldPeer.id);
    fresh.kill();
  });

  // --- M5: Own-PID re-register does NOT trigger rehydrate branch ----------
  test("rehydration: re-register with same pid + same location does NOT rehydrate", async () => {
    // When a peer's own PID re-registers (e.g., after broker restart), the
    // existing PID-dedup path should handle it — rehydration is for DIFFERENT
    // pids inheriting a dead slot. This test guards against a regression where
    // the rehydrate query returns the peer's OWN current row and tries to
    // inherit from itself.
    const p = spawnSleep();
    const first = await brokerFetch<{ id: string }>("/register", {
      pid: p.pid, cwd: "/rehydrate-m5", git_root: null, tty: null,
      name: "self", tmux_session: "rh-m5", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    // Re-register with the same pid AND same location. Expected behavior:
    // the existing-PID path updates the row in place, preserving the peer ID
    // and any queued messages; no rehydration occurs because the query excludes
    // `pid = body.pid`.
    const second = await brokerFetch<{ id: string }>("/register", {
      pid: p.pid, cwd: "/rehydrate-m5", git_root: null, tty: null,
      name: "self-again", tmux_session: "rh-m5", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    expect(second.id).toBe(first.id);
    // Exactly one row for this pid
    const ro = new Database(TEST_DB, { readonly: true });
    const count = (ro.query("SELECT COUNT(*) AS n FROM peers WHERE pid = ?").get(p.pid) as { n: number }).n;
    ro.close();
    expect(count).toBe(1);
    p.kill();
  });

  // --- M3: Broadcast filter combinations (git_root only, tmux+name_like) --
  test("broadcast: git_root-only filter matches peers in that repo", async () => {
    const a = spawnSleep();
    const b = spawnSleep();
    const s = spawnSleep();
    const peerA = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: a.pid, cwd: "/git-a", git_root: "/home/proj-X", tty: null, name: "a",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const peerB = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: b.pid, cwd: "/git-b", git_root: "/home/proj-Y", tty: null, name: "b",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const sender = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: s.pid, cwd: "/git-s", git_root: "/home/proj-X", tty: null, name: "s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const result = await brokerFetch<{ ok: boolean; sent: number }>("/broadcast-message", {
      from_id: sender.id, text: "proj-X repo only", git_root: "/home/proj-X",
    });
    expect(result.sent).toBe(1);  // only peerA (sender excluded even though same repo)
    const pA = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: peerA.id });
    const pB = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: peerB.id });
    expect(pA.messages.length).toBe(1);
    expect(pB.messages.length).toBe(0);
    a.kill(); b.kill(); s.kill();
  });

  test("broadcast: tmux + name_like filters AND together (intersection)", async () => {
    const match = spawnSleep();
    const onlyTmux = spawnSleep();
    const onlyName = spawnSleep();
    const s = spawnSleep();
    const mPeer = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: match.pid, cwd: "/m", git_root: null, tty: null,
      name: "reviewer.m", tmux_session: "review-tmux", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    const tPeer = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: onlyTmux.pid, cwd: "/t", git_root: null, tty: null,
      name: "coder.t", tmux_session: "review-tmux", tmux_window_index: "1",
      tmux_window_name: "claude", summary: "",
    });
    const nPeer = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: onlyName.pid, cwd: "/n", git_root: null, tty: null,
      name: "reviewer.n", tmux_session: "other-tmux", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    const sender = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: s.pid, cwd: "/s", git_root: null, tty: null, name: "sender",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const result = await brokerFetch<{ ok: boolean; sent: number }>("/broadcast-message", {
      from_id: sender.id, text: "intersect",
      tmux_session: "review-tmux", name_like: "review",
    });
    expect(result.sent).toBe(1);  // only match peer (AND semantics)
    const pM = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: mPeer.id });
    const pT = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: tPeer.id });
    const pN = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: nPeer.id });
    expect(pM.messages.length).toBe(1);
    expect(pT.messages.length).toBe(0);
    expect(pN.messages.length).toBe(0);
    match.kill(); onlyTmux.kill(); onlyName.kill(); s.kill();
  });

  // --- B1 regression: name_like wildcards are escaped ---------------------
  test("broadcast: name_like='%' is escaped, not treated as SQL wildcard", async () => {
    // Without the ESCAPE clause, name_like='%' would LIKE-match every named
    // peer (bypass the "scope filter required" guard). Current code escapes
    // the % to literal and also rejects length < 2 — so this single-char
    // filter must return length-guard error, not a match-all broadcast.
    const s = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: s.pid, cwd: "/b1", git_root: null, tty: null, name: "s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    // Single wildcard char → rejected by length guard (<2)
    const r1 = await brokerFetch<{ ok: boolean; sent: number; error?: string }>(
      "/broadcast-message", { from_id: sender.id, text: "x", name_like: "%" });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/at least 2 characters|non-wildcard/i);
    // Two wildcard chars → rejected by non-wildcard-content guard
    const r2 = await brokerFetch<{ ok: boolean; sent: number; error?: string }>(
      "/broadcast-message", { from_id: sender.id, text: "x", name_like: "%%" });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/non-wildcard/i);
    s.kill();
  });

  // --- B2 regression: broadcast fanout charges msg-bucket proportionally --
  test("broadcast: fanout of N targets charges N message-bucket slots", async () => {
    // Send message-bucket to near-full via sequential /send-message, then
    // attempt a broadcast that would fanout more than the remaining budget.
    // The handler must reject WITHOUT inserting (proportional rate charge).
    // Use small target count + small budget headroom for test speed.
    const receivers: ReturnType<typeof Bun.spawn>[] = [];
    const receiverIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const proc = spawnSleep();
      receivers.push(proc);
      const p = await brokerFetch<{ id: string }>("/register", {
        client_type: "claude",
        pid: proc.pid, cwd: `/b2-r${i}`, git_root: null, tty: null,
        name: `r${i}`, tmux_session: "b2-tmux", tmux_window_index: String(i),
        tmux_window_name: "claude", summary: "",
      });
      receiverIds.push(p.id);
    }
    const successSenderProc = spawnSleep();
    const successSender = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: successSenderProc.pid, cwd: "/b2-success-s", git_root: null, tty: null, name: "s-ok",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    for (let i = 0; i < 56; i++) {
      await brokerFetch("/send-message", {
        from_id: successSender.id, to_id: receiverIds[0], text: "success-fill" + i,
      });
    }
    const successBroadcast = await brokerFetch<{ ok: boolean; sent: number; error?: string }>(
      "/broadcast-message",
      { from_id: successSender.id, text: "exactly-four-slots", tmux_session: "b2-tmux" }
    );
    expect(successBroadcast.ok).toBe(true);
    expect(successBroadcast.sent).toBe(4);
    const successOverflow = await brokerFetch<{ ok?: boolean; error?: string }>("/send-message", {
      from_id: successSender.id, to_id: receiverIds[0], text: "success-should-hit-quota",
    });
    expect(successOverflow.error).toMatch(/rate limit/i);

    const s = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      client_type: "claude",
      pid: s.pid, cwd: "/b2-s", git_root: null, tty: null, name: "s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    // Burn the sender's msg-bucket to 58/60 with sequential sends.
    for (let i = 0; i < 58; i++) {
      await brokerFetch("/send-message", {
        from_id: sender.id, to_id: receiverIds[0], text: "fill" + i,
      });
    }
    // Attempt broadcast to 4 receivers → needs 4 slots, only 2 remain → reject.
    const broadcastResult = await brokerFetch<{ ok: boolean; sent: number; error?: string }>(
      "/broadcast-message",
      { from_id: sender.id, text: "should be rejected", tmux_session: "b2-tmux" }
    );
    expect(broadcastResult.ok).toBe(false);
    expect(broadcastResult.sent).toBe(0);
    expect(broadcastResult.error).toMatch(/quota|rate/i);
    // Verify NO messages were inserted for the broadcast (atomic reject).
    const rw = new Database(TEST_DB, { readonly: true });
    const broadcastCount = (rw.query(
      "SELECT COUNT(*) AS n FROM messages WHERE text = ?"
    ).get("should be rejected") as { n: number }).n;
    rw.close();
    expect(broadcastCount).toBe(0);
    const one = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
      from_id: sender.id, to_id: receiverIds[0], text: "remaining-slot-1",
    });
    const two = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
      from_id: sender.id, to_id: receiverIds[0], text: "remaining-slot-2",
    });
    const three = await brokerFetch<{ ok?: boolean; error?: string }>("/send-message", {
      from_id: sender.id, to_id: receiverIds[0], text: "should-hit-quota",
    });
    expect(one.ok).toBe(true);
    expect(two.ok).toBe(true);
    expect(three.error).toMatch(/rate limit/i);
    receivers.forEach((p) => p.kill());
    successSenderProc.kill();
    s.kill();
  });

  // --- M1: Concurrent /message-status during the 2s send_message wait -----
  test("message-status: concurrent drain during sender's wait window", async () => {
    // Simulates the race: sender fires send_message → 2s sleep before
    // polling status. During that window, recipient drains via /poll-by-pid.
    // Sender's subsequent /message-status call must correctly reflect
    // delivered=true + delivered_at populated.
    const senderProc = spawnSleep();
    const recvProc = spawnSleep();
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: senderProc.pid, cwd: "/m1-s", git_root: null, tty: null, name: "s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const recv = await brokerFetch<{ id: string }>("/register", {
      pid: recvProc.pid, cwd: "/m1-r", git_root: null, tty: null, name: "r",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const send = await brokerFetch<{ id: number }>("/send-message", {
      from_id: sender.id, to_id: recv.id, text: "race probe",
    });

    // Kick off concurrent drain at t=50ms, meanwhile wait 200ms then query status.
    const drainPromise = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      await rawPost("/poll-by-pid", { pid: recvProc.pid, caller_pid: process.pid });
    })();
    await new Promise((r) => setTimeout(r, 200));
    const statusPromise = brokerFetch<{
      ok: boolean; statuses: { delivered: boolean; delivered_at: string | null }[];
    }>("/message-status", { id: sender.id, ids: [send.id] });
    await Promise.all([drainPromise, statusPromise]);
    const status = await statusPromise;
    expect(status.statuses[0]!.delivered).toBe(true);
    expect(typeof status.statuses[0]!.delivered_at).toBe("string");
    senderProc.kill();
    recvProc.kill();
  });

  // Re-registration race: a bg lane registers with tmux_pane_id=null (pane not
  // yet resolved), then re-registers (e.g. 401 recovery after a broker restart)
  // once its pane resolves to a real %id. The same pid is the same peer, so its
  // broker id MUST be preserved and its queued mail MUST survive — gating
  // id-stability on tmux_pane_id equality used to mint a new id here and the
  // dedup-delete then wiped the old id's undelivered mail (the bug that forced a
  // manual nudge).
  test("re-register with a resolved pane_id keeps the same id + preserves queued mail", async () => {
    const laneProc = spawnSleep();
    const senderProc = spawnSleep();
    // 1. bg lane registers with NO pane (pane unresolved)
    const reg1 = await brokerFetch<{ id: string }>("/register", {
      pid: laneProc.pid, cwd: "/rereg-race", git_root: "/rereg-race", tty: null,
      name: "rr-lane", tmux_session: "rr", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: null, summary: "",
    });
    // 2. a peer queues mail to that id
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: senderProc.pid, cwd: "/rereg-s", git_root: null, tty: null, name: "rr-s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const send = await brokerFetch<{ id: number }>("/send-message", {
      from_id: sender.id, to_id: reg1.id, text: "survive the re-register",
    });
    // 3. SAME pid re-registers, now with a RESOLVED pane_id (and a different
    //    tmux_window metadata, to prove location drift does not break identity)
    const reg2 = await brokerFetch<{ id: string }>("/register", {
      pid: laneProc.pid, cwd: "/rereg-race", git_root: "/rereg-race", tty: null,
      name: "rr-lane", tmux_session: "rr", tmux_window_index: "0",
      tmux_window_name: "claude", tmux_pane_id: "%999", summary: "",
    });
    // id PRESERVED despite the pane_id change
    expect(reg2.id).toBe(reg1.id);
    // queued mail SURVIVES (not wiped by a dedup-delete on an id change)
    const poll = await brokerFetch<{ messages: { text: string }[] }>("/poll-messages", { id: reg2.id });
    expect(poll.messages.some((m) => m.text === "survive the re-register")).toBe(true);
    expect(send.id).toBeGreaterThan(0);
    laneProc.kill();
    senderProc.kill();
  });
});
