import { join } from "node:path";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCAL=/^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AddressEvidence {
  /** The peer's MCP server process command line + environment (`ps eww`). */
  processEnv(pid: number): string;
  /** True if a Codex rollout file exists for this thread id. */
  codexThreadExists(threadId: string): boolean;
}

/**
 * Find a peer's wake address from hard evidence only: the harness's own ids
 * in the peer's MCP server environment (Claude desktop), or a Codex rollout
 * file for the thread the peer is bound to. Returns null rather than guess.
 */
export function resolveAddress(peer: {pid:number,session_key:string|null}, ev: AddressEvidence) {
  const vars=Object.fromEntries(ev.processEnv(peer.pid).split(/\s+/).filter(t=>t.includes("=")).map(t=>[t.slice(0,t.indexOf("=")),t.slice(t.indexOf("=")+1)]));
  const host=vars.CLAUDE_CODE_HOST_SESSION_ID;
  if (host && LOCAL.test(host) && (!peer.session_key || vars.CLAUDE_CODE_SESSION_ID===peer.session_key)) return {harness:"claude-desktop" as const,host_session_id:host};
  const thread=vars.CODEX_THREAD_ID ?? peer.session_key;
  if (thread && UUID.test(thread) && ev.codexThreadExists(thread)) return {harness:"codex" as const,host_session_id:thread};
  return null;
}

/** True if a Codex rollout file for this thread exists under root (tolerates stray files like .DS_Store). */
export function codexThreadExistsIn(root: string, threadId: string): boolean {
  if (!UUID.test(threadId)) return false;
  for (const _ of new Bun.Glob(`*/*/*/rollout-*-${threadId}.jsonl`).scanSync({cwd:root,onlyFiles:true})) return true;
  return false;
}

export const liveEvidence: AddressEvidence = {
  processEnv: pid => new TextDecoder().decode(Bun.spawnSync(["ps","eww","-o","command=","-p",String(pid)]).stdout),
  codexThreadExists: threadId => { try { return codexThreadExistsIn(join(process.env.HOME ?? "",".codex","sessions"),threadId); } catch { return false; } },
};
