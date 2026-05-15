/**
 * Tests for composeTmuxFromEnv — the env-hint fallback used when the live
 * `tmux list-panes` ancestry walk in detectTmuxPane() returns null.
 *
 * Fix B (2026-05-12): bg-job workers spawned by `claude daemon run` inherit
 * the daemon's env (no $TMUX), so detectTmuxPane() finds no pane ancestor in
 * the ps tree and previously registered with tmux_session=null. The cc/ccc/
 * cccr/cc2 bashrc wrappers now pre-export CLAUDE_PEER_TMUX_* env vars before
 * `claude --bg`, and this helper turns those env vars into a TmuxPaneInfo
 * the register payload can use as a fallback.
 *
 * The server.ts integration (let tmuxInfo = await detectTmuxPane(); if (!tmuxInfo)
 * tmuxInfo = composeTmuxFromEnv(process.env)) is covered by smoke tests in
 * the implementation plan — too heavy to spin up in a unit test (would import
 * all of server.ts and trigger main()'s side effects, mirroring the same
 * trade-off documented in tests/tmux-fallback.test.ts:11-18).
 *
 * Live tmux walk MUST take precedence over env hints; this file does not test
 * that precedence directly because composeTmuxFromEnv is unconditional — the
 * precedence is enforced in server.ts main() by the `if (!tmuxInfo)` guard.
 * A regression there would be caught by smoke step 4 (foreground cc in tmux:
 * row carries live walk's window_index, not env-hint's).
 */

import { describe, test, expect } from "bun:test";
import { composeTmuxFromEnv } from "../shared/tmux.ts";

describe("composeTmuxFromEnv — CLAUDE_PEER_TMUX_* env hint fallback", () => {
  test("returns null when CLAUDE_PEER_TMUX_SESSION is unset", () => {
    // No session → broker has no tmux key to index by; null is the only
    // honest answer. Partial data (window without session) would create a
    // row with tmux_session=null but tmux_window_index=set, which is
    // worse than just registering with all-null tmux fields.
    const result = composeTmuxFromEnv({});
    expect(result).toBeNull();
  });

  test("returns null when CLAUDE_PEER_TMUX_SESSION is empty string", () => {
    // tmux display-message -p '#S' returns empty when the session went away
    // mid-call. The bashrc wrapper would then export an empty value. Treat
    // it as absent rather than registering with tmux_session="".
    const result = composeTmuxFromEnv({ CLAUDE_PEER_TMUX_SESSION: "" });
    expect(result).toBeNull();
  });

  test("returns full TmuxPaneInfo when all four env vars are populated", () => {
    // The happy path: cc/ccc/cccr/cc2 wrapper inside a healthy tmux pane.
    const result = composeTmuxFromEnv({
      CLAUDE_PEER_TMUX_SESSION: "visionsuitespike",
      CLAUDE_PEER_TMUX_WINDOW_INDEX: "1",
      CLAUDE_PEER_TMUX_WINDOW_NAME: "claude",
      CLAUDE_PEER_TMUX_PANE_ID: "%42",
    });
    expect(result).not.toBeNull();
    expect(result!.session).toBe("visionsuitespike");
    expect(result!.window_index).toBe("1");
    expect(result!.window_name).toBe("claude");
    expect(result!.pane_id).toBe("%42");
    // Intentionally undefined — env hint can't supply per-window pane ordinal.
    expect(result!.pane_index).toBeUndefined();
  });

  test("session-only env leaves window_index/window_name/pane_id UNDEFINED (not empty string)", () => {
    // Critical schema-shape contract (Fix B v1.1 after reviewer-found drift):
    // composeTmuxFromEnv must NOT populate optional fields with "" — the
    // buildRegisterPayload site relies on `?? null` to coalesce undefined →
    // null, matching what the live-walk path produces. Empty strings would
    // (1) silently disable broker rehydration (broker.ts:508 guard `&&
    // body.tmux_window_name` is falsy on ""), and (2) produce ugly
    // `[tmux session:]` summary tags with a trailing colon.
    const result = composeTmuxFromEnv({
      CLAUDE_PEER_TMUX_SESSION: "rag",
    });
    expect(result).not.toBeNull();
    expect(result!.session).toBe("rag");
    expect(result!.window_index).toBeUndefined();
    expect(result!.window_name).toBeUndefined();
    expect(result!.pane_id).toBeUndefined();
    expect(result!.pane_index).toBeUndefined();
  });

  test("empty-string non-session env values are treated as absent (not as empty literals)", () => {
    // Mirrors parseTmuxPanes' defensive `parts[N]!.length > 0` check
    // (shared/tmux.ts:42-47). Empty strings on optional fields must NOT
    // populate them — server.ts uses pane_id presence to decide whether to
    // emit tmux per-pane options (line ~1101), and an empty %ID would break
    // that. Same drift-vs-live-walk reasoning as the test above.
    const result = composeTmuxFromEnv({
      CLAUDE_PEER_TMUX_SESSION: "infra",
      CLAUDE_PEER_TMUX_WINDOW_INDEX: "",
      CLAUDE_PEER_TMUX_WINDOW_NAME: "",
      CLAUDE_PEER_TMUX_PANE_ID: "",
    });
    expect(result).not.toBeNull();
    expect(result!.session).toBe("infra");
    expect(result!.window_index).toBeUndefined();
    expect(result!.window_name).toBeUndefined();
    expect(result!.pane_id).toBeUndefined();
  });

  test("session names with spaces and special chars pass through unmodified", () => {
    // tmux session names can contain spaces, colons, slashes. The env-hint
    // path does no escaping/encoding — broker stores them as-is. Future
    // shell-quoting bugs in the bashrc wrapper would shift between this
    // expectation and a quoted form; lock the contract here.
    const result = composeTmuxFromEnv({
      CLAUDE_PEER_TMUX_SESSION: "my session with spaces",
      CLAUDE_PEER_TMUX_WINDOW_NAME: "win/with/slashes",
    });
    expect(result).not.toBeNull();
    expect(result!.session).toBe("my session with spaces");
    expect(result!.window_name).toBe("win/with/slashes");
    // pane_index intentionally not populated by env-hint — locks the
    // "env-hint can't supply per-window ordinal" contract against a future
    // refactor that might conditionally derive it from WINDOW_INDEX.
    expect(result!.pane_index).toBeUndefined();
  });

  test("does not leak unrelated env vars into the result", () => {
    // Compile-time + runtime check: only the four CLAUDE_PEER_TMUX_* vars
    // matter. A future bug that reads, say, $TMUX or $TMUX_PANE here
    // would silently shadow the explicit hint contract.
    const result = composeTmuxFromEnv({
      CLAUDE_PEER_TMUX_SESSION: "foo",
      TMUX: "/tmp/tmux-1000/default,12345,0",
      TMUX_PANE: "%99",
      HOSTNAME: "ManzoOps",
    });
    expect(result).not.toBeNull();
    expect(result!.session).toBe("foo");
    expect(result!.pane_id).toBeUndefined(); // NOT picked up from $TMUX_PANE
  });
});
