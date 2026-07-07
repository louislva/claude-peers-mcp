/**
 * Regression tests for two seat-plumbing bugs (SPEC-01 planted-error style):
 *
 *   Bug 1 — dead-PID seat reclaim regardless of age. A live process re-claiming
 *   a tmux pane whose only occupant is a CONFIRMED-DEAD row must inherit that
 *   row (and its stranded undelivered mail) even when the dead row is older than
 *   REHYDRATE_WINDOW_MS. The old code applied the 1h age gate BEFORE the liveness
 *   check, so a long-dead tombstone was skipped -> the live proc got a fresh id
 *   -> the seat was permanently deaf+mute. Fix: liveness before age; a dead
 *   candidate is inheritable at any age.
 *
 *   Bug 3 — the autodrain poller's lane query skipped zero-mail seats
 *   (HAVING unread > 0), so a freshly-registered seat whose drain hook never
 *   attached (last_hook_seen_at IS NULL) and has no mail yet was never nudged ->
 *   its hook never attached (chicken-and-egg). Fix: also surface
 *   last_hook_seen_at IS NULL seats; MAX_NUDGE_ATTEMPTS bounds the bootstrap.
 *
 * Mirrors the inline-logic test pattern (in-memory DB + a copy of the prod
 * logic). If broker.ts / codex-autodrain-poller.ts diverge, update these copies.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { bootstrapCapBlocks, paneAlreadyNudgedThisTick } from "../bin/codex-autodrain-poller.ts";

const REHYDRATE_WINDOW_MS = 3600_000; // 1h — mirror of broker.ts

// Mirror of broker.ts rehydrate candidate-selection + inherit decision.
// Returns the inherited id, or null. `isAlive(pid)` is the test liveness oracle
// (mirrors process.kill(pid,0): true=alive/EPERM=skip, false=ESRCH=dead).
function chooseInheritedId(
  candidates: { id: string; pid: number; last_seen: string }[],
  isAlive: (pid: number) => boolean,
  nowMs: number,
): string | null {
  for (const c of candidates) {
    const lastSeenMs = new Date(c.last_seen).getTime();
    if (!Number.isFinite(lastSeenMs)) continue;
    // Liveness gate, NO age gate (mirror of broker.ts). A live (or EPERM) pid is
    // never inherited; a confirmed-dead seat is inheritable regardless of age.
    if (isAlive(c.pid)) continue;
    void nowMs; // age intentionally not gated for confirmed-dead candidates
    return c.id;
  }
  return null;
}

describe("Bug 1 — dead-PID seat reclaim regardless of age", () => {
  const isAlive = (pid: number) => pid === 1; // only pid 1 is "alive" here

  test("inherits a CONFIRMED-DEAD seat older than the 1h window (the deaf-seat bug)", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    const inherited = chooseInheritedId(
      [{ id: "deadseat", pid: 999, last_seen: twoHoursAgo }], // pid 999 dead, 2h old
      isAlive,
      Date.now(),
    );
    // Old behavior: age gate skipped it -> null -> fresh id -> deaf seat.
    // Fixed behavior: dead-at-any-age is inheritable.
    expect(inherited).toBe("deadseat");
  });

  test("does NOT inherit a still-ALIVE seat (no hijack of a live peer's id)", () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const inherited = chooseInheritedId(
      [{ id: "liveseat", pid: 1, last_seen: recent }], // pid 1 alive
      isAlive,
      Date.now(),
    );
    expect(inherited).toBeNull();
  });

  test("recent dead seat still inherits (unchanged happy path)", () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const inherited = chooseInheritedId(
      [{ id: "deadseat", pid: 999, last_seen: recent }],
      isAlive,
      Date.now(),
    );
    expect(inherited).toBe("deadseat");
  });

  test("PLANTED-WRONG guard: an alive seat must NOT be reported inheritable", () => {
    // If a future edit reorders liveness/age and lets a live pid through, this
    // catches it. A test suite that cannot fail proves nothing (SPEC-01).
    const recent = new Date(Date.now() - 60_000).toISOString();
    const inherited = chooseInheritedId(
      [{ id: "liveseat", pid: 1, last_seen: recent }],
      isAlive,
      Date.now(),
    );
    expect(inherited).not.toBe("liveseat");
  });
});

describe("Bug 1 (full fix) — reaper decouples mail-reap from row-reap", () => {
  // Mirror of broker.ts liveAndFreshPeers reap decision for a DEAD seat past the
  // 1h window. The full fix: a dead seat with PENDING mail is preserved (its mail
  // is a recoverable inbox the any-age inherit path will surface); a dead seat
  // with ZERO mail is reaped normally (bounds tombstone growth). Without this,
  // the reaper deleted the mail at 1h and the any-age inherit recovered nothing.
  type ReapAction = "reap" | "preserve-inbox" | "keep-active";
  const DEAD_MAIL_TTL_MS = 24 * 3600_000; // mirror of broker.ts default (24h)
  // lastSeenValid mirrors prod's guard: a malformed/corrupt last_seen
  // (Number.isFinite === false) means untrustworthy state — such a seat reaps
  // normally even WITH mail, so corrupt tombstones never leak forever.
  // The dead-with-mail PRESERVE path now has a TTL ceiling: mail is kept only
  // within DEAD_MAIL_TTL_MS (floored at REHYDRATE_WINDOW_MS); past it the row +
  // stranded mail are reaped instead of preserved forever.
  function reapDecision(deadPidAlive: boolean, ageMs: number, pendingMail: number, lastSeenValid = true): ReapAction {
    if (deadPidAlive && ageMs <= REHYDRATE_WINDOW_MS) return "keep-active"; // not reapable yet
    const reapable = !deadPidAlive || ageMs > REHYDRATE_WINDOW_MS;
    if (!reapable) return "keep-active";
    const mailExpired = ageMs > Math.max(REHYDRATE_WINDOW_MS, DEAD_MAIL_TTL_MS);
    if (pendingMail > 0 && lastSeenValid && !mailExpired) return "preserve-inbox"; // dead + mail + valid ts + within TTL → keep
    return "reap"; // dead + (empty OR malformed ts OR mail past TTL) → delete row+mail
  }

  test("DEAD seat >1h WITH pending mail is PRESERVED (mail survives for inheritance)", () => {
    expect(reapDecision(false, 2 * 3600_000, 3)).toBe("preserve-inbox");
  });

  test("DEAD seat >1h with ZERO mail is REAPED (no unbounded tombstone growth)", () => {
    expect(reapDecision(false, 2 * 3600_000, 0)).toBe("reap");
  });

  test("DEAD seat with MALFORMED last_seen is REAPED even WITH mail (no corrupt-tombstone leak)", () => {
    // Prod: a NaN timestamp → reapable-by-age → reaps regardless of mail. The
    // narrow exception to preserve-on-pending-mail (broker.ts lastSeenValid guard).
    expect(reapDecision(false, 2 * 3600_000, 3, /*lastSeenValid*/ false)).toBe("reap");
  });

  test("PLANTED-WRONG guard: a dead seat with mail (valid ts) WITHIN the TTL must NOT be reaped", () => {
    // 5h < 24h TTL → still a recoverable inbox. If a future edit re-deletes mail at
    // the 1h mark (drops the preserve path), this flips to "reap" and fails.
    expect(reapDecision(false, 5 * 3600_000, 1)).not.toBe("reap");
  });

  test("DEAD seat with mail PAST the 24h TTL is REAPED (the forever-leak is closed)", () => {
    // The real leak: a session dead 6 days with unread mail was preserved forever.
    expect(reapDecision(false, 6 * 24 * 3600_000, 1)).toBe("reap");
  });

  test("PLANTED-WRONG guard: dropping the TTL ceiling re-opens the forever-leak", () => {
    // If a future edit removes the mailExpired check, a 6-day dead-with-mail seat
    // goes back to "preserve-inbox" and this flips red.
    expect(reapDecision(false, 6 * 24 * 3600_000, 1)).not.toBe("preserve-inbox");
  });
});

