import type { WakeHarness } from "./store.ts";

/**
 * Derive this session's wake address from the harness's own environment,
 * never from tool arguments: a session may only opt ITSELF in.
 * Claude desktop exposes CLAUDE_CODE_HOST_SESSION_ID (local_…), the id the
 * app's SendMessage tool addresses; Codex exposes CODEX_THREAD_ID, the id
 * `codex queue --thread` addresses. CLI sessions have neither.
 */
export function wakeIdentityFromEnv(env: Record<string,string|undefined>): {harness:WakeHarness,host_session_id:string} | null {
  if (env.CLAUDE_CODE_HOST_SESSION_ID) return {harness:"claude-desktop",host_session_id:env.CLAUDE_CODE_HOST_SESSION_ID};
  if (env.CODEX_THREAD_ID) return {harness:"codex",host_session_id:env.CODEX_THREAD_ID};
  return null;
}
