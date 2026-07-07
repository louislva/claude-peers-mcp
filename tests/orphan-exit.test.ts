/**
 * Orphan self-reap decision (shouldOrphanExit) — TIME-BASED.
 *
 * Bug: a Codex/Claude session that re-spawns its claude-peers MCP server leaves
 * the OLD server.ts process running. The broker reclaims that old peer's row, so
 * the orphan's token is invalid — every heartbeat 401s, and the re-register
 * recovery mints throwaway rows that dedup immediately reclaims, looping forever.
 * Observed live 2026-06-19: 21 orphaned ghosts → 387,823 auth-fails / 24MB broker
 * log. From a peer's seat this reads as "broker is down" (a 401 auth-reject is
 * indistinguishable from broker-unreachable), though the broker is healthy.
 *
 * Fix: exit when auth has been continuously broken for a wall-clock GRACE window.
 * TIME-based, NOT count-based — brokerFetch is driven by the 15s heartbeat, the 1s
 * background poll (Claude), AND user tool calls, so a raw COUNT would cross a small
 * threshold in seconds on the 1s poll and risk a mass false self-kill of HEALTHY
 * servers during a transient broker restart/flap. A wall-clock window is cadence-
 * independent: a transient blip (which the re-register path recovers, landing a
 * SUCCESS that clears the streak) never reaches it. shouldOrphanExit(streakStart,
 * now, graceMs) is the pure decision; brokerFetch records the streak start / clears
 * it on success, and the HEARTBEAT TIMER (not brokerFetch) calls it + exits — so a
 * user tool call never dies mid-request.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { shouldOrphanExit, nextChurnStreak } from "../server.ts";

const T0 = 1_000_000_000_000; // fixed base epoch (Date.now is banned in some harnesses; use literals)
const GRACE = 300_000;        // 5 min default

describe("shouldOrphanExit (time-based)", () => {
  test("no active streak (null) → never exits", () => {
    expect(shouldOrphanExit(null, T0, GRACE)).toBe(false);
    expect(shouldOrphanExit(null, T0 + 10 * GRACE, GRACE)).toBe(false);
  });

  test("streak shorter than the grace window → does NOT exit", () => {
    expect(shouldOrphanExit(T0, T0 + 1_000, GRACE)).toBe(false);        // 1s in
    expect(shouldOrphanExit(T0, T0 + GRACE - 1, GRACE)).toBe(false);    // 1ms short
  });

  test("streak at/over the grace window → exits", () => {
    expect(shouldOrphanExit(T0, T0 + GRACE, GRACE)).toBe(true);         // exactly at
    expect(shouldOrphanExit(T0, T0 + GRACE + 60_000, GRACE)).toBe(true);// well past
  });

  test("REGRESSION GUARD: cadence-independence — a 1s-poll storm cannot trip it early", () => {
    // The whole point of going time-based: no matter HOW MANY 401s arrive (the 1s
    // poll could log hundreds), only WALL-CLOCK elapsed matters. 10 seconds of
    // continuous 401s (what a count-based threshold of 10 would have killed on the
    // 1s poll) must NOT exit under the 5-min window.
    expect(shouldOrphanExit(T0, T0 + 10_000, GRACE)).toBe(false);
  });

  test("grace-window floor: a misconfigured tiny window is clamped to 60s", () => {
    // CLAUDE_PEERS_ORPHAN_EXIT_GRACE_MS=1000 (or 0/negative) must NOT let a healthy
    // server exit after 1s of transient 401s — the 60s floor prevents that footgun.
    expect(shouldOrphanExit(T0, T0 + 1_000, 1_000)).toBe(false);  // 1s elapsed, clamped floor 60s
    expect(shouldOrphanExit(T0, T0 + 1_000, 0)).toBe(false);
    expect(shouldOrphanExit(T0, T0 + 60_000, 1_000)).toBe(true);  // 60s reaches the clamped floor
    expect(shouldOrphanExit(T0, T0 + 60_000, -5)).toBe(true);
  });

  test("realistic orphan: continuously 401'd for 5 min → exit", () => {
    expect(shouldOrphanExit(T0, T0 + 300_000, GRACE)).toBe(true);
  });

  test("a success-cleared streak (null again) never exits even long after", () => {
    // After any successful broker call brokerFetch sets firstUnrecoverable401At=null;
    // a later check must see no streak.
    expect(shouldOrphanExit(null, T0 + 999_999_999, GRACE)).toBe(false);
  });
});

/**
 * Re-register CHURN streak (nextChurnStreak) — the 2026-06-30 fix.
 *
 * The plain firstUnrecoverable401At streak is cleared by ANY success, including the
 * SUCCESS on the post-re-register retry. A genuinely orphaned server 401s → recovers
 * by re-registering into a fresh token → that retry SUCCEEDS (clearing the plain
 * streak) → the new token is reclaimed → 401 again → loop forever, never reaching the
 * grace window. (Observed live: one Codex session leaked 7 such orphans flooding 78k+
 * /heartbeat 401s; the plain self-reap never fired.) The churn streak survives a
 * post-recovery success and only clears on a NO-recovery success, so a real orphan's
 * grace window finally elapses and the heartbeat timer reaps it.
 */