describe("Bug 3 — autodrain surfaces NULL-hook zero-mail seats", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run(
      "CREATE TABLE peers (id TEXT PRIMARY KEY, pid INTEGER, name TEXT, client_type TEXT, tmux_pane_id TEXT, last_hook_seen_at TEXT)",
    );
    db.run(
      "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, to_id TEXT, delivered INTEGER)",
    );
  });

  // Mirror of codex-autodrain-poller.ts lanesWithUnread() — the fixed query.
  function lanesWithUnread(): { id: string; unread: number; last_hook_seen_at: string | null }[] {
    return db
      .query(
        `SELECT p.id, p.last_hook_seen_at, COUNT(m.id) AS unread
         FROM peers p
         LEFT JOIN messages m ON m.to_id = p.id AND m.delivered = 0
         WHERE p.client_type IN ('codex','gemini','claude')
         GROUP BY p.id
         HAVING unread > 0 OR p.last_hook_seen_at IS NULL`,
      )
      .all() as { id: string; unread: number; last_hook_seen_at: string | null }[];
  }

  test("surfaces a fresh NULL-hook seat with ZERO mail (the bootstrap-nudge case)", () => {
    db.run(
      "INSERT INTO peers (id, pid, name, client_type, last_hook_seen_at) VALUES ('fresh', 100, 'infra.4', 'claude', NULL)",
    );
    const lanes = lanesWithUnread();
    const fresh = lanes.find((l) => l.id === "fresh");
    expect(fresh).toBeDefined();
    expect(fresh!.unread).toBe(0); // COUNT(m.id) over no rows = 0 (not 1 — would be wrong with COUNT(*))
  });

  test("surfaces a seat WITH unread mail (unchanged behavior)", () => {
    db.run(
      "INSERT INTO peers (id, pid, name, client_type, last_hook_seen_at) VALUES ('hasmail', 101, 'coding.1', 'claude', '2026-06-17T05:00:00Z')",
    );
    db.run("INSERT INTO messages (to_id, delivered) VALUES ('hasmail', 0)");
    const lanes = lanesWithUnread();
    const hasmail = lanes.find((l) => l.id === "hasmail");
    expect(hasmail).toBeDefined();
    expect(hasmail!.unread).toBe(1);
  });

  test("does NOT surface a hook-attached seat with zero mail (no needless nudge)", () => {
    db.run(
      "INSERT INTO peers (id, pid, name, client_type, last_hook_seen_at) VALUES ('healthy', 102, 'rag.1', 'claude', '2026-06-17T05:00:00Z')",
    );
    const lanes = lanesWithUnread();
    expect(lanes.find((l) => l.id === "healthy")).toBeUndefined();
  });
});

