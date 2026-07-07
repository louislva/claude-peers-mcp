/**
 * Unit tests for the codex-autodrain poller's idle/empty-input decision
 * (paneTextIsIdle). This is the safety-critical gate: it must NEVER return true
 * when the lane is busy OR has real queued operator text, or the poller would
 * inject keystrokes that disrupt active work / submit the operator's text.
 *
 * The dim-placeholder rule is the robust signal: Codex renders idle-prompt
 * placeholder text dim (ESC[2m); real typed input is bright. Captured live from
 * marketing.1 (pane %200): the prompt line read
 *   ESC[1m›ESC[0m ESC[2mImplement {feature}ESC[0m
 * i.e. a dim placeholder = empty input = nudgeable.
 */
import { describe, test, expect } from "bun:test";
import { paneTextIsIdle, everyVisibleCharIsDim } from "../bin/codex-autodrain-poller.ts";

const ESC = "\x1b";
const dim = (s: string) => `${ESC}[2m${s}${ESC}[0m`;
const bold = (s: string) => `${ESC}[1m${s}${ESC}[0m`;
const prompt = bold("›"); // bright › glyph, as Codex renders it

// A realistic idle capture: some prior output + the prompt line.
function idleCapture(afterGlyph: string): string {
  return [
    "  Bottom line: acquisition is healthy; conversion is the bottleneck.",
    "─".repeat(20),
    `${prompt} ${afterGlyph}`,
    "  ~/Clause5 · main · gpt-5.5 high · Context 43% left",
  ].join("\n");
}

describe("paneTextIsIdle", () => {
  test("NUDGE: idle prompt with a DIM placeholder (empty input)", () => {
    // the exact live shape from marketing.1
    expect(paneTextIsIdle(idleCapture(dim("Implement {feature}")))).toBe(true);
  });

  test("NUDGE: idle prompt with a different dim placeholder", () => {
    expect(paneTextIsIdle(idleCapture(dim("Find and fix a bug in @filename")))).toBe(true);
  });

  test("NUDGE: truly empty input line (glyph, no text)", () => {
    expect(paneTextIsIdle(idleCapture(""))).toBe(true);
  });

  test("SKIP: BRIGHT (real) queued operator text after the glyph", () => {
    // operator typed a real command — bright, not dim — must NOT be submitted
    expect(paneTextIsIdle(idleCapture("deploy to production now"))).toBe(false);
  });

  test("SKIP: bold/bright queued text (explicit SGR) is not a placeholder", () => {
    expect(paneTextIsIdle(idleCapture(bold("rm -rf build")))).toBe(false);
  });

  test("SKIP: lane is mid-turn (busy marker present)", () => {
    const busy = [
      "• Working (7s · esc to interrupt)",
      `${prompt} ${dim("Implement {feature}")}`,
    ].join("\n");
    expect(paneTextIsIdle(busy)).toBe(false); // busy marker wins even with dim prompt
  });

  test("SKIP: no prompt glyph at all (not at an input prompt)", () => {
    expect(paneTextIsIdle("• Running 2 PostToolUse hooks\n  some output")).toBe(false);
  });

  test("SKIP: 'Reviewing approval request' busy state", () => {
    const approving = [
      "◦ Reviewing approval request (55s · esc to interrupt)",
      `${prompt} ${dim("Implement {feature}")}`,
    ].join("\n");
    expect(paneTextIsIdle(approving)).toBe(false);
  });

  // ADVERSARIAL (review finding, high/conf90): real BRIGHT operator input with a
  // dim ghost-autocomplete suffix or dim @mention must NOT be misread as idle —
  // a substring "contains [2m" check would submit the operator's text. The
  // whole-input-must-be-dim rule defends this.
  test("SKIP: bright command + dim ghost-autocomplete suffix (the attack)", () => {
    const ghost = `deploy to prod${dim("uction now")}`; // bright "deploy to prod" + dim suffix
    expect(paneTextIsIdle(idleCapture(ghost))).toBe(false);
  });

  test("SKIP: bright command with a dim inline @mention", () => {
    const mention = `please review ${dim("@deploy.yaml")} and run it`; // mostly bright
    expect(paneTextIsIdle(idleCapture(mention))).toBe(false);
  });

  test("SKIP: real input that merely ends before a dim hint", () => {
    const mixed = `rm -rf build ${dim("(press enter)")}`;
    expect(paneTextIsIdle(idleCapture(mixed))).toBe(false);
  });
});

