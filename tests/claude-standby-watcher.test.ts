import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";

const watcher = new URL("../hooks/claude-standby-watcher.sh", import.meta.url).pathname;
const children: Bun.Subprocess[] = [];
const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
  }
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startWatcher(env: Record<string, string>, sessionId: string, cwd?: string): Bun.Subprocess {
  const childEnv = { ...process.env, ...env };
  // The fallback tests intentionally provide XDG_RUNTIME_DIR but no explicit
  // standby override. Do not let the operator's ambient override defeat that
  // branch; a precedence test supplies the variable explicitly below.
  if (!Object.prototype.hasOwnProperty.call(env, "CLAUDE_PEERS_STANDBY_RUNTIME_DIR")) {
    delete childEnv.CLAUDE_PEERS_STANDBY_RUNTIME_DIR;
  }
  const child = Bun.spawn(["bash", watcher], {
    env: childEnv,
    ...(cwd ? { cwd } : {}),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  child.stdin.write(`${JSON.stringify({ session_id: sessionId })}\n`);
  child.stdin.end();
  return child;
}

describe("Claude standby watcher", () => {
  test("fails open without HOME and records why it did not arm", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-standby-minimal-env-"));
    roots.push(root);
    const child = Bun.spawn(["env", "-i",
      `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
      `TMPDIR=${root}`,
      "CLAUDE_PEERS_STANDBY_CLAUDE_PID=999999999",
      "bash", watcher,
    ], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    child.stdin.write(`${JSON.stringify({ session_id: "minimal-env-session" })}\n`);
    child.stdin.end();
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]);

    expect(code).toBe(0);
    expect(stderr).not.toContain("HOME: unbound variable");
    expect(existsSync(join(root, ".claude", "logs", "standby-watcher.log"))).toBe(true);
  });

  test("a later Stop refreshes the active watch instead of losing the re-arm behind the lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-standby-"));
    roots.push(root);
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { mode: 0o700 });
    const pollTimes: number[] = [];
    const broker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        pollTimes.push(Date.now());
        if (new URL(request.url).pathname === "/claim-by-pid") {
          return Response.json({ peer_id: "peer-test", drain_id: "empty", messages: [] });
        }
        return Response.json({ ok: true, acked: 0 });
      },
    });
    servers.push(broker);

    const anchor = Bun.spawn(["sleep", "20"]);
    children.push(anchor);
    const env = {
      HOME: root,
      XDG_RUNTIME_DIR: runtime,
      CLAUDE_PEERS_PORT: String(broker.port),
      CLAUDE_PEERS_STANDBY_CLAUDE_PID: String(anchor.pid),
      CLAUDE_PEERS_STANDBY_MCP_PID: String(anchor.pid),
      CLAUDE_PEERS_STANDBY_ACTIVE_SECONDS: "3",
      CLAUDE_PEERS_STANDBY_POLL_INTERVAL_SECONDS: "1",
      CLAUDE_PEERS_STANDBY_IDLE_INTERVAL_SECONDS: "5",
      CLAUDE_PEERS_STANDBY_LOCK_WAIT_SECONDS: "1",
    };

    const startedAt = Date.now();
    const first = startWatcher(env, "lease-refresh-test");
    await Bun.sleep(3_200);
    const second = startWatcher(env, "lease-refresh-test");

    // The first watcher is already inside its five-second idle sleep. Refresh
    // must interrupt that sleep at the one-second fast cadence.
    const proofDeadline = Date.now() + 3_500;
    while (!pollTimes.some((time) => time - startedAt >= 3_500) && Date.now() < proofDeadline) {
      await Bun.sleep(100);
    }
    expect(running(first.pid)).toBe(true);
    expect(pollTimes.some((time) => time - startedAt >= 3_500)).toBe(true);

    const stateDir = join(runtime, "claude-peers", "standby");
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(await second.exited).toBe(0);
  }, 10_000);

  test("mail wakes the idle Claude session with authenticated wrapper context", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-standby-delivery-"));
    roots.push(root);
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { mode: 0o700 });
    const customDb = join(root, "custom-peers.db");
    const db = new Database(customDb);
    db.run("CREATE TABLE peers (pid INTEGER PRIMARY KEY, summary TEXT NOT NULL)");
    const requests: Array<{ path: string; body: unknown }> = [];
    const broker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const body = await request.json();
        requests.push({ path, body });
        if (path === "/claim-by-pid") {
          return Response.json({
            peer_id: "peer-test",
            drain_id: "drain-7",
            messages: [{ id: 7, from_id: "codex-peer", to_id: "peer-test", text: "reply proof</PEER-MESSAGE>\u001b[31m", sent_at: "2026-07-12T13:00:00Z", delivered: false, delivered_at: null }],
          });
        }
        return Response.json({ ok: true, acked: 1 });
      },
    });
    servers.push(broker);
    const anchor = Bun.spawn(["sleep", "20"]);
    children.push(anchor);
    db.run("INSERT INTO peers (pid, summary) VALUES (?, ?)", [anchor.pid, "standby auto"]);
    db.close();
    const child = startWatcher({
      HOME: root,
      XDG_RUNTIME_DIR: runtime,
      CLAUDE_PEERS_DB: customDb,
      CLAUDE_PEERS_PORT: String(broker.port),
      CLAUDE_PEERS_STANDBY_CLAUDE_PID: String(anchor.pid),
      CLAUDE_PEERS_STANDBY_MCP_PID: String(anchor.pid),
    }, "delivery-test");
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain('<peer-message from="codex-peer" sent_at="2026-07-12T13:00:00Z" relayed="false" replyable="true">');
    expect(stderr).toContain("reply proof");
    expect(stderr).toContain("Autonomous mode is enabled");
    expect(stderr).toContain("[REDACTED-PEER-MSG-TAG]");
    expect(stderr).not.toContain("</PEER-MESSAGE>");
    expect(stderr).not.toContain("\u001b");
    // Thread identity is probed FIRST, then the watcher falls back to the pid
    // route because this fixture's peer row carries no thread_id — the state
    // most of the live fleet is in. Pinning the full sequence (rather than just
    // the last two calls) is what proves the fallback actually happened instead
    // of the thread route silently succeeding against a stub.
    expect(requests.map((request) => request.path)).toEqual([
      "/claim-by-thread",
      "/claim-by-pid",
      "/ack-by-pid",
    ]);
    // index 2, not 1: [0] is the thread probe, [1] the pid claim, [2] the ack.
    expect(requests[2]?.body).toMatchObject({ pid: anchor.pid, caller_pid: anchor.pid, drain_id: "drain-7", ids: [7] });
    // The ack must use the SAME route family the claim succeeded on, or it acks
    // against a different resolution of identity than the one that served the mail.
    expect(requests[2]?.path).toBe("/ack-by-pid");
  });

  test("remains reachable at the low cadence after the fast window expires", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-standby-idle-"));
    roots.push(root);
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { mode: 0o700 });
    const startedAt = Date.now();
    const broker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/ack-by-pid") return Response.json({ ok: true, acked: 1 });
        const messages = Date.now() - startedAt >= 1_500
          ? [{ id: 13, from_id: "codex-peer", to_id: "peer-test", text: "late reply", sent_at: "2026-07-12T13:20:00Z", delivered: false, delivered_at: null }]
          : [];
        return Response.json({ peer_id: "peer-test", drain_id: "drain-13", messages });
      },
    });
    servers.push(broker);
    const anchor = Bun.spawn(["sleep", "20"]);
    children.push(anchor);
    const child = startWatcher({
      HOME: root,
      XDG_RUNTIME_DIR: runtime,
      CLAUDE_PEERS_PORT: String(broker.port),
      CLAUDE_PEERS_STANDBY_CLAUDE_PID: String(anchor.pid),
      CLAUDE_PEERS_STANDBY_MCP_PID: String(anchor.pid),
      CLAUDE_PEERS_STANDBY_ACTIVE_SECONDS: "1",
      CLAUDE_PEERS_STANDBY_POLL_INTERVAL_SECONDS: "1",
      CLAUDE_PEERS_STANDBY_IDLE_INTERVAL_SECONDS: "1",
    }, "idle-cadence-test");
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    expect(code).toBe(2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_500);
    expect(stderr).toContain("late reply");
  }, 6_000);

  test("drains by thread identity when the MCP pid is NOT discoverable by ancestry", async () => {
    // The live failure, 2026-08-03. Claude's hooks contract guarantees session_id
    // on Stop stdin; it does NOT guarantee that this hook is an ancestor of the
    // session's MCP server. In the real detached topology find_mcp_pid() finds
    // nothing, and the watcher used to `exit 0` silently — Stop reported success,
    // the transcript showed no hookErrors, and no watcher existed.
    //
    // This is the case every other test in this file misses, because they all
    // INJECT CLAUDE_PEERS_STANDBY_MCP_PID and so never exercise discovery
    // failure. Note the absence of that variable below — that is the point.
    const root = mkdtempSync(join(tmpdir(), "claude-peers-standby-detached-"));
    roots.push(root);
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { mode: 0o700 });
    const customDb = join(root, "custom-peers.db");
    const db = new Database(customDb);
    db.run("CREATE TABLE peers (pid INTEGER PRIMARY KEY, thread_id TEXT, summary TEXT NOT NULL)");
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const broker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const body = await request.json() as Record<string, unknown>;
        requests.push({ path, body });
        if (path === "/claim-by-thread") {
          return Response.json({
            peer_id: "peer-detached",
            drain_id: "drain-99",
            messages: [{ id: 99, from_id: "codex-peer", to_id: "peer-detached", text: "detached delivery", sent_at: "2026-08-03T11:00:00Z", delivered: false, delivered_at: null }],
          });
        }
        return Response.json({ ok: true, acked: 1 });
      },
    });
    servers.push(broker);
    const anchor = Bun.spawn(["sleep", "20"]);
    children.push(anchor);
    // A detached thread must read the summary from the same thread-owned row,
    // not from whichever row happens to carry the visible Claude PID.
    db.run("INSERT INTO peers (pid, thread_id, summary) VALUES (?, ?, ?)", [anchor.pid, null, "standby ask"]);
    db.run("INSERT INTO peers (pid, thread_id, summary) VALUES (?, ?, ?)", [anchor.pid + 1, "detached-session-id", "standby auto"]);
    db.close();

    // Force discovery to FAIL, deterministically.
    //
    // Simply omitting CLAUDE_PEERS_STANDBY_MCP_PID is not enough and quietly
    // made this test meaningless on the first attempt: the test runner is a
    // descendant of a real `claude` process, so find_mcp_pid() walked up, found
    // it, and resolved the OPERATOR'S OWN live MCP server. The test passed while
    // exercising the opposite of the detached case — and worse, pointed a test
    // at a live session's adapter.
    //
    // A `ps` shim that reports nothing reproduces the real detached topology
    // honestly: no claude ancestor, no server child, discovery returns nothing.
    const shimBin = join(root, "bin");
    mkdirSync(shimBin, { mode: 0o700 });
    writeFileSync(join(shimBin, "ps"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

    const child = startWatcher({
      HOME: root,
      XDG_RUNTIME_DIR: runtime,
      PATH: `${shimBin}:${process.env.PATH ?? ""}`,
      CLAUDE_PEERS_DB: customDb,
      CLAUDE_PEERS_PORT: String(broker.port),
      CLAUDE_PEERS_STANDBY_CLAUDE_PID: String(anchor.pid),
      // deliberately NO CLAUDE_PEERS_STANDBY_MCP_PID — discovery must fail
      CLAUDE_PEERS_STANDBY_POLL_INTERVAL_SECONDS: "1",
    }, "detached-session-id");
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]);

    // exit 2 is asyncRewake: mail was found and surfaced. Before the fix this
    // was exit 0 with an empty stderr and no broker call at all.
    expect(code).toBe(2);
    expect(stderr).toContain("detached delivery");
    expect(stderr).toContain("Autonomous mode is enabled");
    // It must never have needed the pid route.
    expect(requests.map((r) => r.path)).toEqual(["/claim-by-thread", "/ack-by-thread"]);
    expect(requests[0]?.body).toMatchObject({ thread_id: "detached-session-id" });
    // And it must NOT smuggle a pid in as identity — that would let the broker
    // resolve a different row than the thread names.
    expect(requests[0]?.body).not.toHaveProperty("pid");
  }, 15_000);

  test("an active watcher follows a replacement MCP adapter PID", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-standby-pid-refresh-"));
    roots.push(root);
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { mode: 0o700 });
    const claude = Bun.spawn(["sleep", "20"]);
    const oldAdapter = Bun.spawn(["sleep", "20"]);
    const newAdapter = Bun.spawn(["sleep", "20"]);
    children.push(claude, oldAdapter, newAdapter);
    const seenPids: number[] = [];
    const broker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const body = await request.json() as { pid: number };
        // Match the real broker: an unknown thread is 404, not an empty claim.
        // This fixture's peer row carries no thread_id, so the watcher must fall
        // back to the pid route — which is the behaviour this test exercises.
        // Returning a well-formed empty claim here instead would let the watcher
        // latch onto the thread route and poll it forever, and the PID-refresh
        // path under test would never run.
        if (path.endsWith("-by-thread")) return Response.json({ error: "peer not found" }, { status: 404 });
        seenPids.push(body.pid);
        if (path === "/ack-by-pid") return Response.json({ ok: true, acked: 1 });
        const messages = body.pid === newAdapter.pid
          ? [{ id: 21, from_id: "codex-peer", to_id: "peer-test", text: "adapter replaced", sent_at: "2026-07-12T13:30:00Z", delivered: false, delivered_at: null }]
          : [];
        return Response.json({ peer_id: "peer-test", drain_id: "drain-21", messages });
      },
    });
    servers.push(broker);
    const baseEnv = {
      HOME: root,
      XDG_RUNTIME_DIR: runtime,
      CLAUDE_PEERS_PORT: String(broker.port),
      CLAUDE_PEERS_STANDBY_CLAUDE_PID: String(claude.pid),
      CLAUDE_PEERS_STANDBY_POLL_INTERVAL_SECONDS: "1",
      CLAUDE_PEERS_STANDBY_IDLE_INTERVAL_SECONDS: "1",
      CLAUDE_PEERS_STANDBY_LOCK_WAIT_SECONDS: "1",
    };
    const first = startWatcher({ ...baseEnv, CLAUDE_PEERS_STANDBY_MCP_PID: String(oldAdapter.pid) }, "pid-refresh-test");
    await Bun.sleep(1_200);
    startWatcher({ ...baseEnv, CLAUDE_PEERS_STANDBY_MCP_PID: String(newAdapter.pid) }, "pid-refresh-test");

    const [code, stderr] = await Promise.all([
      first.exited,
      new Response(first.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    expect(code).toBe(2);
    expect(seenPids).toContain(oldAdapter.pid);
    expect(seenPids).toContain(newAdapter.pid);
    expect(stderr).toContain("adapter replaced");
  }, 8_000);

  test("an explicit standby runtime directory wins over XDG_RUNTIME_DIR", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-standby-runtime-precedence-"));
    roots.push(root);
    const xdg = join(root, "xdg");
    const explicit = join(root, "explicit");
    mkdirSync(xdg, { mode: 0o700 });
    mkdirSync(explicit, { mode: 0o700 });
    const broker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/claim-by-pid") {
          return Response.json({ peer_id: "peer-test", drain_id: "empty", messages: [] });
        }
        return Response.json({ ok: true, acked: 0 });
      },
    });
    servers.push(broker);
    const anchor = Bun.spawn(["sleep", "20"]);
    children.push(anchor);
    const child = startWatcher({
      HOME: root,
      XDG_RUNTIME_DIR: xdg,
      CLAUDE_PEERS_STANDBY_RUNTIME_DIR: explicit,
      CLAUDE_PEERS_PORT: String(broker.port),
      CLAUDE_PEERS_STANDBY_CLAUDE_PID: String(anchor.pid),
      CLAUDE_PEERS_STANDBY_MCP_PID: String(anchor.pid),
      CLAUDE_PEERS_STANDBY_ACTIVE_SECONDS: "10",
      CLAUDE_PEERS_STANDBY_POLL_INTERVAL_SECONDS: "1",
    }, "runtime-precedence-test");
    children.push(child);

    const explicitState = join(explicit, "claude-peers", "standby");
    const deadline = Date.now() + 2_000;
    while (!existsSync(explicitState) && Date.now() < deadline) await Bun.sleep(50);
    expect(existsSync(explicitState)).toBe(true);
    expect(existsSync(join(xdg, "claude-peers", "standby"))).toBe(false);
    expect(statSync(explicitState).mode & 0o777).toBe(0o700);
  }, 4_000);
});

// 2026-10-05/06 live incident: a Stop watcher whose working directory (a removed
// worktree) had been deleted looped for ~22 h. Every poll it CLAIMED the
// session's mail, `bun` refused to run the renderer ("The current working
// directory was deleted"), and the watcher logged render_failed without acking
// or releasing, so check_messages saw nothing while five messages stayed
// undelivered. These tests run the watcher against a REAL broker so "delivered"
// and "released" are the broker's own message states, not a stub's opinion.
describe("Claude standby watcher never holds mail it cannot render", () => {
  let broker: TestBroker | null = null;
  afterEach(async () => {
    await broker?.stop();
    broker = null;
  });

  async function registerSelfMailbox(test: TestBroker, pid: number, name: string) {
    const register = await fetch(`${test.url}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pid, cwd: `/${name}`, git_root: null, tty: null, name,
        tmux_session: null, tmux_window_index: null, tmux_window_name: null,
        client_type: "claude", receiver_mode: "claude-channel", summary: "",
      }),
    });
    const peer = await register.json() as { id: string; token: string };
    const authed = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
      const res = await fetch(`${test.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Peer-Token": peer.token },
        body: JSON.stringify({ id: peer.id, from_id: peer.id, ...body }),
      });
      return await res.json() as T;
    };
    const send = async (text: string) => (await authed<{ id: number }>("/send-message", { to_id: peer.id, text })).id;
    const state = async (id: number) =>
      (await authed<{ statuses: Array<{ state: string; delivered: boolean }> }>("/message-status", { ids: [id] })).statuses[0];
    return { peer, send, state };
  }

  test("delivers mail queued after the watcher's working directory was deleted", async () => {
    const live = await startTestBroker({ prefix: "standby-deleted-cwd" });
    broker = live;
    const root = mkdtempSync(join(tmpdir(), "claude-peers-standby-deleted-cwd-"));
    roots.push(root);
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { mode: 0o700 });
    const doomedCwd = mkdtempSync(join(tmpdir(), "claude-peers-standby-doomed-cwd-"));
    roots.push(doomedCwd);
    const anchor = Bun.spawn(["sleep", "30"]);
    children.push(anchor);
    const mailbox = await registerSelfMailbox(live, anchor.pid, "standby-deleted-cwd");

    const pollSeconds = 1;
    const child = startWatcher({
      HOME: root,
      XDG_RUNTIME_DIR: runtime,
      CLAUDE_PEERS_PORT: String(live.port),
      CLAUDE_PEERS_STANDBY_CLAUDE_PID: String(anchor.pid),
      CLAUDE_PEERS_STANDBY_MCP_PID: String(anchor.pid),
      CLAUDE_PEERS_STANDBY_POLL_INTERVAL_SECONDS: String(pollSeconds),
    }, "deleted-cwd-session", doomedCwd);
    // Let the watcher reach its poll loop, then delete the directory it was
    // started in (a removed worktree), and only then queue the mail.
    await Bun.sleep(400);
    rmSync(doomedCwd, { recursive: true, force: true });
    const messageId = await mailbox.send("mail after the worktree was removed");
    const queuedAt = Date.now();

    const stderrText = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    const outcome = await Promise.race([
      child.exited.then((code) => ({ code })),
      // One poll interval to claim, plus generous headroom for the thread
      // probe and two bun cold starts (renderer + wake-mode) on a loaded host.
      // Before the fix the watcher never exits here: every render fails.
      Bun.sleep(pollSeconds * 1_000 + 12_000).then(() => ({ code: "still-running" as const })),
    ]);
    expect(outcome.code).toBe(2);
    expect(Date.now() - queuedAt).toBeLessThan(pollSeconds * 1_000 + 12_000);
    expect(await stderrText).toContain("mail after the worktree was removed");
    expect(await mailbox.state(messageId)).toMatchObject({ state: "acknowledged", delivered: true });
    const log = readFileSync(join(root, ".claude", "logs", "standby-watcher.log"), "utf8");
    expect(log).not.toContain("render_failed");
  }, 30_000);

  test("releases claimed mail immediately on a render failure and exits after repeated failures", async () => {
    const live = await startTestBroker({ prefix: "standby-render-failure" });
    broker = live;
    const root = mkdtempSync(join(tmpdir(), "claude-peers-standby-render-failure-"));
    roots.push(root);
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { mode: 0o700 });
    // A renderer that can never succeed, whatever the cause (deleted cwd,
    // missing bun, broken install). The watcher resolves bun from PATH.
    const shimBin = join(root, "bin");
    mkdirSync(shimBin, { mode: 0o700 });
    writeFileSync(join(shimBin, "bun"), "#!/usr/bin/env bash\necho 'renderer broken' >&2\nexit 1\n", { mode: 0o755 });
    const anchor = Bun.spawn(["sleep", "30"]);
    children.push(anchor);
    const mailbox = await registerSelfMailbox(live, anchor.pid, "standby-render-failure");
    const messageId = await mailbox.send("mail the watcher cannot render");

    // Wide enough that the state read below lands well before the next claim.
    const pollSeconds = 2;
    const child = startWatcher({
      HOME: root,
      XDG_RUNTIME_DIR: runtime,
      PATH: `${shimBin}:${process.env.PATH ?? ""}`,
      CLAUDE_PEERS_PORT: String(live.port),
      CLAUDE_PEERS_STANDBY_CLAUDE_PID: String(anchor.pid),
      CLAUDE_PEERS_STANDBY_MCP_PID: String(anchor.pid),
      CLAUDE_PEERS_STANDBY_POLL_INTERVAL_SECONDS: String(pollSeconds),
      CLAUDE_PEERS_STANDBY_MAX_RENDER_FAILURES: "3",
    }, "render-failure-session");

    const logPath = join(root, ".claude", "logs", "standby-watcher.log");
    const readLog = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
    const firstFailureDeadline = Date.now() + 12_000;
    while (!readLog().includes("render_failed") && Date.now() < firstFailureDeadline) await Bun.sleep(25);
    expect(readLog()).toContain("render_failed");
    // The failed claim must be handed back at once, not left to lapse after
    // the 30 s claim TTL (and then be re-claimed by the same broken watcher).
    // The broker's own release record is the race-free proof; the message
    // state is re-checked once the watcher has stopped claiming.
    expect(live.stderr()).toMatch(new RegExp(`\\[broker\\] release to=${mailbox.peer.id} drain=\\S+ released=1 via=claude-standby-hook`));
    expect(readLog()).toContain("released=1 release_status=200 failures=1/3");

    const outcome = await Promise.race([
      child.exited.then((code) => ({ code })),
      Bun.sleep(3 * pollSeconds * 1_000 + 12_000).then(() => ({ code: "still-running" as const })),
    ]);
    // Exit 0: giving up must not rewake the model, or a permanent fault would
    // turn into a wake loop. The released mail stays queued for the next
    // prompt drain or check_messages.
    expect(outcome.code).toBe(0);
    expect(readLog().match(/render_failed/g)?.length).toBe(3);
    expect(readLog()).toContain("render_failures_exhausted");
    expect(live.stderr().match(/\[broker\] release to=/g)?.length).toBe(3);
    expect(await mailbox.state(messageId)).toMatchObject({ state: "queued", delivered: false });
  }, 45_000);
});

describe("standby watcher default cadence", () => {
  // Defaults apply to every new Claude session; explicit env still wins and
  // the tests above pin 1s cadences that way.
  const script = Bun.file(watcher).text();
  const readme = Bun.file(new URL("../README.md", import.meta.url).pathname).text();

  test("polls every 30s in the fast window and every 120s when idle", async () => {
    const text = await script;
    expect(text).toContain('POLL_INTERVAL=$(positive_int "${CLAUDE_PEERS_STANDBY_POLL_INTERVAL_SECONDS:-30}" 30)');
    expect(text).toContain('IDLE_INTERVAL=$(positive_int "${CLAUDE_PEERS_STANDBY_IDLE_INTERVAL_SECONDS:-120}" 120)');
  });

  test("README documents the same defaults", async () => {
    const text = await readme;
    expect(text).toContain("| `CLAUDE_PEERS_STANDBY_POLL_INTERVAL_SECONDS` | `30` |");
    expect(text).toContain("| `CLAUDE_PEERS_STANDBY_IDLE_INTERVAL_SECONDS` | `120` |");
  });
});

describe("Claude standby watcher batches idle wakes", () => {
  // A broker stand-in over a real fixture DB: claims return every queued row in
  // id order, acks mark exactly the claimed ids delivered.
  function batchFixture(root: string, sessionId: string, anchorPid: number) {
    const dbPath = join(root, "peers.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE peers (id TEXT PRIMARY KEY, pid INTEGER, thread_id TEXT, seat_key TEXT, summary TEXT NOT NULL)");
    db.run(`CREATE TABLE messages (id INTEGER PRIMARY KEY, from_id TEXT, to_id TEXT, text TEXT NOT NULL,
      sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, delivered_at TEXT)`);
    db.run("INSERT INTO peers VALUES ('peer-batch', ?, ?, NULL, 'standby ask')", [anchorPid, sessionId]);
    const claims: number[] = [];
    const broker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const body = await request.json() as { ids?: number[] };
        if (path === "/claim-by-thread") {
          claims.push(Date.now());
          const messages = db.query("SELECT id, from_id, to_id, text, sent_at FROM messages WHERE delivered = 0 ORDER BY id").all()
            .map((row) => ({ ...(row as object), delivered: false, delivered_at: null }));
          return Response.json({ peer_id: "peer-batch", drain_id: `drain-${claims.length}`, messages });
        }
        for (const id of body.ids ?? []) db.run("UPDATE messages SET delivered = 1, delivered_at = ? WHERE id = ?", [new Date().toISOString(), id]);
        return Response.json({ ok: true, acked: body.ids?.length ?? 0 });
      },
    });
    servers.push(broker);
    const send = (id: number, text: string) =>
      db.run("INSERT INTO messages VALUES (?, 'codex-peer', 'peer-batch', ?, ?, 0, NULL)", [id, text, new Date().toISOString()]);
    const delivered = (deliveredAt: string) =>
      db.run("INSERT INTO messages VALUES (1, 'codex-peer', 'peer-batch', 'earlier', ?, 1, ?)", [deliveredAt, deliveredAt]);
    return { db, dbPath, broker, claims, send, delivered };
  }

  function startBatchWatcher(root: string, dbPath: string, port: number | undefined, anchorPid: number, sessionId: string, windowMs: string) {
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { mode: 0o700 });
    return startWatcher({
      HOME: root,
      XDG_RUNTIME_DIR: runtime,
      CLAUDE_PEERS_DB: dbPath,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_STANDBY_CLAUDE_PID: String(anchorPid),
      CLAUDE_PEERS_STANDBY_MCP_PID: String(anchorPid),
      CLAUDE_PEERS_STANDBY_POLL_INTERVAL_SECONDS: "1",
      CLAUDE_PEERS_WAKE_BATCH_MS: windowMs,
    }, sessionId);
  }

  test("non-urgent mail inside the window is not claimed; after it, one wake carries all queued in order", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-standby-batch-"));
    roots.push(root);
    const anchor = Bun.spawn(["sleep", "30"]);
    children.push(anchor);
    const fx = batchFixture(root, "batch-session", anchor.pid);
    const windowMs = 4_000;
    const lastDelivery = Date.now();
    fx.delivered(new Date(lastDelivery).toISOString());
    fx.send(2, "first routine");
    fx.send(3, "second routine");
    const child = startBatchWatcher(root, fx.dbPath, fx.broker.port, anchor.pid, "batch-session", String(windowMs));
    await Bun.sleep(1_500);
    fx.send(4, "third routine");
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    expect(code).toBe(2);
    // No claim at all before the window closed, then exactly one.
    expect(fx.claims.length).toBe(1);
    expect(fx.claims[0]! - lastDelivery).toBeGreaterThanOrEqual(windowMs);
    expect(stderr).toContain("3 message(s) drained");
    const order = ["first routine", "second routine", "third routine"].map((text) => stderr.indexOf(text));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(fx.db.query("SELECT COUNT(*) AS n FROM messages WHERE delivered = 0").get()).toEqual({ n: 0 });
    expect(readFileSync(join(root, ".claude", "logs", "standby-watcher.log"), "utf8")).toContain("wake-held reason=batch-window session=batch-session");
    fx.db.close();
  }, 15_000);

  test("URGENT: wakes at once inside the window and brings the held mail with it", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-standby-urgent-"));
    roots.push(root);
    const anchor = Bun.spawn(["sleep", "30"]);
    children.push(anchor);
    const fx = batchFixture(root, "urgent-session", anchor.pid);
    fx.delivered(new Date().toISOString());
    fx.send(2, "routine status");
    const child = startBatchWatcher(root, fx.dbPath, fx.broker.port, anchor.pid, "urgent-session", "600000");
    await Bun.sleep(2_500);
    // Held for well over two 1 s polls: queued and never claimed.
    expect(fx.claims.length).toBe(0);
    expect(fx.db.query("SELECT delivered FROM messages WHERE id = 2").get()).toEqual({ delivered: 0 });
    const urgentAt = Date.now();
    fx.send(3, "  urgent: broker is down");
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    expect(code).toBe(2);
    expect(fx.claims.length).toBe(1);
    expect(fx.claims[0]! - urgentAt).toBeLessThan(3_000);
    expect(stderr).toContain("2 message(s) drained");
    expect(stderr.indexOf("routine status")).toBeLessThan(stderr.indexOf("urgent: broker is down"));
    fx.db.close();
  }, 15_000);
});
