import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { hookResponse, stagingCommand } from "../hooks/peers-hook.ts";
import type { UnreadSummaryResponse } from "../shared/types.ts";

const HOOK = `${import.meta.dir}/../hooks/peers-hook.ts`;
const unread: UnreadSummaryResponse = { count: 2, senders: ["a6d396fa"], peer_ids: ["p1"] };
const none: UnreadSummaryResponse = { count: 0, senders: [], peer_ids: ["p1"] };

test("Stop blocks while peer messages are unread and names the sender", () => {
  const out = JSON.parse(hookResponse("claude", { hook_event_name: "Stop" }, unread)!);
  expect(out.decision).toBe("block");
  expect(out.reason).toContain("2 unread peer message(s) from a6d396fa");
  expect(out.reason).toContain("check_messages");
});

test("Stop stays silent when a previous block already continued the turn", () => {
  expect(hookResponse("codex", { hook_event_name: "Stop", stop_hook_active: true }, unread)).toBeNull();
});

test("every event stays silent when nothing is unread", () => {
  for (const hook_event_name of ["Stop", "UserPromptSubmit", "SessionStart"]) {
    expect(hookResponse("codex", { hook_event_name }, none)).toBeNull();
  }
  expect(hookResponse("claude", { hook_event_name: "PreToolUse", tool_input: { command: "git commit -m x" } }, none)).toBeNull();
});

test("a malformed broker reply, such as an old broker's 404 body, is treated as nothing unread", () => {
  const malformed = { error: "not found" } as unknown as UnreadSummaryResponse;
  expect(hookResponse("claude", { hook_event_name: "Stop" }, malformed)).toBeNull();
});

// Codex documents PreToolUse hookSpecificOutput.additionalContext as model-visible, non-blocking
// context (developers.openai.com/codex/hooks, "PreToolUse"); Claude Code accepts the same shape.
test("PreToolUse warns before git staging, committing, or pushing while messages are unread", () => {
  for (const command of ["git add src/a.rs", "git commit -m 'x'", "git -C /repo push origin main"]) {
    const out = JSON.parse(hookResponse("claude", { hook_event_name: "PreToolUse", tool_input: { command } }, unread)!);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("before staging or pushing");
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
  }
});

test("PreToolUse ignores commands that do not stage, commit, or push", () => {
  for (const command of ["git status", "git log --oneline", "cargo test", "echo git adder"]) {
    expect(stagingCommand({ tool_input: { command } })).toBe(false);
  }
  expect(stagingCommand({ tool_input: { command: ["git", "commit", "-m", "x"] } })).toBe(true);
});

test("UserPromptSubmit adds the unread count as context", () => {
  const out = JSON.parse(hookResponse("claude", { hook_event_name: "UserPromptSubmit" }, unread)!);
  expect(out.hookSpecificOutput.additionalContext).toContain("2 unread peer message(s)");
});

// Output shape per developers.openai.com/codex/hooks (SessionStart hookSpecificOutput.additionalContext).
test("SessionStart adds unread context for Codex in the documented JSON shape, and nothing for Claude", () => {
  const out = JSON.parse(hookResponse("codex", { hook_event_name: "SessionStart" }, unread)!);
  expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(out.hookSpecificOutput.additionalContext).toContain("2 unread peer message(s)");
  expect(hookResponse("claude", { hook_event_name: "SessionStart" }, unread)).toBeNull();
});

// --- End to end against a fake broker ---

const dir = mkdtempSync("/tmp/cph-");
const sock = `${dir}/broker.sock`;
const logFile = `${dir}/hook.log`;
const setWakeCalls: any[] = [];
let setWakeReply: object = { ok: true, updated: 1 };
let summary: UnreadSummaryResponse = unread;

function logLines(): string[] {
  return existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean) : [];
}
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    unix: sock,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = await req.json();
      if (path === "/set-wake") {
        setWakeCalls.push(body);
        return Response.json(setWakeReply);
      }
      if (path === "/unread-summary") return Response.json(summary);
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function runHook(harness: string, payload: object, socketPath = sock) {
  const proc = Bun.spawn(["bun", HOOK, "--harness", harness], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDE_PEERS_SOCKET: socketPath,
      CLAUDE_PEERS_AGENT_PID: "4958",
      CLAUDE_PEERS_HOOK_LOG: logFile,
    },
  });
  const stdout = await new Response(proc.stdout).text();
  return { stdout, code: await proc.exited };
}

test("Codex SessionStart registers its thread with the broker and reports unread messages", async () => {
  summary = unread;
  const { stdout, code } = await runHook("codex", {
    hook_event_name: "SessionStart",
    session_id: "01a0e3fd-3e76-7c21-98ac-a3ba3c98f4a1",
  });
  expect(code).toBe(0);
  expect(setWakeCalls.at(-1)).toEqual({
    agent_pid: 4958,
    transport: "codex_queue",
    address: "01a0e3fd-3e76-7c21-98ac-a3ba3c98f4a1",
  });
  expect(stdout).toContain("2 unread peer message(s) from a6d396fa");
});

// SessionStart can run before the MCP server registers (developers.openai.com/codex/hooks,
// "Execution and lifecycle"), so later events carrying session_id repeat the registration.
test("Codex UserPromptSubmit and Stop repeat the thread registration", async () => {
  summary = none;
  const before = setWakeCalls.length;
  await runHook("codex", { hook_event_name: "UserPromptSubmit", session_id: "thread-repeat" });
  await runHook("codex", { hook_event_name: "Stop", session_id: "thread-repeat" });
  expect(setWakeCalls.slice(before).map((c) => c.address)).toEqual(["thread-repeat", "thread-repeat"]);
});

test("a thread registration that updated no peer is logged, with no output", async () => {
  summary = none;
  setWakeReply = { ok: true, updated: 0 };
  const { stdout, code } = await runHook("codex", { hook_event_name: "SessionStart", session_id: "thread-early" });
  setWakeReply = { ok: true, updated: 1 };
  expect(code).toBe(0);
  expect(stdout).toBe("");
  expect(logLines().at(-1)).toContain("set-wake updated no peer");
});

test("an unreachable broker is logged while the hook stays silent", async () => {
  const before = logLines().length;
  await runHook("claude", { hook_event_name: "Stop" }, `${dir}/missing.sock`);
  expect(logLines().length).toBe(before + 1);
});

test("the Stop hook script blocks through the broker when messages are unread", async () => {
  summary = unread;
  const { stdout } = await runHook("claude", { hook_event_name: "Stop", stop_hook_active: false });
  expect(JSON.parse(stdout).decision).toBe("block");
});

test("the hook fails open with no output when the broker is unreachable", async () => {
  const { stdout, code } = await runHook("claude", { hook_event_name: "Stop" }, `${dir}/missing.sock`);
  expect(code).toBe(0);
  expect(stdout).toBe("");
});