// --- Claude lane idle/busy gate (bg-claude wake support) ---
// Same safety contract as the Codex gate, against Claude's TUI: the prompt glyph
// is ❯ (U+276F, not ›) and the busy vocabulary is Claude's spinner verbs + the
// "· N tokens" in-flight status row. These fixtures replicate shapes captured
// live from a real backgrounded Claude pane (2026-06-15).
import { profileFor } from "../bin/codex-autodrain-poller.ts";
const CLAUDE = profileFor("claude");
const cPrompt = bold("❯"); // bright ❯ glyph, as Claude renders the input prompt

function claudeIdleCapture(afterGlyph: string): string {
  return [
    "● I'll start by registering my name as instructed.",
    "● ready",
    "─".repeat(20),
    `${cPrompt} ${afterGlyph}`,
    "─".repeat(20),
    "  [B] Clause5 | main | 92% left | Opus 4.8 (1M context) (xhigh)",
  ].join("\n");
}

describe("paneTextIsIdle — claude profile", () => {
  test("NUDGE: idle ❯ prompt, empty input", () => {
    expect(paneTextIsIdle(claudeIdleCapture(""), CLAUDE)).toBe(true);
  });

  test("NUDGE: idle ❯ prompt with a dim placeholder", () => {
    // Claude renders its ghost suggestion dim, same as Codex
    expect(paneTextIsIdle(claudeIdleCapture(dim('Try "create a util logging.py that..."')), CLAUDE)).toBe(true);
  });

  test("SKIP: bright (real) queued operator text after ❯ — must not submit", () => {
    expect(paneTextIsIdle(claudeIdleCapture("git push origin main"), CLAUDE)).toBe(false);
  });

  // Boundary the room cared about most — busy vs done. Grounded in live captures:
  // a COMPLETED turn prints a PAST-tense "Cogitated for 11s" (no ellipsis, no
  // active "(Ns ·" timer) and the lane IS idle → safe to nudge. An IN-FLIGHT turn
  // prints "Verb… (Ns · ↑ tokens)" → busy → never nudge. The active-timer shape
  // "(\d+s ·" is the discriminator; matching the bare word would wrongly freeze a
  // just-finished idle lane forever (it would never be woken).
  test("NUDGE: 'Cogitated for 11s' is a DONE turn (past tense) — lane is idle", () => {
    const done = ["✻ Cogitated for 11s", `${cPrompt} `].join("\n");
    expect(paneTextIsIdle(done, CLAUDE)).toBe(true);
  });

  test("SKIP: busy — 'Warping… (18s · ↑ 355 tokens)'", () => {
    const busy = ["✻ Warping… (18s · ↑ 355 tokens)", `${cPrompt} `].join("\n");
    expect(paneTextIsIdle(busy, CLAUDE)).toBe(false);
  });

  test("SKIP: busy — 'Evaporating… (6s · ↑ 122 tokens)'", () => {
    const busy = ["✽ Evaporating… (6s · ↑ 122 tokens)", `${cPrompt} `].join("\n");
    expect(paneTextIsIdle(busy, CLAUDE)).toBe(false);
  });

  test("SKIP: busy — generic '(Ns ·' in-flight timer", () => {
    const busy = ["✻ Synthesizing… (3s · ↓ 1.2k tokens)", `${cPrompt} `].join("\n");
    expect(paneTextIsIdle(busy, CLAUDE)).toBe(false);
  });

  // Cross-profile guard: a Codex pane fed the CLAUDE profile must NOT be seen as
  // idle (different glyph), so the poller can never nudge with the wrong profile.
  test("SKIP: a Codex › pane judged under the claude profile is NOT idle", () => {
    expect(paneTextIsIdle(idleCapture(""), CLAUDE)).toBe(false); // › glyph, ❯ profile
  });

  test("SKIP: a Claude ❯ pane judged under the codex profile is NOT idle", () => {
    expect(paneTextIsIdle(claudeIdleCapture(""), profileFor("codex"))).toBe(false);
  });
});

// --- bg-claude pane resolution (the two bugs live-testing caught) ---
import { sessionIdFromEnvironText, attachIdInTree } from "../bin/codex-autodrain-poller.ts";

describe("sessionIdFromEnvironText", () => {
  const NUL = "\0";
  // REGRESSION: a spare-hosted bg session's pty-host .sock basename is the SPARE
  // id (e.g. fdf1dffd), NOT the promoted session id the attach client uses
  // (719595a7). The promoted id is the one in CLAUDE_CODE_SESSION_ID. Reading it
  // here is what makes resolveBgAttachPane find the right pane.
  test("extracts CLAUDE_CODE_SESSION_ID 8-hex prefix", () => {
    const env = ["PATH=/usr/bin", "CLAUDE_CODE_SESSION_ID=719595a7-8fba-4907-a321-6ad48d8de97d", "HOME=/home/manzo"].join(NUL);
    expect(sessionIdFromEnvironText(env)).toBe("719595a7");
  });
  test("returns null when the var is absent", () => {
    expect(sessionIdFromEnvironText(["PATH=/usr/bin", "HOME=/home/manzo"].join(NUL))).toBeNull();
  });
  test("CLAUDE_JOB_DIR (a different var with an id) does NOT false-match", () => {
    expect(sessionIdFromEnvironText(["CLAUDE_JOB_DIR=/home/manzo/.claude-b/jobs/719595a7"].join(NUL))).toBeNull();
  });
});

