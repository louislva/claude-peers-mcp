/**
 * Regression test for the tmux-derived peer-name fallback.
 *
 * Bug: a Claude launched outside the bashrc cc/ccc/cccr wrappers gets no
 * CLAUDE_PEER_NAME env var and would register with name=null — unfindable
 * by name, only by id. Mirrors bashrc:162-168's #S.#P logic at the MCP
 * layer (server.ts main()) so the floor is consistent regardless of how
 * the session was started.
 *
 * The wiring lives in two places:
 *   1. shared/tmux.ts parseTmuxPanes — accepts an optional 5th tab field
 *      (pane_index) without breaking 4-field callers.
 *   2. server.ts main() — composes peerName as envName ?? `${session}.${pane_index}`.
 *
 * This file tests #1 directly. The server.ts composition path is too
 * heavy to spin up in a unit test (would import all of server.ts and
 * trigger main()'s side effects), so it's covered by manual E2E smoke
 * checks documented in the implementation plan.
 */

import { describe, test, expect } from "bun:test";
import { parseTmuxPanes, type TmuxPaneInfo } from "../shared/tmux.ts";

describe("parseTmuxPanes — pane_index fallback support", () => {
  test("populates pane_index when 5-field format is used", () => {
    const out =
      "12345\tmysess\t1\twindow-name\t2\n" +
      "12346\tmysess\t1\twindow-name\t3";
    const map = parseTmuxPanes(out);
    expect(map.size).toBe(2);
    const a = map.get(12345)!;
    expect(a.session).toBe("mysess");
    expect(a.window_index).toBe("1");
    expect(a.window_name).toBe("window-name");
    expect(a.pane_index).toBe("2");
    const b = map.get(12346)!;
    expect(b.pane_index).toBe("3");
  });

  test("populates pane_id when 6-field format is used", () => {
    const out = "12345\tmysess\t1\twindow-name\t2\t%42";
    const pane = parseTmuxPanes(out).get(12345)!;
    expect(pane.pane_index).toBe("2");
    expect(pane.pane_id).toBe("%42");
  });

  test("leaves pane_index undefined when 4-field legacy format is used", () => {
    // Backwards-compat regression guard: 4-field callers (the original
    // detectTmuxPane format string before the C3 patch) must keep working.
    const out =
      "12345\tmysess\t1\twindow-name\n" +
      "12346\tothersess\t0\tother-window";
    const map = parseTmuxPanes(out);
    expect(map.size).toBe(2);
    const a = map.get(12345)!;
    expect(a.session).toBe("mysess");
    expect(a.pane_index).toBeUndefined();
  });

  test("handles empty 5th field as missing (not as empty string)", () => {
    // Defensive: if tmux ever emits a tab with an empty value (shouldn't
    // happen for pane_index but cheap to guard), treat it as absent rather
    // than producing pane_index="" which would break `${s}.${p}` formatting.
    const out = "12345\tmysess\t1\twindow-name\t";
    const map = parseTmuxPanes(out);
    const info = map.get(12345)!;
    expect(info.pane_index).toBeUndefined();
  });

  test("composed peer-name reflects #S.#P shape used by bashrc", () => {
    // End-to-end shape check: simulate what server.ts main() does after
    // detectTmuxPane resolves the ancestry. If this test ever fails, the
    // operator's manzoopsinfra.1 / manzoopsinfra.2 addressing breaks.
    const out = "12345\tmanzoopsinfra\t1\tclaude\t2";
    const info = parseTmuxPanes(out).get(12345)!;
    const composed =
      info && info.pane_index ? `${info.session}.${info.pane_index}` : null;
    expect(composed).toBe("manzoopsinfra.2");
  });

  test("type contract: TmuxPaneInfo treats pane_index as optional", () => {
    // Compile-time check via a runtime assertion on the type shape.
    const minimal: TmuxPaneInfo = {
      session: "s",
      window_index: "0",
      window_name: "w",
    };
    expect(minimal.pane_index).toBeUndefined();
  });

  test("malformed lines (fewer than 4 fields) are skipped, not crashed", () => {
    const out =
      "12345\tonly-two\n" +
      "67890\tgood\t1\twin\t4\n" +
      "not-a-pid\tx\t1\twin\t1";
    const map = parseTmuxPanes(out);
    // Only the 67890 line is well-formed.
    expect(map.size).toBe(1);
    expect(map.get(67890)?.pane_index).toBe("4");
  });
});
