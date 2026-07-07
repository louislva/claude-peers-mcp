/**
 * Pure parsing helpers for F2 tmux process-ancestry detection.
 *
 * These live in shared/ rather than server.ts so tests can import them
 * without triggering server.ts's top-level main() side effects (which
 * would spawn a broker, register a peer, and start the poll loop).
 */

export interface TmuxPaneInfo {
  session: string;
  // Optional as of Fix B (2026-05-12): parseTmuxPanes always populates these
  // from live tmux output (which guarantees non-empty values), but
  // composeTmuxFromEnv may omit them when the bashrc env hint exports
  // SESSION but not the window context (or exports them as empty strings).
  // Without this nullability, env-hint registers would store "" while
  // live-walk registers store the actual values — a schema-shape drift that
  // (1) silently disables broker rehydration (broker.ts:508 guard `&&
  // body.tmux_window_name` is falsy on ""), and (2) renders ugly trailing
  // colons in `[tmux session:]` summary tags. Optional + `?? null` at the
  // register-payload site keeps both paths converging on `null` for absent.
  window_index?: string;
  window_name?: string;
  // Optional — present when the producing format string includes
  // `#{pane_index}` (5th tab-separated field). Stays undefined for
  // legacy 4-field input so old tests / callers don't break.
  pane_index?: string;
  pane_id?: string;
}

/**
 * Parse output of `tmux list-panes -a -F "#{pane_pid}\t#{session_name}\t#{window_index}\t#{window_name}[\t#{pane_index}\t#{pane_id}]"`.
 * Returns a Map keyed by pane_pid for O(1) ancestry lookups.
 *
 * Tab-delimited (NOT space-delimited) so session names and window names with
 * spaces are preserved. Skips malformed lines and lines with non-numeric pids.
 * The 5th and 6th fields (pane_index, pane_id) are optional and populated only when the upstream
 * format string requested it — used by the tmux-derived peer-name fallback in
 * server.ts when CLAUDE_PEER_NAME isn't set.
 */
export function parseTmuxPanes(output: string): Map<number, TmuxPaneInfo> {
  const paneMap = new Map<number, TmuxPaneInfo>();
  for (const line of output.trim().split("\n")) {
    const parts = line.split("\t");
    if (parts.length >= 4) {
      const pid = parseInt(parts[0]!, 10);
      if (!isNaN(pid)) {
        const info: TmuxPaneInfo = {
          session: parts[1]!,
          window_index: parts[2]!,
          window_name: parts[3]!,
        };
        if (parts.length >= 5 && parts[4]!.length > 0) {
          info.pane_index = parts[4]!;
        }
        if (parts.length >= 6 && parts[5]!.length > 0) {
          info.pane_id = parts[5]!;
        }
        paneMap.set(pid, info);
      }
    }
  }
  return paneMap;
}

/**
 * Compose a TmuxPaneInfo from CLAUDE_PEER_TMUX_* env vars when the live
 * `tmux list-panes` ancestry walk fails to find a pane.
 *
 * Fix B (2026-05-12): bg-job workers spawned under `claude daemon run` inherit
 * the daemon's env, not the launching shell's. The daemon is usually started
 * outside tmux, so $TMUX is empty in the worker even though the launching
 * shell was inside a pane. The cc/ccc/cccr/cc2 bashrc wrappers compensate by
 * exporting CLAUDE_PEER_TMUX_* env vars (alongside the existing
 * CLAUDE_PEER_NAME export) BEFORE invoking `claude --bg`. This helper reads
 * those env vars at server.ts main() time and returns a TmuxPaneInfo the
 * register payload can use as a fallback.
 *
 * Empty-string env values are treated as absent — matches parseTmuxPanes'
 * defensive "empty 5th field" check above. A bashrc that calls
 * `tmux display-message -p '#S'` when the session has gone away can produce
 * empty strings, and we don't want those to register as phantom sessions.
 *
 * Returns null when CLAUDE_PEER_TMUX_SESSION is unset or empty — without a
 * session name, the broker can't index the row by tmux anyway, so partial
 * data isn't useful.
 *
 * When SESSION is set but WINDOW_INDEX/WINDOW_NAME are missing, the
 * corresponding fields are left UNDEFINED on the returned TmuxPaneInfo
 * (not set to empty string). The buildRegisterPayload site coalesces
 * `?? null` so the broker DB stores `null` for those columns, matching
 * the schema shape produced by the live-walk path. Empty-string values
 * would silently break broker rehydration (broker.ts:508 guard `&&
 * body.tmux_window_name` is falsy on "") and render `[tmux session:]`
 * with trailing colon in summary tags.
 *
 * Pure function; takes the env map as input rather than reading
 * process.env directly so unit tests can pass synthetic envs without
 * polluting the runtime.
 */