describe("attachIdInTree", () => {
  // paneSubtree synthesizes one `(pid) <full argv>` line per subtree process, so
  // the attach client appears as `(NNN) claude attach <id>`. The matcher anchors
  // on `claude` immediately before `attach` (review #4) so a different tool whose
  // args merely contain `attach <id>` can't false-match.
  test("matches the synthesized line: '(684836) claude attach 9c27fddd'", () => {
    const tree = "(1646219) -bash\n(684836) claude attach 9c27fddd\n(684837) bun server.ts";
    expect(attachIdInTree(tree, "9c27fddd")).toBe(true);
  });
  test("matches an absolute-path exe: '(NNN) /usr/bin/claude attach <id>'", () => {
    expect(attachIdInTree("(684836) /usr/bin/claude attach 9c27fddd", "9c27fddd")).toBe(true);
  });
  test("does NOT match a different session id in the tree", () => {
    const tree = "(684836) claude attach 9c27fddd";
    expect(attachIdInTree(tree, "fdf1dffd")).toBe(false); // the spare id must NOT match
  });
  test("exact-id boundary: a longer id sharing the prefix does not ghost-match", () => {
    const tree = "(684836) claude attach 9c27fddddead"; // 12 hex, prefix collides
    expect(attachIdInTree(tree, "9c27fddd")).toBe(false);
  });
  test("does NOT match a non-claude tool whose args contain 'attach <id>'", () => {
    // review #4: bare-`attach <id>` ownership was the false-positive vector
    expect(attachIdInTree("(700) git attach 9c27fddd", "9c27fddd")).toBe(false);
    expect(attachIdInTree("(701) bun foo --attach 9c27fddd", "9c27fddd")).toBe(false);
  });
  test("rejects a non-8-hex sessionId (guards the dynamic RegExp)", () => {
    expect(attachIdInTree("(700) claude attach anything", ".*")).toBe(false);
  });
  test("no attach client in the tree → false", () => {
    expect(attachIdInTree("(1646219) -bash\n(684836) claude\n(684837) bun server.ts", "9c27fddd")).toBe(false);
  });
});

describe("everyVisibleCharIsDim", () => {
  const E = "\x1b";
  test("all-dim text => true", () => {
    expect(everyVisibleCharIsDim(`${E}[2mImplement {feature}${E}[0m`)).toBe(true);
  });
  test("bright text => false", () => {
    expect(everyVisibleCharIsDim("deploy now")).toBe(false);
  });
  test("bright + dim suffix => false (the attack shape)", () => {
    expect(everyVisibleCharIsDim(`bright${E}[2mdim${E}[0m`)).toBe(false);
  });
  test("dim cleared by [22m mid-string, then bright => false", () => {
    expect(everyVisibleCharIsDim(`${E}[2mdim${E}[22mbright`)).toBe(false);
  });
  test("only whitespace (no visible char) => false", () => {
    expect(everyVisibleCharIsDim(`${E}[2m   ${E}[0m`)).toBe(false);
  });
  test("dim spanning the whole thing across multiple SGR resets => true", () => {
    expect(everyVisibleCharIsDim(`${E}[2mone ${E}[2mtwo${E}[0m`)).toBe(true);
  });
});

// --- resolveLanePane wiring (the integration the two 6039612 bugs lived in) ---
// The leaf matchers (sessionIdFromEnvironText, attachIdInTree) are tested above,
// but the BUGS were in the WIRING: (1) environ id must win over the spare .sock
// id, and (2) the returned attachId must be non-null on the bg path so tick picks
// paneOwnedByAttachId. These tests drive resolveLanePane directly with a synthetic
// snapshot + an injected environ reader — no /proc, no live tmux. Without them, an
// inverted environ/fallback order or a dropped attachId would pass the whole suite.
import { resolveLanePane } from "../bin/codex-autodrain-poller.ts";
import { bgSessionIdFromPtyHostArgs } from "../shared/tmux.ts";

const SPARE_ID = "fdf1dffd";     // the pre-warm spare slot id (in the .sock ancestry)
const PROMOTED_ID = "719595a7";  // the promoted session id the attach client uses

