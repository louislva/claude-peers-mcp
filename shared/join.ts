import { wakeIdentityFromEnv } from "./wake-identity.ts";

export interface JoinDeps {
  env: Record<string, string | undefined>;
  post(path: string, body: unknown): Promise<any>;
  /** pids of this process's ancestors, nearest first */
  ancestors(): number[];
  parentOf(pid: number): number | undefined;
}

/**
 * One step: find THIS session's claude-peers connection, bind it to the
 * session's own id, opt in with its own wake address, optionally set status.
 * Identity comes only from this process's environment and process tree; it
 * never guesses from cwd, and it refuses when the match is not unique.
 */
export async function joinSession(d: JoinDeps, status?: string) {
  const identity = wakeIdentityFromEnv(d.env);
  if (!identity) throw new Error("This session has no wake address (not a Claude desktop session or Codex task). CLI and unattended sessions can't be woken; hooks still deliver mail at each turn.");
  const sessionKey = identity.harness === "codex" ? identity.host_session_id : d.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionKey) throw new Error("Missing CLAUDE_CODE_SESSION_ID; can't bind the mailbox.");
  let peerId: string, bound: "already" | "now";
  const resolved = await d.post("/resolve-session", { session_key: sessionKey });
  if (resolved?.peer?.id) { peerId = resolved.peer.id; bound = "already"; }
  else {
    // The session's own claude-peers MCP server shares an ancestor (the harness process) with this shell.
    const mine = new Set(d.ancestors());
    const peers = await d.post("/list-peers", { scope: "machine", cwd: "/", git_root: null }) as { id: string; pid: number }[];
    const matches = peers.filter(p => { const parent = d.parentOf(p.pid); return parent !== undefined && mine.has(parent); });
    if (matches.length === 0) throw new Error("Found no claude-peers connection for this session. Is the claude-peers MCP server enabled here?");
    if (matches.length > 1) throw new Error(`Found ${matches.length} claude-peers connections that could be this session; refusing to guess. Bind with the set_summary [session:${sessionKey}] step instead.`);
    peerId = (await d.post("/bind-session", { id: matches[0]!.id, session_key: sessionKey })).id ?? matches[0]!.id;
    bound = "now";
  }
  await d.post("/opt-in", { id: peerId, ...identity });
  if (status) await d.post("/set-summary", { id: peerId, summary: status });
  return { peer_id: peerId, harness: identity.harness, host_session_id: identity.host_session_id, session_key: sessionKey, bound, wake: "on" as const, status: status ?? null };
}
