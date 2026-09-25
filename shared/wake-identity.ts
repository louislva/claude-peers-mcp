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

/** In a hook: Codex gives the thread id as the hook's session_id even when the env lacks CODEX_THREAD_ID. */
export function hookWakeIdentity(env: Record<string,string|undefined>, sessionId?: string) {
  const fromEnv = wakeIdentityFromEnv(env);
  if (fromEnv) return fromEnv;
  const isCodex = Object.keys(env).some(k => k.startsWith("CODEX_"));
  if (isCodex && sessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) return {harness:"codex" as const,host_session_id:sessionId};
  return null;
}