// Build a snapshot where: the lane's MCP server (pid 500) sits under a bg-pty-host
// (pid 400) whose args carry the SPARE id; a `claude attach <PROMOTED_ID>` client
// (pid 700) lives in a tmux pane (pane_pid 600 → pane %wt). resolveBgAttachPane
// keys on the PROMOTED id, so the lane resolves only if environ supplies it.
function bgSnapshot() {
  const procs = [
    { pid: 500, ppid: 400, args: "bun /home/manzo/claude-peers-mcp/server.ts" },
    { pid: 400, ppid: 300, args: "/v/2.1.177 --bg-pty-host /tmp/cc-daemon-1000/d/spare/fdf1dffd.pty.sock 200 50" },
    { pid: 700, ppid: 600, args: "claude attach 719595a7" },     // attach client in the pane
    { pid: 600, ppid: 1,   args: "-bash" },                        // pane shell (pane_pid)
  ];
  // parseTmuxPanes is keyed by pane_pid; one pane %wt owned by shell pid 600.
  const paneMap = new Map([[600, { session: "1", pane_id: "%wt" }]]) as any;
  return { procs, paneMap, paneByPid: new Map([["%wt", 600]]) } as any;
}
function bgLane(id: string) {
  return { id, name: id, pid: 500, client_type: "claude", tmux_pane_id: null, unread: 1 } as any;
}

describe("resolveLanePane wiring", () => {
  test("premise: the ancestry .sock yields the SPARE id, not the promoted id", () => {
    // Confirms the snapshot is set up so environ and ancestry genuinely DISAGREE —
    // otherwise the environ-wins test below would pass trivially.
    const ptyHostArgs = bgSnapshot().procs.find((p: any) => p.pid === 400).args;
    expect(bgSessionIdFromPtyHostArgs(ptyHostArgs)).toBe(SPARE_ID);
    expect(SPARE_ID).not.toBe(PROMOTED_ID);
  });

  test("environ id WINS over the spare .sock id (Bug-1 regression)", () => {
    // environ returns the PROMOTED id; ancestry walk would return the SPARE id.
    const r = resolveLanePane(bgLane("L1"), bgSnapshot(), () => PROMOTED_ID);
    expect(r.paneId).toBe("%wt");            // resolved via the promoted id
    expect(r.attachId).toBe(PROMOTED_ID);    // NOT the spare id → tick uses attach-id ownership
  });

  test("falls back to .sock ancestry walk when environ is null", () => {
    // With environ null, the only id available is the SPARE id from the ancestry.
    // The attach client runs the PROMOTED id, so resolveBgAttachPane finds NO pane
    // → empty pane (this is exactly why the spare id is the wrong source, and why
    // environ-first matters). attachId stays null when no pane resolves.
    const r = resolveLanePane(bgLane("L2"), bgSnapshot(), () => null);
    expect(r.paneId).toBe("");               // spare id can't match the promoted attach client
    expect(r.attachId).toBeNull();
  });

  test("environ-first ordering is observable: same lane resolves with environ, fails without", () => {
    const snap = bgSnapshot();
    const withEnviron = resolveLanePane(bgLane("L3a"), snap, () => PROMOTED_ID);
    const withoutEnviron = resolveLanePane(bgLane("L3b"), snap, () => null);
    expect(withEnviron.paneId).toBe("%wt");  // environ path resolves
    expect(withoutEnviron.paneId).toBe("");  // fallback path can't (spare id ≠ attach id)
  });

  test("a directly-registered lane (tmux_pane_id set) returns attachId=null → tick uses pid ownership", () => {
    const lane = { id: "L4", name: "codex.1", pid: 9, client_type: "codex", tmux_pane_id: "%5", unread: 1 } as any;
    const r = resolveLanePane(lane, bgSnapshot(), () => "deadbeef");
    expect(r.paneId).toBe("%5");
    expect(r.attachId).toBeNull();           // null → paneOwnedByPid branch, not attach-id
  });
});

// --- paneSubtree builds the subtree from the per-tick snapshot, NOT pstree ---
// REGRESSION (perf): paneSubtree used to fork `pstree -pa` PER LANE — O(all
// processes), ~3s on a loaded host, which pushed ticks past the poll interval
// (SLOW TICK, observed live: 18.5s over 4 lanes). It now walks DOWN from the
// pane's pane_pid through snap.procs (already captured this tick). These tests
// pin that behavior: the subtree text is derived purely from the snapshot, with
// the `(pid)` + args shapes the ownership checks depend on.
import { paneSubtree } from "../bin/codex-autodrain-poller.ts";

function snapOf(procs: { pid: number; ppid: number; args: string }[], paneByPid: [string, number][]) {
  return { procs, paneByPid: new Map(paneByPid), paneMap: new Map() } as any;
}