describe("nextChurnStreak (re-register churn detection)", () => {
  test("first recovery STARTS the streak", () => {
    // recovered=true, succeeded=false (the recovery branch stamps before the retry)
    expect(nextChurnStreak(null, true, false, T0)).toBe(T0);
  });

  test("a direct (no-recovery) success CLEARS the streak", () => {
    expect(nextChurnStreak(T0, false, true, T0 + 5_000)).toBe(null);
    expect(nextChurnStreak(null, false, true, T0 + 5_000)).toBe(null);
  });

  test("THE FIX: a post-re-register success LEAVES the streak running (orphan-churn)", () => {
    // This is the exact case the old code got wrong: it cleared on this success.
    // recovered=true, succeeded=true → keep the ORIGINAL start time, do not reset.
    expect(nextChurnStreak(T0, true, true, T0 + 15_000)).toBe(T0);
  });

  test("a continuing recovery keeps the ORIGINAL start (does not slide the window)", () => {
    // Each subsequent 401-recovery must not reset the clock — else it never elapses.
    expect(nextChurnStreak(T0, true, false, T0 + 30_000)).toBe(T0);
    expect(nextChurnStreak(T0, true, true, T0 + 45_000)).toBe(T0);
  });

  test("a non-recovery, non-success (e.g. a non-401 error) leaves the streak as-is", () => {
    expect(nextChurnStreak(T0, false, false, T0 + 1_000)).toBe(T0);
    expect(nextChurnStreak(null, false, false, T0 + 1_000)).toBe(null);
  });

  test("END-TO-END orphan loop: streak survives N churn cycles and finally exits", () => {
    // Simulate the real loop: 401→recover→success, repeated, each ~15s apart.
    let streak: number | null = null;
    let t = T0;
    for (let cycle = 0; cycle < 25; cycle++) {       // 25 cycles × 15s = 375s > GRACE
      streak = nextChurnStreak(streak, true, false, t);   // 401 triggers recovery
      t += 100;
      streak = nextChurnStreak(streak, true, true, t);    // post-re-register retry succeeds
      t += 14_900;
      // The OLD code cleared here → never exits. The fix keeps the streak.
      expect(streak).toBe(T0);                            // start never moves
    }
    // After ~375s of churn the grace window has elapsed → orphan exits.
    expect(shouldOrphanExit(streak, t, GRACE)).toBe(true);
  });

  test("REGRESSION GUARD: a transient blip that genuinely recovers does NOT trip it", () => {
    // One 401 → recover → then HEALTHY direct successes (no more recovery). The
    // churn streak must clear on the first no-recovery success so a real recovery
    // is never mistaken for an orphan.
    let streak: number | null = null;
    streak = nextChurnStreak(streak, true, false, T0);        // blip: 401 recovery starts streak
    streak = nextChurnStreak(streak, true, true, T0 + 50);    // recovery retry succeeds (streak still set)
    expect(streak).toBe(T0);
    streak = nextChurnStreak(streak, false, true, T0 + 15_000); // next heartbeat: DIRECT success
    expect(streak).toBe(null);                                // cleared — healthy again
    expect(shouldOrphanExit(streak, T0 + 999_999, GRACE)).toBe(false);
  });
});

/**
 * Churn-streak WIRING sentinels + the nested-/register regression.
 *
 * The pure nextChurnStreak tests above pass regardless of whether brokerFetch and
 * the heartbeat timer actually CALL it correctly. brokerFetch closes over module
 * state and can't be imported, so — per the repo's established source-grep sentinel
 * pattern (client-detection.test.ts) — these assert the production wiring in
 * server.ts source. A blind code-review (2026-06-30) found the original wiring was
 * defeated: reregisterPeer's brokerFetch("/register") success (default _retry=false)
 * cleared the very streak the enclosing recovery had just set, so the streak reset
 * every cycle and the recover-every-cycle orphan was never reaped. The fix routes a
 * /register success through the recovery branch (does NOT clear). These sentinels
 * lock that wiring; dropping any one re-opens the defect with green unit tests.
 */
