/**
 * Tests for the backgrounded-session tmux-pane resolver.
 *
 * Bug fixed: a `claude --bg` session never registered tmux pane info, so it
 * was invisible to claude-peers (no send_message / push-wake / list_peers),
 * even though it shows in the agent-view roster. Root cause: a bg session's
 * own process ancestry is daemon → bg-pty-host → session — detached from any
 * tmux pane — so detectTmuxPane()'s ancestry walk finds nothing, and the
 * CLAUDE_PEER_TMUX_* env hint is (correctly) suppressed for spares because the
 * inherited env is the daemon pool-warmer's, not this session's launcher.
 *
 * Fix: when the session IS attached (`claude attach <id>` running in a real
 * pane, in a SEPARATE process tree), resolve the owning pane from that live
 * attach client. These tests cover the two pure helpers that implement it:
 *   - bgSessionIdFromPtyHostArgs: extract the bg short id from a pty-host's args
 *   - resolveBgAttachPane: find the pane whose subtree runs `claude attach <id>`
 *
 * Both are pure (all inputs passed in), so they are unit tested directly with
 * synthetic process tables — no `ps`/`tmux` spawning, no server.ts side effects.
 */

import { describe, test, expect } from "bun:test";
import {
  bgSessionIdFromPtyHostArgs,
  resolveBgAttachPane,
  parseTmuxPanes,
  type ProcLike,
} from "../shared/tmux.ts";

describe("bgSessionIdFromPtyHostArgs", () => {
  test("extracts the short id from a pty-host .sock path", () => {
    const args =
      "/home/manzo/.local/share/claude/versions/2.1.177 --bg-pty-host " +
      "/tmp/cc-daemon-1000/c80b6ca6/pty/654ce84b.sock 94 40 -- ...";
    expect(bgSessionIdFromPtyHostArgs(args)).toBe("654ce84b");
  });

  test("falls back to --session-id (8-hex prefix) when no .sock path", () => {
    const args =
      "claude --bg-pty-host /tmp/cc-daemon-1000/x/pty/zzz -- " +
      "--session-id 4c98759b-fc3b-437b-a87c-e80bbddaca53 --effort xhigh";
    expect(bgSessionIdFromPtyHostArgs(args)).toBe("4c98759b");
  });

  test("returns null for a non-bg-pty-host process (interactive session)", () => {
    // An ordinary interactive `claude` launch must NOT be treated as bg —
    // this is what keeps the new strategy from firing on interactive sessions.
    expect(bgSessionIdFromPtyHostArgs("claude --model claude-opus-4-8")).toBeNull();
    expect(bgSessionIdFromPtyHostArgs("-bash")).toBeNull();
    expect(bgSessionIdFromPtyHostArgs("")).toBeNull();
  });

  test("returns null for a bg-SPARE (pre-warm pool) without a pty-host marker", () => {
    // A spare that has not been promoted to a pty-host carries --bg-spare but
    // not --bg-pty-host; it has no real session id to resolve a pane for.
    const args = "claude --bg-spare /tmp/cc-daemon-1000/x/spare/abc.claim.sock";
    expect(bgSessionIdFromPtyHostArgs(args)).toBeNull();
  });

  test("extracts the short id from a pty-host hosted on a /spare/ slot (.pty.sock)", () => {
    // A promoted bg session can keep running on its pre-warm spare slot, so the
    // pty-host sock is /spare/<8hex>.pty.sock rather than /pty/<8hex>.sock. Both
    // carry the same short id; the /pty/-only match silently dropped every
    // spare-hosted bg session (verified live: my own session at 0f805b32 had no
    // pane registered until this widened match). The --bg-pty-host marker IS
    // present here (unlike the unpromoted .claim.sock spare above), so it is a
    // real, resolvable session.
    const args =
      "/home/manzo/.local/share/claude/versions/2.1.177 --bg-pty-host " +
      "/tmp/cc-daemon-1000/d696beb3/spare/0f805b32.pty.sock 200 50 -- ...";
    expect(bgSessionIdFromPtyHostArgs(args)).toBe("0f805b32");
  });

  test("does not misread a 7-or-9-char token as the 8-hex short id", () => {
    // Right-length discipline: only an exact 8-hex run after pty/ is the id.
    const tooShort = "x --bg-pty-host /tmp/d/pty/654ce8.sock"; // 6 hex
    expect(bgSessionIdFromPtyHostArgs(tooShort)).toBeNull();
  });
});