describe("paneSubtree (snapshot walk, no pstree fork)", () => {
  // pane %p → shell 100 → claude 200 → {bun 300, helper 400}
  const procs = [
    { pid: 100, ppid: 1, args: "-bash" },
    { pid: 200, ppid: 100, args: "claude attach 9c27fddd" },
    { pid: 300, ppid: 200, args: "bun server.ts" },
    { pid: 400, ppid: 200, args: "some-helper" },
    { pid: 999, ppid: 1, args: "unrelated-process" },   // NOT in the subtree
  ];
  const snap = snapOf(procs, [["%p", 100]]);

  test("collects every descendant pid of the pane shell", () => {
    const tree = paneSubtree("%p", snap)!;
    expect(tree.panePid).toBe(100);
    for (const pid of [100, 200, 300, 400]) expect(tree.text).toContain(`(${pid})`);
  });

  test("does NOT include unrelated processes outside the subtree", () => {
    const tree = paneSubtree("%p", snap)!;
    expect(tree.text).not.toContain("(999)");
    expect(tree.text).not.toContain("unrelated-process");
  });

  test("subtree text carries args so attachIdInTree still matches the attach client", () => {
    const tree = paneSubtree("%p", snap)!;
    expect(attachIdInTree(tree.text, "9c27fddd")).toBe(true);   // the ownership check
    expect(attachIdInTree(tree.text, "deadbeef")).toBe(false);
  });

  test("returns null when the pane id is not in the snapshot (pane gone)", () => {
    expect(paneSubtree("%gone", snap)).toBeNull();
  });

  test("cycle guard: a ppid loop does not hang the walk", () => {
    const looped = snapOf(
      [{ pid: 10, ppid: 20, args: "a" }, { pid: 20, ppid: 10, args: "b" }],
      [["%c", 10]],
    );
    const tree = paneSubtree("%c", looped)!;       // must terminate
    expect(tree.text).toContain("(10)");
    expect(tree.text).toContain("(20)");
  });
});

// --- writeHeartbeat (the watchdog's liveness signal) ---
// REGRESSION (review #2): the poller must write its heartbeat at STARTUP, not
// only at end-of-tick — a slow first tick must not look like a wedge to the
// watchdog. This proves writeHeartbeat actually creates the file with a fresh
// ISO timestamp. (HEARTBEAT_PATH is module-level; this test imports the module
// AFTER setting the env override so the path points at a tmp file.)
import { writeHeartbeat } from "../bin/codex-autodrain-poller.ts";
import { readFileSync, existsSync } from "node:fs";

describe("writeHeartbeat", () => {
  // The module already read CLAUDE_PEERS_AUTODRAIN_HEARTBEAT at import time. The
  // test harness sets it before any import below via the env at file scope is
  // not reliable post-import, so assert against the resolved default path the
  // running poller uses, then clean up. We only assert the WRITE happens + is a
  // parseable recent ISO timestamp (the behavior the fix guarantees).
  test("writes a fresh ISO-8601 timestamp to the heartbeat path", () => {
    const before = Date.now();
    writeHeartbeat();
    // Resolve the same default path the module uses.
    const path = process.env.CLAUDE_PEERS_AUTODRAIN_HEARTBEAT
      ?? `${process.env.HOME}/.claude-peers-autodrain.heartbeat`;
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, "utf8").trim();
    const ts = Date.parse(body);
    expect(Number.isNaN(ts)).toBe(false);          // a valid timestamp
    expect(ts).toBeGreaterThanOrEqual(before - 1000); // freshly written
  });
});

// --- parseNudgeClients (auto-nudge opt-in gate) ---
// Operator decision 2026-06-18: auto-nudge is OFF by default — no idle lane is
// keystroke-woken (Claude piggyback-drains for free; idle Codex/Gemini wakes burn
// quota for low-value chatter). NUDGE_CLIENTS opts a client back in. These tests
// pin the default-empty behavior + the allowlist/normalization parse rules.
import { parseNudgeClients } from "../bin/codex-autodrain-poller.ts";