export function composeTmuxFromEnv(
  env: Record<string, string | undefined>,
): TmuxPaneInfo | null {
  const session = env.CLAUDE_PEER_TMUX_SESSION;
  if (!session || session.length === 0) return null;

  const windowIndex = env.CLAUDE_PEER_TMUX_WINDOW_INDEX;
  const windowName = env.CLAUDE_PEER_TMUX_WINDOW_NAME;
  const paneId = env.CLAUDE_PEER_TMUX_PANE_ID;

  const info: TmuxPaneInfo = { session };
  if (windowIndex && windowIndex.length > 0) {
    info.window_index = windowIndex;
  }
  if (windowName && windowName.length > 0) {
    info.window_name = windowName;
  }
  if (paneId && paneId.length > 0) {
    info.pane_id = paneId;
  }
  // pane_index intentionally not forwarded — the cc bashrc wrapper exports
  // PANE_ID (a stable %N identifier) rather than pane_index (an unstable
  // display ordinal). Leaving pane_index undefined keeps the peer-name
  // fallback in server.ts (envName ?? `${session}.${pane_index}`) honest:
  // only the live tmux walk knows the per-window pane ordinal, so
  // env-hint-only paths don't pretend to.
  return info;
}

export function tmuxPaneTarget(peer: {
  tmux_session?: string | null;
  tmux_window_index?: string | null;
  tmux_pane_id?: string | null;
}): string | null {
  if (peer.tmux_pane_id && peer.tmux_pane_id.length > 0) return peer.tmux_pane_id;
  if (peer.tmux_session && peer.tmux_window_index) return `${peer.tmux_session}:${peer.tmux_window_index}`;
  return null;
}

function truncateUtf8(text: string, maxBytes: number): { text: string; byte_count: number; truncated: boolean } {
  const encoder = new TextEncoder();
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const size = encoder.encode(ch).length;
    if (bytes + size > maxBytes) {
      return { text: out, byte_count: bytes, truncated: true };
    }
    out += ch;
    bytes += size;
  }
  return { text: out, byte_count: bytes, truncated: false };
}

export function prepareTmuxPaneText(
  raw: string,
  maxBytes: number,
): { text: string; byte_count: number; line_count: number; truncated: boolean } {
  const withoutAnsi = raw
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-Z\\-_]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  const limited = truncateUtf8(withoutAnsi, maxBytes);
  const line_count = limited.text.length === 0 ? 0 : limited.text.split("\n").length;
  return { ...limited, line_count };
}

/**
 * Parse output of `ps -eo pid,ppid` into a pid → ppid map.
 * Skips the header line; tolerates extra whitespace.
 */
export function parsePsTree(output: string): Map<number, number> {
  const tree = new Map<number, number>();
  const lines = output.trim().split("\n").slice(1); // drop header
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      const pid = parseInt(parts[0]!, 10);
      const ppid = parseInt(parts[1]!, 10);
      if (!isNaN(pid) && !isNaN(ppid)) {
        tree.set(pid, ppid);
      }
    }
  }
  return tree;
}

/** Minimal process shape the bg-attach resolver needs (pid, ppid, full args). */
export interface ProcLike {
  pid: number;
  ppid: number;
  args: string;
}

/**
 * Extract a backgrounded session's short id from a pty-host ancestor's args.
 *
 * A `claude --bg` session runs under a daemon pty-host whose args carry the
 * session id in one of two forms (observed on v2.1.177):
 *   --bg-pty-host /tmp/cc-daemon-1000/<acct>/pty/<8hex>.sock ...
 *   ... --session-id <8hex>-<rest-of-uuid> ...
 * The short id (8 hex chars) is the agent-view id AND the prefix of the
 * session UUID — and the same token the `claude attach <id>` client uses.
 * Returns the 8-hex short id, or null if no pty-host marker is present.
 *
 * Pure: takes a single args string; the caller walks ancestry and passes
 * each ancestor's args until one matches.
 */