describe("resolveBgAttachPane", () => {
  // A realistic two-tree fixture: the bg session lives under a daemon (no pane),
  // and the operator has `claude attach <id>` running inside tmux pane %237,
  // whose pane_pid is the login shell (4155272) that spawned the attach client.
  const ID = "4c98759b";
  const paneMap = parseTmuxPanes(
    "4155272\tcoding\t6\tagentview-rearch\t1\t%237\n" + // the attached pane (pane_pid = login shell)
    "999000\tother\t0\tother-win\t0\t%99", // an unrelated pane
  );
  const procs: ProcLike[] = [
    { pid: 1, ppid: 0, args: "/sbin/init" },
    // bg session tree (daemon → pty-host → session) — NOT in any pane
    { pid: 500, ppid: 1, args: "claude --bg-spare /tmp/.../claim.sock" },
    { pid: 510, ppid: 500, args: "claude --bg-pty-host /tmp/.../pty/4c98759b.sock 200 50 -- ..." },
    { pid: 520, ppid: 510, args: "claude --session-id 4c98759b-... --effort xhigh" },
    // the pane's own tree (login shell → attach client) — separate from above
    { pid: 4155272, ppid: 2771868, args: "-bash" },
    { pid: 3786802, ppid: 4155272, args: "claude attach 4c98759b" },
  ];

  test("resolves the pane whose subtree runs `claude attach <id>`", () => {
    const pane = resolveBgAttachPane(ID, paneMap, procs);
    expect(pane).not.toBeNull();
    expect(pane!.session).toBe("coding");
    expect(pane!.pane_id).toBe("%237");
    expect(pane!.window_name).toBe("agentview-rearch");
  });

  test("returns null when the session is backgrounded but NOT attached anywhere", () => {
    // No `claude attach <id>` process exists — bg session running headless.
    const noAttach = procs.filter((p) => !p.args.includes("claude attach"));
    expect(resolveBgAttachPane(ID, paneMap, noAttach)).toBeNull();
  });

  test("does NOT match a different session's attach client (exact-id boundary)", () => {
    // Planted error (SPEC-01): an attach for a DIFFERENT id must not resolve
    // to this session's pane. Guards against a prefix/substring ghost-pane bug.
    const other = procs.map((p) =>
      p.args === "claude attach 4c98759b"
        ? { ...p, args: "claude attach deadbeef" }
        : p,
    );
    expect(resolveBgAttachPane(ID, paneMap, other)).toBeNull();
  });

  test("does NOT match an id that is merely a prefix of a longer attach token", () => {
    // `claude attach 4c98759bXX` must not satisfy a request for `4c98759b`.
    const longer = procs.map((p) =>
      p.args === "claude attach 4c98759b"
        ? { ...p, args: "claude attach 4c98759bee" }
        : p,
    );
    expect(resolveBgAttachPane(ID, paneMap, longer)).toBeNull();
  });

  test("walks up multiple ancestry levels from the attach client to the pane", () => {
    // pane_pid is the login shell; the attach client is a grandchild
    // (shell → wrapper → attach). The walk must still reach pane %237.
    const deeper: ProcLike[] = [
      ...procs.filter((p) => p.pid !== 3786802),
      { pid: 3786000, ppid: 4155272, args: "sh -c run-attach" },
      { pid: 3786802, ppid: 3786000, args: "claude attach 4c98759b" },
    ];
    const pane = resolveBgAttachPane(ID, paneMap, deeper);
    expect(pane!.pane_id).toBe("%237");
  });

  test("matches an absolute-path exe before `claude` (hardened left boundary)", () => {
    // Defensive: if the attach client ever shows as `/usr/bin/claude attach <id>`
    // (abs-path exe) the `/` before claude must still satisfy the left boundary.
    const absPath = procs.map((p) =>
      p.args === "claude attach 4c98759b"
        ? { ...p, args: "/usr/bin/claude attach 4c98759b" }
        : p,
    );
    expect(resolveBgAttachPane(ID, paneMap, absPath)!.pane_id).toBe("%237");
  });

  test("does NOT match `xclaude attach <id>` (left boundary rejects mid-token)", () => {
    // The left boundary must not let a different binary ending in 'claude' match.
    const xclaude = procs.map((p) =>
      p.args === "claude attach 4c98759b"
        ? { ...p, args: "xclaude attach 4c98759b" }
        : p,
    );
    expect(resolveBgAttachPane(ID, paneMap, xclaude)).toBeNull();
  });

  test("returns null on empty pane map or empty id (defensive)", () => {
    expect(resolveBgAttachPane(ID, new Map(), procs)).toBeNull();
    expect(resolveBgAttachPane("", paneMap, procs)).toBeNull();
  });

  test("does not infinite-loop on a cyclic ppid chain", () => {
    // Defensive: a corrupt ps snapshot with a parent cycle must terminate.
    const cyclic: ProcLike[] = [
      { pid: 700, ppid: 701, args: "claude attach 4c98759b" },
      { pid: 701, ppid: 700, args: "wrapper" }, // 700<->701 cycle, neither is a pane
    ];
    expect(resolveBgAttachPane(ID, paneMap, cyclic)).toBeNull();
  });
});
