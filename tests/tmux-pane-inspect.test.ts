import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { prepareTmuxPaneText, tmuxPaneTarget } from "../shared/tmux.ts";

describe("tmux pane inspection helpers", () => {
  test("targets stable pane_id before session/window fallback", () => {
    expect(tmuxPaneTarget({
      tmux_session: "infra",
      tmux_window_index: "2",
      tmux_pane_id: "%42",
    })).toBe("%42");
  });

  test("falls back to session/window when pane_id is unavailable", () => {
    expect(tmuxPaneTarget({
      tmux_session: "infra",
      tmux_window_index: "2",
      tmux_pane_id: null,
    })).toBe("infra:2");
  });

  test("returns null when peer has no tmux target", () => {
    expect(tmuxPaneTarget({
      tmux_session: null,
      tmux_window_index: null,
      tmux_pane_id: null,
    })).toBeNull();
  });

  test("strips ANSI and control bytes without dropping normal text", () => {
    const prepared = prepareTmuxPaneText("\x1b[31mred\x1b[0m\nok\x00\x07", 1024);
    expect(prepared.text).toBe("red\nok");
    expect(prepared.line_count).toBe(2);
    expect(prepared.truncated).toBe(false);
  });

  test("caps pane text by UTF-8 bytes", () => {
    const prepared = prepareTmuxPaneText("abcde", 3);
    expect(prepared.text).toBe("abc");
    expect(prepared.byte_count).toBe(3);
    expect(prepared.truncated).toBe(true);
  });

  test("server exposes read-only tmux tools without send-keys", () => {
    const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    expect(source).toContain('"inspect_peer_pane"');
    expect(source).toContain("include_tmux_context");
    expect(source).toContain('"capture-pane"');
    expect(source).not.toContain('"send-keys"');
  });
});