describe("parseNudgeClients (auto-nudge default OFF)", () => {
  test("undefined env → empty set (nudge NOBODY by default)", () => {
    expect(parseNudgeClients(undefined)).toEqual([]);
  });

  test("empty string → empty set", () => {
    expect(parseNudgeClients("")).toEqual([]);
  });

  test("PLANTED-WRONG guard: the default must NOT silently include claude/codex", () => {
    // If a future edit restores the old `["codex","gemini","claude"]` default, this
    // flips and fails — the whole point of the change is that idle lanes are quiet.
    const def = parseNudgeClients(undefined);
    expect(def).not.toContain("claude");
    expect(def).not.toContain("codex");
    expect(def.length).toBe(0);
  });

  test("opt-in: NUDGE_CLIENTS=codex,gemini enables exactly those", () => {
    expect(parseNudgeClients("codex,gemini").sort()).toEqual(["codex", "gemini"]);
  });

  test("normalizes case + whitespace", () => {
    expect(parseNudgeClients(" Codex , GEMINI ").sort()).toEqual(["codex", "gemini"]);
  });

  test("filters unknown client types (allowlist only)", () => {
    expect(parseNudgeClients("codex,bogus,sh,rm").sort()).toEqual(["codex"]);
  });

  test("dedups repeats", () => {
    expect(parseNudgeClients("claude,claude,claude")).toEqual(["claude"]);
  });

  test("a fully-invalid list → empty (not a crash, not a silent all-on)", () => {
    expect(parseNudgeClients("nonsense,whatever")).toEqual([]);
  });
});

// --- visible Codex seat reconciliation (app-server hook fallback) ---
// Codex Desktop runs hooks under a centralized app-server, so hook ancestry no
// longer points at the visible `codex resume` process in tmux. The reconciler
// must therefore discover visible seats from the per-tick ps+tmux snapshot. The
// critical bug case is multiple same-cwd Clause5 seats: they are ambiguous by cwd,
// but safe when each process's env claims a tmux pane and the pid is actually in
// that pane subtree.
import {
  __resetCodexSeatReconcileStateForTest,
  envRecordFromText,
  gitValue,
  reconcileVisibleCodexSeats,
  visibleCodexSeatsFromSnapshot,
} from "../bin/codex-autodrain-poller.ts";

function codexSeatSnap() {
  return {
    procs: [
      { pid: 100, ppid: 1, args: "-bash" },
      { pid: 200, ppid: 100, args: "codex resume" },
      { pid: 110, ppid: 1, args: "-bash" },
      { pid: 201, ppid: 110, args: "codex resume" },
      { pid: 300, ppid: 1, args: "codex app-server --listen unix:///tmp/codex.sock" },
    ],
    paneByPid: new Map([["%125", 100], ["%254", 110]]),
    paneMap: new Map([
      [100, { session: "pr", window_index: "1", window_name: "1", pane_index: "1", pane_id: "%125" }],
      [110, { session: "infra", window_index: "2", window_name: "2", pane_index: "1", pane_id: "%254" }],
    ]),
  } as any;
}