describe("Bug 4 — bootstrap-nudge storm guards (A1 lifetime cap + A2 per-pane dedup)", () => {
  // Bug 4: the NULL-hook bootstrap path (Bug 3's fix) correctly SURFACES a
  // zero-mail unattached lane, but had no termination for a lane whose hook never
  // binds (a detached bg-Claude lane). Combined with multiple lanes resolving to
  // ONE pane, an innocent foreground pane was nudged repeatedly per cycle. Two
  // guards fix it, both now PURE EXPORTED functions in codex-autodrain-poller.ts
  // that tick() calls directly (so these tests exercise the real prod decision, not
  // an in-test copy):
  //   A1 — bootstrapCapBlocks: a zero-mail (bootstrap) lane is nudged AT MOST ONCE.
  //   A2 — paneAlreadyNudgedThisTick: one physical pane is nudged AT MOST ONCE/tick.
  // Field captured live (2026-06-18): pane %433 carried 3 clause5.6 rows, 2 of them
  // NULL-hook+zero-mail, nudged interleaved every ~60s (attempts 1→3).

  // recordBootstrap mirrors ONLY nudge()'s bookkeeping (a zero-mail nudge records
  // the id, but only on a successful submit). The DECISION under test —
  // bootstrapCapBlocks — is the real prod export, so a regression in tick()'s guard
  // is caught here. submitOk defaults true (the happy path).
  function recordBootstrap(unread: number, id: string, seen: Set<string>, submitOk = true): void {
    if (!submitOk) return;                         // failed submit → no bookkeeping
    if (unread === 0) seen.add(id);
  }

  test("a zero-mail NULL-hook lane is nudged ONCE, then never again (A1 lifetime cap)", () => {
    const seen = new Set<string>();
    // Tick 1: not blocked → nudge → record.
    expect(bootstrapCapBlocks(0, seen.has("ghost"))).toBe(false);
    recordBootstrap(0, "ghost", seen);
    // Tick 2..N: same lane, still zero mail, still NULL-hook → now blocked.
    expect(bootstrapCapBlocks(0, seen.has("ghost"))).toBe(true);
    expect(bootstrapCapBlocks(0, seen.has("ghost"))).toBe(true);
  });

  test("a lane that later receives REAL mail bypasses the bootstrap cap (still nudges)", () => {
    const seen = new Set<string>();
    expect(bootstrapCapBlocks(0, seen.has("ghost"))).toBe(false);
    recordBootstrap(0, "ghost", seen);             // bootstrap consumed
    expect(bootstrapCapBlocks(0, seen.has("ghost"))).toBe(true); // capped while zero-mail
    // Mail arrives → unread > 0 → the cap does not apply (real mail must deliver).
    expect(bootstrapCapBlocks(2, seen.has("ghost"))).toBe(false);
  });

  test("PLANTED-WRONG guard: real export blocks a re-bootstrapped deaf seat", () => {
    // bootstrapCapBlocks is the actual tick() guard. If a future edit weakens it so
    // a recorded zero-mail lane is no longer blocked, this expectation flips —
    // catching a real prod regression (not just an in-test copy).
    const seen = new Set<string>();
    recordBootstrap(0, "ghost", seen);
    expect(bootstrapCapBlocks(0, seen.has("ghost"))).toBe(true);
  });

  test("a FAILED C-m submit does NOT consume the lifetime cap (lane stays eligible)", () => {
    // The nudge typed text but the submit failed (pane vanished in the settle) — it
    // never fired as a turn, so the one-shot cap must survive for a real retry.
    const seen = new Set<string>();
    recordBootstrap(0, "ghost", seen, /*submitOk*/ false);
    expect(seen.has("ghost")).toBe(false);                       // cap NOT burned
    expect(bootstrapCapBlocks(0, seen.has("ghost"))).toBe(false); // still nudgeable
    // A subsequent successful submit then consumes the cap exactly once.
    recordBootstrap(0, "ghost", seen, /*submitOk*/ true);
    expect(bootstrapCapBlocks(0, seen.has("ghost"))).toBe(true);
  });

  // --- A2: drive the real paneAlreadyNudgedThisTick export ---
  // Replicate ONLY tick()'s loop scaffolding (claim-after-nudge); the DECISION
  // (paneAlreadyNudgedThisTick) is the real prod export under test.
  function nudgesThisTick(lanesByPane: { id: string; pane: string }[]): string[] {
    const claimed = new Set<string>();
    const nudged: string[] = [];
    for (const lane of lanesByPane) {
      if (paneAlreadyNudgedThisTick(lane.pane, claimed)) continue; // A2 — real export
      nudged.push(lane.id);
      claimed.add(lane.pane);                                      // claim-after-nudge (tick() scaffolding)
    }
    return nudged;
  }

  test("three lanes on ONE pane produce exactly ONE nudge that tick (A2 dedup)", () => {
    // The live %433 shape: 3 clause5.6 rows on the same pane.
    const nudged = nudgesThisTick([
      { id: "yg1wvppe", pane: "%433" },
      { id: "pzvp8mf3", pane: "%433" },
      { id: "jiyh6aqs", pane: "%433" },
    ]);
    expect(nudged).toEqual(["yg1wvppe"]); // first claimant only
    expect(nudged.length).toBe(1);        // not 3 — the storm is gone
  });

  test("lanes on DISTINCT panes each nudge (dedup does not over-suppress)", () => {
    const nudged = nudgesThisTick([
      { id: "a", pane: "%1" },
      { id: "b", pane: "%2" },
      { id: "c", pane: "%3" },
    ]);
    expect(nudged).toEqual(["a", "b", "c"]);
  });

  test("PLANTED-WRONG guard: the real export blocks a second lane on a claimed pane", () => {
    // paneAlreadyNudgedThisTick is the actual tick() guard. A claimed pane must
    // block the next lane; without it the pane is nudged once per lane (the storm).
    const claimed = new Set<string>(["%9"]);
    expect(paneAlreadyNudgedThisTick("%9", claimed)).toBe(true);   // claimed → blocked
    expect(paneAlreadyNudgedThisTick("%8", claimed)).toBe(false);  // unclaimed → allowed
    // End-to-end via the loop: two lanes on one pane → exactly one nudge.
    const nudged = nudgesThisTick([{ id: "x", pane: "%9" }, { id: "y", pane: "%9" }]);
    expect(nudged.length).toBe(1);
  });
});

