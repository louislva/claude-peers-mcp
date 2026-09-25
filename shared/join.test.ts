import { expect, test } from "bun:test";
import { joinSession, type JoinDeps } from "./join.ts";

function deps(over: Partial<JoinDeps> = {}) {
 const calls: [string, any][] = [];
 const d: JoinDeps = {
  env: { CODEX_THREAD_ID: "01a0da49-dc8f-7420-bf85-feeeb7bdd0fb", CODEX_SHELL: "1" },
  post: async (path, body) => { calls.push([path, body]);
   if (path === "/resolve-session") return { peer: null };
   if (path === "/list-peers") return [{ id: "p-mine", pid: 200, online: 1 }, { id: "p-other", pid: 300, online: 1 }];
   if (path === "/bind-session") return { id: body.id };
   return { ok: true, id: body.id };
  },
  ancestors: () => [150, 100, 1],
  parentOf: (pid) => ({ 200: 100, 300: 99 } as Record<number, number>)[pid],
  ...over,
 };
 return { d, calls };
}

test("join binds, opts in and sets status in one step, using only this session's own ids", async () => {
 const { d, calls } = deps();
 const r = await joinSession(d, "reviewing the EOY plan");
 expect(r).toMatchObject({ peer_id: "p-mine", harness: "codex", host_session_id: "01a0da49-dc8f-7420-bf85-feeeb7bdd0fb", bound: "now", wake: "on" });
 expect(calls.map(c => c[0])).toEqual(["/resolve-session", "/list-peers", "/bind-session", "/opt-in", "/set-summary"]);
 expect(calls[2]![1]).toEqual({ id: "p-mine", session_key: "01a0da49-dc8f-7420-bf85-feeeb7bdd0fb" });
 expect(calls[3]![1]).toEqual({ id: "p-mine", harness: "codex", host_session_id: "01a0da49-dc8f-7420-bf85-feeeb7bdd0fb" });
 expect(calls[4]![1]).toEqual({ id: "p-mine", summary: "reviewing the EOY plan" });
});
test("an already-bound session skips binding", async () => {
 const { d, calls } = deps({ post: async (path, body) => { calls.push([path, body]); return path === "/resolve-session" ? { peer: { id: "p-mine" } } : { ok: true }; } });
 expect((await joinSession(d)).bound).toBe("already");
 expect(calls.map(c => c[0])).toEqual(["/resolve-session", "/opt-in"]);
});
test("Claude desktop joins with its host id, keyed by its transcript session id", async () => {
 const { d, calls } = deps({ env: { CLAUDE_CODE_HOST_SESSION_ID: "local_a7661a7f-932d-4a9a-aee7-eacd33e50365", CLAUDE_CODE_SESSION_ID: "f1f6b49e-0070-471e-b278-077eb7f1c882" } });
 await joinSession(d);
 expect(calls[0]![1]).toEqual({ session_key: "f1f6b49e-0070-471e-b278-077eb7f1c882" });
 expect(calls[3]![1].harness).toBe("claude-desktop");
});
test("refuses to guess when no claude-peers connection belongs to this session", async () => {
 const { d } = deps({ parentOf: () => 42 });
 await expect(joinSession(d)).rejects.toThrow("no claude-peers connection");
});
test("refuses when two connections could be this session", async () => {
 const { d } = deps({ parentOf: () => 100 });
 await expect(joinSession(d)).rejects.toThrow("2 claude-peers connections");
});
test("a CLI or unattended session gets a clear no-address error", async () => {
 const { d } = deps({ env: { CLAUDE_CODE_SESSION_ID: "f1f6b49e-0070-471e-b278-077eb7f1c882" } });
 await expect(joinSession(d)).rejects.toThrow("no wake address");
});