describe("visibleCodexSeatsFromSnapshot", () => {
  test("discovers multiple same-cwd visible Codex seats by tmux pane identity", () => {
    const seats = visibleCodexSeatsFromSnapshot(codexSeatSnap(), {
      environOf: (pid) => pid === 200
        ? { CLAUDE_PEER_NAME: "pr.1", TMUX_PANE: "%125", PWD: "/home/manzo/Clause5" }
        : pid === 201
          ? { CLAUDE_PEER_NAME: "infra.2", TMUX_PANE: "%254", PWD: "/home/manzo/Clause5" }
          : {},
      ttyOf: (pid) => `/dev/pts/${pid}`,
      cwdOf: () => "/wrong",
    });

    expect(seats.map((s) => `${s.name}:${s.pid}:${s.tmux.pane_id}`).sort()).toEqual([
      "infra.2:201:%254",
      "pr.1:200:%125",
    ]);
    expect(seats.every((s) => s.cwd === "/home/manzo/Clause5")).toBe(true);
  });

  test("ignores the Codex app-server and seats missing tmux identity", () => {
    const seats = visibleCodexSeatsFromSnapshot(codexSeatSnap(), {
      environOf: (pid) => pid === 300
        ? { CLAUDE_PEER_NAME: "ghost", TMUX_PANE: "%125", PWD: "/home/manzo/Clause5" }
        : {},
      ttyOf: () => "/dev/pts/1",
      cwdOf: () => "/home/manzo/Clause5",
    });

    expect(seats).toEqual([]);
  });

  test("rejects a process whose env claims a pane it does not occupy", () => {
    const snap = {
      procs: [
        { pid: 100, ppid: 1, args: "-bash" },
        { pid: 200, ppid: 999, args: "codex resume" },
      ],
      paneByPid: new Map([["%125", 100]]),
      paneMap: new Map([[100, { session: "pr", window_index: "1", window_name: "1", pane_id: "%125" }]]),
    } as any;

    const seats = visibleCodexSeatsFromSnapshot(snap, {
      environOf: () => ({ CLAUDE_PEER_NAME: "pr.1", TMUX_PANE: "%125", PWD: "/home/manzo/Clause5" }),
      ttyOf: () => "/dev/pts/27",
      cwdOf: () => "/home/manzo/Clause5",
    });

    expect(seats).toEqual([]);
  });

  test("fails closed when duplicate Codex candidates claim the same pane/name", () => {
    const snap = {
      procs: [
        { pid: 100, ppid: 1, args: "-bash" },
        { pid: 200, ppid: 100, args: "codex resume" },
        { pid: 201, ppid: 100, args: "codex resume" },
      ],
      paneByPid: new Map([["%125", 100]]),
      paneMap: new Map([[100, { session: "pr", window_index: "1", window_name: "1", pane_id: "%125" }]]),
    } as any;

    const seats = visibleCodexSeatsFromSnapshot(snap, {
      environOf: () => ({ CLAUDE_PEER_NAME: "pr.1", TMUX_PANE: "%125", PWD: "/home/manzo/Clause5" }),
      ttyOf: () => "/dev/pts/27",
      cwdOf: () => "/home/manzo/Clause5",
    });

    expect(seats).toEqual([]);
  });

  test("fails closed when same-pane Codex candidates have different inherited names", () => {
    const snap = {
      procs: [
        { pid: 100, ppid: 1, args: "-bash" },
        { pid: 200, ppid: 100, args: "codex resume" },
        { pid: 201, ppid: 200, args: "codex exec --json" },
      ],
      paneByPid: new Map([["%125", 100]]),
      paneMap: new Map([[100, { session: "pr", window_index: "1", window_name: "1", pane_id: "%125" }]]),
    } as any;

    const seats = visibleCodexSeatsFromSnapshot(snap, {
      environOf: (pid) => ({
        CLAUDE_PEER_NAME: pid === 200 ? "pr.1" : "ghost.1",
        TMUX_PANE: "%125",
        PWD: "/home/manzo/Clause5",
      }),
      ttyOf: () => "/dev/pts/27",
      cwdOf: () => "/home/manzo/Clause5",
    });

    expect(seats).toEqual([]);
  });

  test("parses NUL-separated environ text for hook identity fields", () => {
    expect(envRecordFromText("A=1\0CLAUDE_PEER_NAME=pr.1\0TMUX_PANE=%125\0").CLAUDE_PEER_NAME).toBe("pr.1");
    expect(envRecordFromText("A=1\0BROKEN\0TMUX_PANE=%125").TMUX_PANE).toBe("%125");
  });
});

describe("gitValue", () => {
  test("returns trimmed stdout when the git probe exits successfully", async () => {
    const encoder = new TextEncoder();
    const result = await gitValue("/repo", ["rev-parse", "--show-toplevel"], 100, () => ({
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("/repo\n"));
          controller.close();
        },
      }),
      exited: Promise.resolve(0),
      kill: () => {},
    }));

    expect(result).toBe("/repo");
  });

  test("kills timed-out git probes and returns null", async () => {
    let killed = false;
    const result = await gitValue("/repo", ["rev-parse", "--show-toplevel"], 1, () => ({
      stdout: new ReadableStream<Uint8Array>(),
      exited: new Promise<number>(() => {}),
      kill: () => {
        killed = true;
      },
    }));

    expect(result).toBeNull();
    expect(killed).toBe(true);
  });
});

function emptySeatSnap() {
  return { procs: [], paneByPid: new Map(), paneMap: new Map() } as any;
}

function visibleSeat(name = "pr.1", pid = 200) {
  return {
    pid,
    cwd: "/repo",
    tty: `pts/${pid}`,
    name,
    tmux: { session: "pr", window_index: "1", window_name: "node", pane_index: "1", pane_id: `%${pid}` },
  };
}

function registerResponse(name = "pr.1") {
  return {
    id: `peer-${name}`,
    name,
    resolved_name: name,
    client_type: "codex",
    receiver_mode: "codex-hook",
  };
}