describe("Bug 5 — seat-supersede: a live older same-seat duplicate is told to step down", () => {
  // Root cause of the "seat churn" (xkcf84xp <-> ltv3gknh ping-pong, 2026-06-27):
  // a `claude --resume` / bg-spare / MCP re-init spawns a NEW server.ts for a pane
  // while the OLD server for that same pane keeps running. Both have valid tokens,
  // so neither 401s — the broker ping-pongs `last_seen` between two live
  // registrations on one seat → unreliable 1:1 delivery. The old seat-dedup left a
  // LIVE duplicate untouched ("a live row is not stale — never touch it"); that's
  // the gap. Fix: the newest registrant is authoritative, so every LIVE older
  // same-seat self-dup is flagged superseded → told to step down on its next
  // heartbeat → exits → one live registration remains.
  //
  // Mirror of broker.ts liveDuplicatesToSupersede (broker.ts is not import-safe —
  // top-level Bun.serve + Database; the repo mirrors broker decisions in tests).
  function liveDuplicatesToSupersede(
    dups: { id: string; pid: number }[],
    isAlive: (pid: number) => boolean,
  ): string[] {
    return dups.filter((d) => isAlive(d.pid)).map((d) => d.id);
  }

  // selectSamePaneSelfDuplicates returns rows for the SAME seat with a DIFFERENT
  // pid than the registrant (newest-first), so the registrant is never in `dups`.
  test("a LIVE older duplicate on the same seat is superseded (the churn fix)", () => {
    const alive = (pid: number) => pid === 383761; // the old live leftover
    const dups = [{ id: "xkcf84xp", pid: 383761 }]; // older live row on pane %5
    expect(liveDuplicatesToSupersede(dups, alive)).toEqual(["xkcf84xp"]);
  });

  test("a DEAD older duplicate is NOT superseded (dead-row paths own it)", () => {
    const alive = (_pid: number) => false; // the old row's pid is dead
    const dups = [{ id: "deadseat", pid: 999 }];
    expect(liveDuplicatesToSupersede(dups, alive)).toEqual([]); // dedup/rehydrate handle dead rows
  });

  test("ALL live older dups are superseded (newest registrant wins over every leftover)", () => {
    const alive = (_pid: number) => true; // every leftover still running
    const dups = [
      { id: "a", pid: 100 },
      { id: "b", pid: 200 },
      { id: "c", pid: 300 },
    ];
    expect(liveDuplicatesToSupersede(dups, alive).sort()).toEqual(["a", "b", "c"]);
  });

  test("mixed live/dead: only the LIVE leftovers are superseded", () => {
    const alive = (pid: number) => pid === 100 || pid === 300; // 200 is dead
    const dups = [
      { id: "live1", pid: 100 },
      { id: "dead", pid: 200 },
      { id: "live2", pid: 300 },
    ];
    expect(liveDuplicatesToSupersede(dups, alive).sort()).toEqual(["live1", "live2"]);
  });

  test("no duplicates → nobody superseded (the common, healthy case)", () => {
    expect(liveDuplicatesToSupersede([], () => true)).toEqual([]);
  });

  test("PLANTED-WRONG guard: superseding DEAD rows would corrupt the rehydration path", () => {
    // If a future edit drops the liveness filter (supersedes every dup incl. dead
    // ones), this flips — and dead rows would be wrongly told to step down,
    // stealing the rehydration/inherit path's recoverable-mail tombstone.
    const alive = (_pid: number) => false;
    const dups = [{ id: "deadseat", pid: 999 }];
    expect(liveDuplicatesToSupersede(dups, alive)).not.toContain("deadseat");
  });
});

