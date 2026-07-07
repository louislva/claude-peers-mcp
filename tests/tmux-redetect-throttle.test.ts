/**
 * Throttle for the heartbeat tmux pane re-detect (shouldRedetectTmux).
 *
 * Bug: every server.ts instance ran detectTmuxPane() — a `tmux list-panes -a`
 * server-wide scan — on EVERY 15s heartbeat. With a large fleet (32 servers
 * measured), the single-threaded tmux server saturated: a scan that nominally
 * takes ~1s blocked 18-21s, starving pane repaint and causing visible input lag +
 * cursor jitter while typing. The scan only catches RARE events (a pane reused by
 * a new session, a UI pane-move), so it is throttled to every Nth heartbeat. On the
 * skipped ticks the server re-publishes its identity to the last-known pane (cheap
 * O(1) writes) without re-scanning.
 *
 * shouldRedetectTmux is the pure decision: true on the ticks where the expensive
 * re-detect runs. `jitter` de-phases the fleet so N servers don't all scan together.
 */
import { describe, test, expect } from "bun:test";
import { shouldRedetectTmux } from "../server.ts";

describe("shouldRedetectTmux", () => {
  test("every=1 → true on EVERY tick (old behavior / test mode)", () => {
    for (let t = 0; t < 10; t++) expect(shouldRedetectTmux(t, 0, 1)).toBe(true);
  });

  test("every=8, jitter=0 → true once per 8 ticks (12.5% of heartbeats scan)", () => {
    const hits = Array.from({ length: 24 }, (_, t) => shouldRedetectTmux(t, 0, 8));
    // exactly 3 trues over 24 ticks (t=0,8,16)
    expect(hits.filter(Boolean).length).toBe(3);
    expect(hits[0]).toBe(true);
    expect(hits[8]).toBe(true);
    expect(hits[16]).toBe(true);
    expect(hits[1]).toBe(false);
    expect(hits[7]).toBe(false);
  });

  test("jitter shifts WHICH ticks fire but not HOW MANY (fleet de-phasing)", () => {
    // Two servers with different jitter must scan on DIFFERENT ticks, each still
    // exactly once per period — this is what prevents the thundering herd.
    const every = 8;
    const a = Array.from({ length: 16 }, (_, t) => shouldRedetectTmux(t, 0, every));
    const b = Array.from({ length: 16 }, (_, t) => shouldRedetectTmux(t, 3, every));
    expect(a.filter(Boolean).length).toBe(b.filter(Boolean).length); // same RATE
    // server A fires at t=0,8; server B (jitter 3) fires at t=5,13 — disjoint
    expect(a[0]).toBe(true);
    expect(b[0]).toBe(false);
    expect(b[5]).toBe(true);
    expect(a[5]).toBe(false);
  });

  test("REGRESSION GUARD: every=8 must NOT scan on every tick (the bug)", () => {
    // If a future edit drops the throttle (back to scan-every-tick), this fails.
    const firstEight = Array.from({ length: 8 }, (_, t) => shouldRedetectTmux(t, 0, 8));
    expect(firstEight.filter(Boolean).length).toBe(1); // exactly ONE scan per 8 ticks, not 8
  });

  test("guards every<1 (modulo-by-zero / negative) → behaves as every=1, never wedges", () => {
    // A bad env (CLAUDE_PEERS_TMUX_REDETECT_EVERY=0 or negative) must NOT produce a
    // never-true schedule (which would stop pane re-detection forever) nor crash.
    expect(shouldRedetectTmux(0, 0, 0)).toBe(true);
    expect(shouldRedetectTmux(5, 0, -4)).toBe(true);
    for (let t = 0; t < 5; t++) expect(shouldRedetectTmux(t, 0, 0)).toBe(true);
  });

  test("fractional every is floored (defensive against a non-integer env)", () => {
    // every=8.9 floors to 8 → 1 hit per 8 ticks.
    const hits = Array.from({ length: 8 }, (_, t) => shouldRedetectTmux(t, 0, 8.9));
    expect(hits.filter(Boolean).length).toBe(1);
  });
});