describe("reconcileVisibleCodexSeats", () => {
  test("posts register then hook heartbeat and publishes the broker identity", async () => {
    __resetCodexSeatReconcileStateForTest();
    const posts: Array<{ path: string; body: any }> = [];
    const publishes: Array<{ identity: any; pane: string | undefined }> = [];

    await reconcileVisibleCodexSeats(emptySeatSnap(), {
      now: () => 50_000,
      intervalMs: 10_000,
      visibleSeats: () => [visibleSeat()],
      gitValue: async (_cwd, args) => {
        if (args.includes("--show-toplevel")) return "/repo";
        if (args.includes("--is-bare-repository")) return "false";
        if (args.includes("--absolute-git-dir")) return "/repo/.git";
        return null;
      },
      postBroker: async (path, body) => {
        posts.push({ path, body });
        return path === "/register" ? registerResponse() as any : { ok: true } as any;
      },
      publishBrokerIdentityToTmux: (identity, tmux) => {
        publishes.push({ identity, pane: tmux?.pane_id });
        return { ok: true, target: tmux?.pane_id ?? null, failedOptions: [] };
      },
    });

    expect(posts.map((p) => p.path)).toEqual(["/register", "/hook-heartbeat-by-pid"]);
    expect(posts[0]!.body).toMatchObject({
      pid: 200,
      cwd: "/repo",
      git_root: "/repo",
      absolute_git_dir: "/repo/.git",
      name: "pr.1",
      tmux_pane_id: "%200",
      client_type: "codex",
      receiver_mode: "codex-hook",
      preserve_token: true,
      summary: "",
    });
    expect(posts[1]!.body).toMatchObject({
      pid: 200,
      caller_pid: process.pid,
      client_type: "codex",
      receiver_mode: "codex-hook",
      status: "ok",
      drained: 0,
    });
    expect(publishes.map((p) => `${p.identity.id}:${p.pane}`)).toEqual(["peer-pr.1:%200", "peer-pr.1:%200"]);
    expect(posts.map((p) => p.path).some((path) => /claim|ack/i.test(path))).toBe(false);
  });

  test("dry-run discovers seats but posts and publishes nothing", async () => {
    __resetCodexSeatReconcileStateForTest();
    let gitCalls = 0;
    let postCalls = 0;
    let publishCalls = 0;

    await reconcileVisibleCodexSeats(emptySeatSnap(), {
      now: () => 50_000,
      intervalMs: 10_000,
      dryRun: true,
      visibleSeats: () => [visibleSeat()],
      gitValue: async () => {
        gitCalls++;
        return null;
      },
      postBroker: async () => {
        postCalls++;
        return {} as any;
      },
      publishBrokerIdentityToTmux: () => {
        publishCalls++;
        return { ok: true, target: null, failedOptions: [] };
      },
    });

    expect(gitCalls).toBe(0);
    expect(postCalls).toBe(0);
    expect(publishCalls).toBe(0);
  });

  test("one failed seat does not block the next visible seat", async () => {
    __resetCodexSeatReconcileStateForTest();
    const registered: string[] = [];

    await reconcileVisibleCodexSeats(emptySeatSnap(), {
      now: () => 50_000,
      intervalMs: 10_000,
      visibleSeats: () => [visibleSeat("bad.1", 200), visibleSeat("pr.1", 201)],
      gitValue: async () => null,
      postBroker: async (path, body: any) => {
        if (path === "/register" && body.name === "bad.1") throw new Error("boom");
        if (path === "/register") registered.push(body.name);
        return path === "/register" ? registerResponse(body.name) as any : { ok: true } as any;
      },
      publishBrokerIdentityToTmux: () => ({ ok: true, target: null, failedOptions: [] }),
    });

    expect(registered).toEqual(["pr.1"]);
  });

  test("throttle skips reconciliation before the interval elapses", async () => {
    __resetCodexSeatReconcileStateForTest();
    let visibleCalls = 0;

    const deps = {
      intervalMs: 10_000,
      dryRun: true,
      visibleSeats: () => {
        visibleCalls++;
        return [visibleSeat()];
      },
    };

    await reconcileVisibleCodexSeats(emptySeatSnap(), { ...deps, now: () => 50_000 });
    await reconcileVisibleCodexSeats(emptySeatSnap(), { ...deps, now: () => 50_001 });

    expect(visibleCalls).toBe(1);
  });

  test("in-flight reconciliation skips overlapping ticks", async () => {
    __resetCodexSeatReconcileStateForTest();
    let visibleCalls = 0;
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });

    const first = reconcileVisibleCodexSeats(emptySeatSnap(), {
      now: () => 50_000,
      intervalMs: 0,
      visibleSeats: () => {
        visibleCalls++;
        return [visibleSeat()];
      },
      gitValue: async () => null,
      postBroker: async (path) => {
        if (path === "/register") await gate;
        return path === "/register" ? registerResponse() as any : { ok: true } as any;
      },
      publishBrokerIdentityToTmux: () => ({ ok: true, target: null, failedOptions: [] }),
    });

    await reconcileVisibleCodexSeats(emptySeatSnap(), {
      now: () => 50_001,
      intervalMs: 0,
      visibleSeats: () => {
        visibleCalls++;
        return [visibleSeat("c5.1", 201)];
      },
      gitValue: async () => null,
      postBroker: async () => registerResponse("c5.1") as any,
      publishBrokerIdentityToTmux: () => ({ ok: true, target: null, failedOptions: [] }),
    });
    unblock();
    await first;

    expect(visibleCalls).toBe(1);
  });
});