describe("Bug 6 — delivered-message TTL purge (bounds unbounded DB growth)", () => {
  // delivered=1 rows are only ever MARKED, never deleted, so they accumulate
  // forever (observed 2026-06-27: 5,180 delivered msgs, oldest 2026-04-07, ~9.2MB
  // of a 12MB db). The reaper now purges delivered mail older than
  // DELIVERED_MSG_TTL_MS on its 30s tick. Mirror of the prod DELETE (broker.ts is
  // not import-safe). Undelivered mail and recent delivered mail are untouched.
  let db: Database;
  const DELIVERED_MSG_TTL_MS = 7 * 24 * 3600_000; // 7d (mirror of broker default)

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, to_id TEXT, delivered INTEGER, delivered_at TEXT)");
  });

  // Mirror of the cleanStalePeers delivered-purge DELETE.
  function purgeDelivered(nowMs: number): number {
    const cutoffIso = new Date(nowMs - DELIVERED_MSG_TTL_MS).toISOString();
    return db.run("DELETE FROM messages WHERE delivered = 1 AND delivered_at IS NOT NULL AND delivered_at < ?", [cutoffIso]).changes;
  }

  test("an OLD delivered message (past TTL) is purged", () => {
    const old = new Date(Date.now() - 30 * 24 * 3600_000).toISOString(); // 30 days
    db.run("INSERT INTO messages (to_id, delivered, delivered_at) VALUES ('a', 1, ?)", [old]);
    expect(purgeDelivered(Date.now())).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
  });

  test("a RECENT delivered message (within TTL) is kept", () => {
    const recent = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    db.run("INSERT INTO messages (to_id, delivered, delivered_at) VALUES ('a', 1, ?)", [recent]);
    expect(purgeDelivered(Date.now())).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
  });

  test("UNDELIVERED mail is NEVER purged by this sweep (delivered=0), regardless of age", () => {
    // even an ancient undelivered row stays — it's a different sweep's concern.
    db.run("INSERT INTO messages (to_id, delivered, delivered_at) VALUES ('a', 0, NULL)");
    expect(purgeDelivered(Date.now())).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
  });

  test("PLANTED-WRONG guard: a delivered=0 row must survive (never purge undelivered)", () => {
    db.run("INSERT INTO messages (to_id, delivered, delivered_at) VALUES ('a', 0, NULL)");
    purgeDelivered(Date.now());
    expect((db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(1);
  });
});