export function bgSessionIdFromPtyHostArgs(args: string): string | null {
  if (!/--bg-pty-host(\s|=)/.test(args)) return null;
  // Prefer the .sock basename (always the short id); fall back to --session-id.
  // The sock lives under /pty/ for a fully-promoted bg session OR /spare/ for a
  // session still hosted on its pre-warm spare slot (observed on v2.1.177:
  // /tmp/cc-daemon-<uid>/<daemon>/spare/<8hex>.pty.sock). Both carry the same
  // 8-hex short id; matching only /pty/ silently dropped every spare-hosted bg
  // session, so its pane never resolved.
  const sock = args.match(/\/(?:pty|spare)\/([0-9a-f]{8})\.(?:pty\.)?sock/);
  if (sock) return sock[1]!;
  const sid = args.match(/--session-id[=\s]+([0-9a-f]{8})/);
  if (sid) return sid[1]!;
  return null;
}

/**
 * Resolve the tmux pane a BACKGROUNDED session is currently displayed in, by
 * locating the live `claude attach <bgSessionId>` client and walking UP from it
 * to the owning pane.
 *
 * Why this exists: a `--bg` session's own process ancestry is
 * `daemon → bg-pty-host → session` — detached from any tmux pane, so the
 * standard ancestry walk in detectTmuxPane() finds nothing, and the
 * CLAUDE_PEER_TMUX_* env hint is suppressed for spares (the env is the
 * daemon pool-warmer's, not this session's launcher — stale). The ONE source
 * of the correct, current pane is the operator's `claude attach <id>` client,
 * which runs in a real tmux pane in a SEPARATE process tree. This reads it
 * live at registration time, so it is never stale and self-corrects if the
 * operator re-attaches the session in a different pane.
 *
 * Matching is exact on the short id with a right boundary (end-of-string or
 * whitespace) so `claude attach 4c98759b` does NOT match a longer id that
 * merely starts with the same 8 hex (defensive — short ids are unique in
 * practice, but a prefix match would be a latent ghost-pane bug).
 *
 * Returns the TmuxPaneInfo for the owning pane, or null when no matching
 * attach client is found in any pane's subtree (e.g. the session is
 * backgrounded but not currently attached anywhere).
 *
 * Pure function: all inputs passed in, no process spawning, so it is unit
 * tested directly with synthetic process tables.
 */
export function resolveBgAttachPane(
  bgSessionId: string,
  paneMap: Map<number, TmuxPaneInfo>,
  processes: ProcLike[],
): TmuxPaneInfo | null {
  if (!bgSessionId || paneMap.size === 0) return null;
  // Match `claude attach <id>` with an exact-id right boundary so a longer id
  // sharing the same 8-hex prefix never ghost-matches. The left side accepts an
  // optional path/wrapper before `claude` ((^|\s|/)) so an absolute-path exe
  // (`/usr/bin/claude attach <id>`) still matches; verified the live v2.1.177
  // attach client is the bare `claude attach <id>` form, abs-path is defensive.
  // NO nested quantifier (would be a ReDoS shape) — flags between `attach` and
  // the id are not currently emitted, so we don't pay catastrophic-backtracking
  // risk to tolerate a form that doesn't occur. bgSessionId is provably
  // [0-9a-f]{8} (sole producer: bgSessionIdFromPtyHostArgs) → no metacharacter,
  // no injection surface.
  const attachRe = new RegExp(
    `(^|\\s|/)claude\\s+attach\\s+${bgSessionId}(\\s|$)`,
  );
  const ppidMap = new Map<number, number>();
  for (const p of processes) ppidMap.set(p.pid, p.ppid);

  for (const p of processes) {
    if (!attachRe.test(p.args)) continue;
    // Walk UP from the attach client to the owning pane (pane_pid may be the
    // attach client itself, or an ancestor like the pane's login shell).
    let cur: number | undefined = p.pid;
    for (let i = 0; i < 30 && cur !== undefined; i++) {
      const pane = paneMap.get(cur);
      if (pane) return pane;
      const parent: number | undefined = ppidMap.get(cur);
      if (parent === undefined || parent <= 1 || parent === cur) break;
      cur = parent;
    }
  }
  return null;
}
