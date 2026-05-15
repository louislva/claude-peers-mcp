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