describe("churn streak is WIRED into brokerFetch + the heartbeat timer (source-grep sentinels)", () => {
  const src = () => readFileSync(new URL("../server.ts", import.meta.url), "utf8");

  test("recovery path STARTS the churn streak (recovered=true, succeeded=false)", () => {
    expect(src()).toMatch(/firstReregisterChurnAt\s*=\s*nextChurnStreak\(\s*firstReregisterChurnAt\s*,\s*true\s*,\s*false\s*,\s*Date\.now\(\)\s*\)/);
  });

  test("success path treats _retry OR /register as recovery activity (the B1 fix)", () => {
    // The load-bearing guard: a /register success must NOT clear the streak.
    const body = src();
    expect(body).toMatch(/successIsRecoveryActivity\s*=\s*_retry\s*\|\|\s*path\s*===\s*["']\/register["']/);
    expect(body).toMatch(/firstReregisterChurnAt\s*=\s*nextChurnStreak\(\s*firstReregisterChurnAt\s*,\s*successIsRecoveryActivity\s*,\s*true\s*,\s*Date\.now\(\)\s*\)/);
  });

  test("heartbeat timer ORs the churn streak into the orphan-exit decision", () => {
    const body = src();
    // Both streaks must feed shouldOrphanExit and be OR-combined into the exit; the
    // timestamp arg is matched loosely (Date.now()/a hoisted now-var) so a cosmetic
    // refactor doesn't false-fail, but the two distinct streak vars + the OR are the
    // load-bearing wiring and stay strict.
    expect(body).toMatch(/shouldOrphanExit\(\s*firstUnrecoverable401At\s*,\s*\w+(?:\.now\(\))?\s*,\s*ORPHAN_EXIT_GRACE_MS\s*\)/);
    expect(body).toMatch(/shouldOrphanExit\(\s*firstReregisterChurnAt\s*,\s*\w+(?:\.now\(\))?\s*,\s*ORPHAN_EXIT_GRACE_MS\s*\)/);
    // The two checks are OR-combined and gated on !shuttingDown (no mid-shutdown self-kill).
    expect(body).toMatch(/unrecExpired\s*\|\|\s*churnExpired/);
    expect(body).toMatch(/if\s*\(\s*!shuttingDown\s*&&/);
  });
});

/**
 * Behavioral regression for the nested-/register defeat (B1). Models the EXACT
 * sequence brokerFetch executes on each orphan cycle — recovery stamp → nested
 * /register success → outer retry success — and asserts the streak's start time
 * never moves, so a real orphan's grace window finally elapses. Goes RED if the
 * /register success is allowed to clear the streak (the pre-fix behavior).
 */
describe("nextChurnStreak: nested /register success must NOT reset the churn window (B1)", () => {
  // One orphan cycle as brokerFetch wires it. successIsRecoveryActivity = _retry || path==="/register".
  function realOrphanCycle(streak: number | null, t: number): number | null {
    streak = nextChurnStreak(streak, true, false, t);  // outer /heartbeat 401 → recovery stamp
    // nested reregisterPeer → brokerFetch("/register"): _retry=false BUT path==="/register"
    // → successIsRecoveryActivity = true (the B1 fix). Pre-fix this was `false` → cleared.
    streak = nextChurnStreak(streak, true, true, t);   // /register success — recovery activity, KEEPS streak
    streak = nextChurnStreak(streak, true, true, t);   // outer retry success (_retry=true), KEEPS streak
    return streak;
  }

  test("streak start stays anchored across churn cycles (does not slide forward)", () => {
    let streak: number | null = null;
    let t = T0;
    for (let c = 0; c < 25; c++) {
      streak = realOrphanCycle(streak, t);
      expect(streak).toBe(T0);   // anchored at the FIRST cycle — never reset by the /register success
      t += 15_000;
    }
    // ~375s of churn → grace elapsed → orphan reaps. (Pre-fix: streak == latest t → never elapses.)
    expect(shouldOrphanExit(streak, t, GRACE)).toBe(true);
  });

  test("VoV: the OLD clear-on-/register-success logic would NEVER reap (planted-error)", () => {
    // Reproduce the pre-fix wiring: /register success passed recovered=false → cleared.
    function brokenCycle(streak: number | null, t: number): number | null {
      streak = nextChurnStreak(streak, true, false, t);
      streak = nextChurnStreak(streak, false, true, t);  // BUG: /register success cleared it
      streak = nextChurnStreak(streak, true, true, t);   // retry re-starts at t
      return streak;
    }
    let streak: number | null = null;
    let t = T0;
    for (let c = 0; c < 50; c++) { streak = brokenCycle(streak, t); t += 15_000; }
    // streak always == latest t → age ~0 → never reaps. Proves the fix is load-bearing.
    expect(shouldOrphanExit(streak, t, GRACE)).toBe(false);
  });
});