describe("Bug 7 — undelivered-mail TTL for live-but-non-draining peers (receiver_mode='unknown')", () => {
  // A peer that heartbeats (row never goes stale) but never drains
  // (receiver_mode='unknown' — a send-only / misregistered client like a one-way
  // bridge) traps undelivered mail forever: the orphan sweep skips it (to_id is a
  // live row), the dead-seat TTL skips it (seat is alive), and the delivered TTL
  // skips it (delivered=0). The reaper now caps such mail by absolute age, GATED on
  // receiver_mode='unknown' so a real but idle Claude/Codex/Gemini peer is never
  // affected. Live proof 2026-06-28: pieces-bridge.linux trapped 7 broadcasts for
  // up to 7 days. Mirror of the prod DELETE (broker.ts is not import-safe).
  let db: Database;
  const UNDELIVERED_MSG_TTL_MS = 7 * 24 * 3600_000; // 7d (mirror of broker default)

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("CREATE TABLE peers (id TEXT PRIMARY KEY, receiver_mode TEXT NOT NULL DEFAULT 'unknown')");
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, to_id TEXT, delivered INTEGER, sent_at TEXT)");
  });

  // Mirror of the cleanStalePeers undelivered-mail-TTL DELETE.
  function purgeStaleUndelivered(nowMs: number): number {
    const cutoffIso = new Date(nowMs - UNDELIVERED_MSG_TTL_MS).toISOString();
    return db.run(
      `DELETE FROM messages WHERE delivered = 0 AND sent_at < ?
         AND to_id IN (SELECT id FROM peers WHERE receiver_mode = 'unknown')`,
      [cutoffIso],
    ).changes;
  }

  const OLD = new Date(Date.now() - 30 * 24 * 3600_000).toISOString(); // 30d
  const RECENT = new Date(Date.now() - 60_000).toISOString(); // 1 min

  test("HAPPY: old undelivered mail to an UNKNOWN-receiver peer is dropped", () => {
    db.run("INSERT INTO peers (id, receiver_mode) VALUES ('bridge', 'unknown')");
    db.run("INSERT INTO messages (to_id, delivered, sent_at) VALUES ('bridge', 0, ?)", [OLD]);
    expect(purgeStaleUndelivered(Date.now())).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
  });

  test("EDGE recent: a within-TTL undelivered row to an unknown peer is KEPT", () => {
    db.run("INSERT INTO peers (id, receiver_mode) VALUES ('bridge', 'unknown')");
    db.run("INSERT INTO messages (to_id, delivered, sent_at) VALUES ('bridge', 0, ?)", [RECENT]);
    expect(purgeStaleUndelivered(Date.now())).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
  });

  test("NON-LOSSY GATE: old undelivered mail to a REAL receiver (claude-channel) is KEPT", () => {
    // This is the load-bearing guard: a real but idle peer past the TTL must NOT
    // lose mail. Only no-receive-path (unknown) recipients are capped.
    db.run("INSERT INTO peers (id, receiver_mode) VALUES ('claude-x', 'claude-channel')");
    db.run("INSERT INTO messages (to_id, delivered, sent_at) VALUES ('claude-x', 0, ?)", [OLD]);
    expect(purgeStaleUndelivered(Date.now())).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
  });

  test("EDGE delivered: a delivered=1 row past the TTL is NOT this sweep's concern", () => {
    // The delivered-mail TTL (Bug 6) owns delivered=1; this sweep only touches delivered=0.
    db.run("INSERT INTO peers (id, receiver_mode) VALUES ('bridge', 'unknown')");
    db.run("INSERT INTO messages (to_id, delivered, sent_at) VALUES ('bridge', 1, ?)", [OLD]);
    expect(purgeStaleUndelivered(Date.now())).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
  });

  test("VoV (planted error): dropping the receiver_mode='unknown' gate would purge the real receiver's mail", () => {
    // Prove the gate is load-bearing: run the UNGATED variant and confirm it WOULD
    // delete the real-receiver row that the gated version keeps. If this expectation
    // ever flips, the non-lossy guarantee is broken.
    db.run("INSERT INTO peers (id, receiver_mode) VALUES ('claude-x', 'claude-channel')");
    db.run("INSERT INTO messages (to_id, delivered, sent_at) VALUES ('claude-x', 0, ?)", [OLD]);
    const cutoffIso = new Date(Date.now() - UNDELIVERED_MSG_TTL_MS).toISOString();
    const ungatedDeleted = db.run("DELETE FROM messages WHERE delivered = 0 AND sent_at < ?", [cutoffIso]).changes;
    expect(ungatedDeleted).toBe(1); // ungated WOULD drop the real receiver's mail — that's why the gate exists
  });
});
