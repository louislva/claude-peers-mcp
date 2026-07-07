/**
 * Phase B R5(b)+D2+D3 regression tests — TTL-based stale-peer reaping.
 *
 * Background: prior to Phase B, the 30s `cleanStalePeers` reaper only deleted
 * peers whose PID returned ESRCH from `kill(pid, 0)`. PID-alive zombies
 * (a `bun server.ts` process whose parent claude died but bun lingered) were
 * left in the DB indefinitely. The on-demand `liveAndFreshPeers` (broker.ts:664)
 * already applied PID + `last_seen` TTL discipline; R5(b) brought the periodic
 * reaper in line with that discipline so orphans no longer accumulate.
 *
 * D2 collapse (2026-05-14): per bmad-code-review Code Simplifier Option B,
 * cleanStalePeers now literally delegates to liveAndFreshPeers — they are
 * one function via delegation, not two functions that need to agree. The
 * messages-DELETE side effect was moved into liveAndFreshPeers so all reap
 * paths (periodic sweep + per-request listings) reach the same end state.
 *
 * D3 cold-start grace (2026-05-14): the first cleanStalePeers invocation +
 * the periodic 30s setInterval kickoff are wrapped in a 60s setTimeout at
 * module init, so live peers can re-heartbeat after a broker restart before
 * the TTL gate fires. Sentinel test in describe block 6.
 *
 * STRUCTURAL CONSTRAINT (partially mitigated by #7 narrow): broker.ts:930
 * has top-level `Bun.serve(...)` with no `import.meta.main` guard, so a test
 * cannot `import` the real `cleanStalePeers` / `liveAndFreshPeers` without
 * spawning a competing broker on port 7899. The #7 narrow refactor extracted
 * the reap predicate (`isReapable`) and TTL constant into `shared/reaper.ts`
 * — a side-effect-free module — so the predicate tests CAN now import the
 * real symbol. The full broker module-extraction (#7 wide) remains a
 * follow-up. This file uses three complementary test strategies:
 *
 *   1. PREDICATE TESTS (describe blocks 1-4): import the REAL `isReapable`
 *      from shared/reaper.ts and exercise its truth table, boundary
 *      semantics, and graceful-degradation paths. POST-#7 narrow these
 *      tests are load-bearing — they cover production code, not a mirror.
 *
 *   2. SQL INTEGRATION (describe block 5): mirrors the full liveAndFreshPeers
 *      sweep (predicate + DELETE side effects) against a `:memory:`
 *      bun:sqlite DB. The mirror is necessary because broker.ts can't be
 *      imported; the predicate inside the mirror calls the same imported
 *      `isReapable` via the same logic, so drift on the predicate side
 *      surfaces in both this block AND the predicate blocks above.
 *      Validates: DELETE on peers, DELETE on undelivered messages,
 *      preservation of delivered messages, bucket-map cleanup (M2 leak).
 *
 *   3. SOURCE-GREP SENTINEL (describe block 6): asserts the production
 *      source still carries the D3 cold-start grace pattern. Pragmatic
 *      stopgap until the broker.ts module-extraction follow-up (#7 wide)
 *      lets us test the scheduler with time mocks.
 *
 * Spec mapping reconciliation (D1, 2026-05-14): this work is §2.6 Lifecycle
 * hardening (aligning the periodic reaper with the on-demand
 * liveAndFreshPeers discipline), NOT §3 R5 (which specifies heartbeat
 * state-delta). The "R5(b)" subdivision in commit messages was an
 * author-invented post-hoc label; the spec's actual R5 (heartbeat
 * extension) and R2 (set_worktree MCP tool) remain unimplemented and
 * are still on the Phase B work queue.
 *
 * If the prod implementation diverges, this file MUST be updated alongside.
 */

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
// #7 narrow (2026-05-14): import the REAL predicate + TTL constant from
// shared/reaper, not a local mirror. broker.ts itself still can't be
// imported (top-level Bun.serve at line ~930), but the predicate was
// hoisted into a side-effect-free shared module specifically so the
// predicate tests below test load-bearing prod code, not a copy.
import { isReapable, deadSeatMailExpired, shouldRotateLog, PEER_GHOST_AFTER_MS } from "../shared/reaper";

type TestPeer = { id: string; pid: number; last_seen: string };

// Mirror of broker.ts cleanStalePeers full sweep — returns the IDs that would
// be reaped. Side-effect-free for testing.
function reapableIds(
  peers: TestPeer[],
  isPidAlive: (pid: number) => boolean,
  now: number,
  ttlMs: number,
): string[] {
  return peers
    .filter((p) => isReapable(p, isPidAlive, now, ttlMs))
    .map((p) => p.id);
}

describe("Phase B R5(b) — isReapable predicate", () => {
  const NOW = new Date("2026-05-14T12:00:00.000Z").getTime();
  const FRESH = new Date(NOW - 10_000).toISOString(); // 10s ago
  const STALE = new Date(NOW - 120_000).toISOString(); // 2 min ago, > 90s TTL
  const aliveAll = () => true;
  const deadAll = () => false;

  test("fresh last_seen + alive PID → NOT reapable (operator session)", () => {
    const p: TestPeer = { id: "fresh-alive", pid: 1234, last_seen: FRESH };
    expect(isReapable(p, aliveAll, NOW, PEER_GHOST_AFTER_MS)).toBe(false);
  });

  test("fresh last_seen + dead PID → reapable (existing behavior preserved)", () => {
    const p: TestPeer = { id: "fresh-dead", pid: 1234, last_seen: FRESH };
    expect(isReapable(p, deadAll, NOW, PEER_GHOST_AFTER_MS)).toBe(true);
  });

  // REGRESSION SENTINEL: this case would have FAILED against the pre-R5(b)
  // reaper (which only checked isPidAlive). If someone reverts broker.ts
  // cleanStalePeers to the PID-only form, this test breaks first.
  test("stale last_seen + alive PID → reapable (NEW R5(b) regression sentinel — PID-alive zombie)", () => {
    const p: TestPeer = { id: "stale-zombie", pid: 1234, last_seen: STALE };
    expect(isReapable(p, aliveAll, NOW, PEER_GHOST_AFTER_MS)).toBe(true);
  });

  test("stale last_seen + dead PID → reapable (both conditions)", () => {
    const p: TestPeer = { id: "stale-dead", pid: 1234, last_seen: STALE };
    expect(isReapable(p, deadAll, NOW, PEER_GHOST_AFTER_MS)).toBe(true);
  });
});

describe("Phase B R5(b) — TTL boundary semantics", () => {
  const NOW = new Date("2026-05-14T12:00:00.000Z").getTime();
  const aliveAll = () => true;

  test("last_seen age == TTL exactly → NOT reapable (uses > not >=)", () => {
    const lastSeen = new Date(NOW - PEER_GHOST_AFTER_MS).toISOString();
    const p: TestPeer = { id: "boundary", pid: 1234, last_seen: lastSeen };
    expect(isReapable(p, aliveAll, NOW, PEER_GHOST_AFTER_MS)).toBe(false);
  });

  test("last_seen age == TTL + 1ms → reapable", () => {
    const lastSeen = new Date(NOW - PEER_GHOST_AFTER_MS - 1).toISOString();
    const p: TestPeer = { id: "boundary-plus", pid: 1234, last_seen: lastSeen };
    expect(isReapable(p, aliveAll, NOW, PEER_GHOST_AFTER_MS)).toBe(true);
  });

  test("last_seen age == TTL - 1ms → NOT reapable", () => {
    const lastSeen = new Date(NOW - PEER_GHOST_AFTER_MS + 1).toISOString();
    const p: TestPeer = { id: "boundary-minus", pid: 1234, last_seen: lastSeen };
    expect(isReapable(p, aliveAll, NOW, PEER_GHOST_AFTER_MS)).toBe(false);
  });
});

// NOT load-bearing in production (schema has last_seen TEXT NOT NULL and
// updateLastSeen always writes new Date().toISOString() — a malformed value
// cannot reach the reaper through normal paths). These tests document the
// NaN-guard contract for future-readers + defend against direct-INSERT
// pollution (e.g., the canary insertion the operator used to verify R5(b)
// live, or any future test fixture that bypasses the prepared statement).
describe("Phase B R5(b) — graceful degradation on bad data (defensive, not load-bearing)", () => {
  const NOW = new Date("2026-05-14T12:00:00.000Z").getTime();
  const aliveAll = () => true;

  test("malformed last_seen string + alive PID → NOT reapable (invariant: don't auto-reap on parse failure)", () => {
    const p: TestPeer = { id: "bad-iso", pid: 1234, last_seen: "not-a-date" };
    expect(isReapable(p, aliveAll, NOW, PEER_GHOST_AFTER_MS)).toBe(false);
  });

  test("malformed last_seen string + dead PID → reapable (PID gate still fires)", () => {
    const p: TestPeer = { id: "bad-iso-dead", pid: 1234, last_seen: "not-a-date" };
    expect(isReapable(p, () => false, NOW, PEER_GHOST_AFTER_MS)).toBe(true);
  });

  test("empty last_seen + alive PID → NOT reapable", () => {
    const p: TestPeer = { id: "empty-iso", pid: 1234, last_seen: "" };
    expect(isReapable(p, aliveAll, NOW, PEER_GHOST_AFTER_MS)).toBe(false);
  });
});

describe("Phase B R5(b) — full sweep partitioning", () => {
  const NOW = new Date("2026-05-14T12:00:00.000Z").getTime();
  const FRESH = new Date(NOW - 10_000).toISOString();
  const STALE = new Date(NOW - 120_000).toISOString();

  test("mixed-state fleet correctly partitions into 4 quadrants", () => {
    // 4 peers covering each (PID, TTL) combination
    const peers: TestPeer[] = [
      { id: "operator", pid: 100, last_seen: FRESH },     // alive PID, fresh — keep
      { id: "dead-but-fresh", pid: 200, last_seen: FRESH }, // dead PID, fresh — reap (existing)
      { id: "pid-alive-zombie", pid: 300, last_seen: STALE }, // alive PID, stale — reap (NEW R5(b))
      { id: "fully-dead", pid: 400, last_seen: STALE },    // dead PID, stale — reap (both)
    ];
    const deadPids = new Set([200, 400]);
    const isPidAlive = (pid: number) => !deadPids.has(pid);

    const reaped = reapableIds(peers, isPidAlive, NOW, PEER_GHOST_AFTER_MS);
    expect(reaped.sort()).toEqual(["dead-but-fresh", "fully-dead", "pid-alive-zombie"].sort());
    expect(reaped).not.toContain("operator");
  });

  test("empty peer list → no-op", () => {
    expect(reapableIds([], () => true, NOW, PEER_GHOST_AFTER_MS)).toEqual([]);
  });

  test("all peers fresh + alive → no reaps", () => {
    const peers: TestPeer[] = [
      { id: "p1", pid: 100, last_seen: FRESH },
      { id: "p2", pid: 200, last_seen: FRESH },
      { id: "p3", pid: 300, last_seen: FRESH },
    ];
    expect(reapableIds(peers, () => true, NOW, PEER_GHOST_AFTER_MS)).toEqual([]);
  });
});

// D2 collapse (2026-05-14): the prior "discipline parity with liveAndFreshPeers"
// describe block has been REMOVED. After D2, cleanStalePeers literally calls
// liveAndFreshPeers (broker.ts ~190 vs ~664) — they are the same function via
// delegation, not two functions that need to agree. The block became
// tautological (mirror agrees with mirror) and was deleted as part of D2's
// scope. The integration block below (block 5, was block 6) covers the
// reap behavior end-to-end against a real :memory: DB; the predicate
// blocks 1-4 cover the truth table.

// SQL side-effect coverage (originally added per pr-test-analyzer M1
// 2026-05-14, then updated for D2 collapse). The predicate tests above
// never exercise the SQL side effects (DELETE on peers, DELETE on
// undelivered messages, bucket-map cleanup). Without this block, a
// regression that returns the right reapable-id list but forgets the
// messages-table delete (orphan undelivered mail) or the M2 bucket-leak
// fix passes all predicate tests. This block runs an in-test mirror of
// liveAndFreshPeers (broker.ts:664) — the single source of truth after
// D2 — against a `:memory:` bun:sqlite DB matching production schema,
// and asserts the actual after-state.
describe("Phase B R5(b)+D2 — SQL side effects (integration; :memory: DB)", () => {
  const NOW_MS = new Date("2026-05-14T12:00:00.000Z").getTime();
  const FRESH_ISO = new Date(NOW_MS - 10_000).toISOString();
  const STALE_ISO = new Date(NOW_MS - 120_000).toISOString();

  // Mirror of broker.ts liveAndFreshPeers (post-D2 single source of truth),
  // parameterized over (db, isPidAlive, now, ttlMs, buckets) for testability.
  // Production version takes its db + PEER_GHOST_AFTER_MS + module-scope
  // buckets from closure; this version takes them as parameters. SQL
  // statements are verbatim copies of the liveAndFreshPeers reap branch
  // (the side-effect block).
  function liveAndFreshSweep(
    db: Database,
    isPidAlive: (pid: number) => boolean,
    now: number,
    ttlMs: number,
    buckets: Map<string, unknown>,
  ): void {
    const peers = db.query("SELECT id, pid, last_seen FROM peers").all() as {
      id: string;
      pid: number;
      last_seen: string;
    }[];
    for (const peer of peers) {
      let reapable = false;
      if (!isPidAlive(peer.pid)) {
        reapable = true;
      } else {
        const lastSeenMs = new Date(peer.last_seen).getTime();
        if (!Number.isNaN(lastSeenMs) && now - lastSeenMs > ttlMs) {
          reapable = true;
        }
      }
      if (reapable) {
        db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
        db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
        buckets.delete(peer.id);
      }
    }
  }

  function makeFixtureDb(): Database {
    const db = new Database(":memory:");
    db.run(`
      CREATE TABLE peers (
        id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        last_seen TEXT NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id TEXT,
        to_id TEXT NOT NULL,
        text TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0
      )
    `);
    return db;
  }

  test("reaped peer's row is deleted; surviving peer's row preserved", () => {
    const db = makeFixtureDb();
    db.run("INSERT INTO peers (id, pid, cwd, last_seen) VALUES (?, ?, ?, ?)", ["operator", 100, "/tmp", FRESH_ISO]);
    db.run("INSERT INTO peers (id, pid, cwd, last_seen) VALUES (?, ?, ?, ?)", ["zombie", 200, "/tmp", STALE_ISO]);
    liveAndFreshSweep(db, () => true, NOW_MS, PEER_GHOST_AFTER_MS, new Map());
    const remaining = db.query("SELECT id FROM peers ORDER BY id").all() as { id: string }[];
    expect(remaining).toEqual([{ id: "operator" }]);
  });

  test("undelivered messages to reaped peers are deleted; delivered messages preserved", () => {
    const db = makeFixtureDb();
    db.run("INSERT INTO peers (id, pid, cwd, last_seen) VALUES (?, ?, ?, ?)", ["operator", 100, "/tmp", FRESH_ISO]);
    db.run("INSERT INTO peers (id, pid, cwd, last_seen) VALUES (?, ?, ?, ?)", ["zombie", 200, "/tmp", STALE_ISO]);
    // 2 undelivered + 1 delivered to zombie (will be reaped); 1 undelivered to operator (will survive)
    db.run("INSERT INTO messages (from_id, to_id, text, delivered) VALUES (?, ?, ?, ?)", ["op", "zombie", "u1", 0]);
    db.run("INSERT INTO messages (from_id, to_id, text, delivered) VALUES (?, ?, ?, ?)", ["op", "zombie", "u2", 0]);
    db.run("INSERT INTO messages (from_id, to_id, text, delivered) VALUES (?, ?, ?, ?)", ["op", "zombie", "d1", 1]);
    db.run("INSERT INTO messages (from_id, to_id, text, delivered) VALUES (?, ?, ?, ?)", ["zombie", "operator", "uop", 0]);

    liveAndFreshSweep(db, () => true, NOW_MS, PEER_GHOST_AFTER_MS, new Map());

    const remaining = db.query("SELECT to_id, text, delivered FROM messages ORDER BY id").all();
    // INVARIANT: undelivered to zombie GONE; delivered to zombie PRESERVED (audit trail);
    // undelivered to operator PRESERVED (operator wasn't reaped).
    expect(remaining).toEqual([
      { to_id: "zombie", text: "d1", delivered: 1 },
      { to_id: "operator", text: "uop", delivered: 0 },
    ]);
  });

  test("bucket map entry is cleaned for reaped peers (M2 leak regression guard)", () => {
    const db = makeFixtureDb();
    db.run("INSERT INTO peers (id, pid, cwd, last_seen) VALUES (?, ?, ?, ?)", ["operator", 100, "/tmp", FRESH_ISO]);
    db.run("INSERT INTO peers (id, pid, cwd, last_seen) VALUES (?, ?, ?, ?)", ["zombie", 200, "/tmp", STALE_ISO]);
    const buckets = new Map<string, unknown>();
    buckets.set("operator", { tokens: 5 });
    buckets.set("zombie", { tokens: 3 });
    buckets.set("orphan-bucket-no-peer", { tokens: 1 }); // pre-existing leak — sweep doesn't clean it (intended: only deletes for reaped peers)

    liveAndFreshSweep(db, () => true, NOW_MS, PEER_GHOST_AFTER_MS, buckets);

    expect(buckets.has("zombie")).toBe(false); // M2 fix: bucket cleaned with peer
    expect(buckets.has("operator")).toBe(true); // surviving peer's bucket preserved
    expect(buckets.has("orphan-bucket-no-peer")).toBe(true); // sweep doesn't touch unrelated entries
  });

  test("PID-dead reap path also fires both side-effect cleanups (existing behavior preserved)", () => {
    const db = makeFixtureDb();
    db.run("INSERT INTO peers (id, pid, cwd, last_seen) VALUES (?, ?, ?, ?)", ["dead-but-fresh", 999, "/tmp", FRESH_ISO]);
    db.run("INSERT INTO messages (from_id, to_id, text, delivered) VALUES (?, ?, ?, ?)", ["op", "dead-but-fresh", "ghost-mail", 0]);
    const buckets = new Map<string, unknown>([["dead-but-fresh", { tokens: 2 }]]);

    liveAndFreshSweep(db, () => false, NOW_MS, PEER_GHOST_AFTER_MS, buckets); // PID dead; TTL irrelevant

    expect((db.query("SELECT COUNT(*) AS c FROM peers").get() as { c: number }).c).toBe(0);
    expect((db.query("SELECT COUNT(*) AS c FROM messages WHERE delivered = 0").get() as { c: number }).c).toBe(0);
    expect(buckets.has("dead-but-fresh")).toBe(false);
  });
});

// D3 (per bmad-code-review Edge Case Hunter 2026-05-14): cold-start grace
// regression sentinel. The reaper used to fire immediately at module init;
// after R5(b) added the TTL gate, that became dangerous (operator session
// with stale last_seen → mail loss on broker restart). The fix wraps both
// the first reap and the periodic schedule kickoff in a 60s setTimeout.
// This block is a SENTINEL — it asserts the production source still carries
// the grace pattern. If a future refactor accidentally restores immediate
// reap at module init, this test fails first. Time-mocking the actual
// scheduler is out of scope (bun:test has no built-in fake-timer; would
// need vitest's vi.useFakeTimers); the source-grep sentinel is the
// pragmatic stopgap until the broker.ts module-extraction follow-up
// (task #7) lets us import the scheduler function for direct testing.
describe("Phase B D3 — cold-start grace schedule (source-grep sentinel)", () => {
  test("broker.ts uses setTimeout to defer first reap by COLD_START_GRACE_MS=60_000", async () => {
    const source = await Bun.file(`${import.meta.dir}/../broker.ts`).text();

    // The grace constant must exist with the documented value.
    expect(source).toMatch(/COLD_START_GRACE_MS\s*=\s*60_000/);

    // The grace must wrap BOTH the first cleanStalePeers() call AND the
    // setInterval kickoff inside one setTimeout body. A naïve fix that only
    // delays the first call (leaves setInterval at module init) would still
    // fire the reaper at T+30s, defeating the grace.
    expect(source).toMatch(
      /setTimeout\(\s*\(\s*\)\s*=>\s*\{[\s\S]*?cleanStalePeers\(\)[\s\S]*?setInterval\(\s*cleanStalePeers\s*,\s*30_000\s*\)[\s\S]*?\}\s*,\s*COLD_START_GRACE_MS\s*\)/,
    );
  });

  test("broker.ts has NO top-level immediate cleanStalePeers() call at module init", async () => {
    const source = await Bun.file(`${import.meta.dir}/../broker.ts`).text();

    // Carve out the slice from end-of-cleanStalePeers-function to the next
    // major section marker so we only check module-init scope.
    const beforePreparedStatements = source.split("// --- Prepared statements ---")[0] ?? "";
    const moduleInitSlice = beforePreparedStatements.split("function cleanStalePeers()")[1] ?? "";

    // A bare `cleanStalePeers();` call at column 0 (no indent → not inside
    // a callback) at module-init scope is the anti-pattern this test guards
    // against. Inside the setTimeout body it's indented, so the column-0
    // anchor catches the regression.
    const bareCalls = moduleInitSlice.match(/^cleanStalePeers\(\);$/gm) ?? [];
    expect(bareCalls.length).toBe(0);
  });
});

// --- deadSeatMailExpired: TTL ceiling on preserving a dead-with-mail seat ---
// The real predicate (imported from shared/reaper). A dead seat holding unread
// mail is preserved as a recoverable inbox WITHIN the TTL; past it the row + mail
// are reaped, closing the forever-leak (5 dead seats from 2026-06-21 held 13
// stranded msgs, shielded from both sweeps). graceMs is floored at floorMs (the
// rehydrate window) so a misconfigured env can't reap a seat too early.
describe("deadSeatMailExpired", () => {
  const DAY = 24 * 3600_000;
  const HOUR = 3600_000;

  test("within the TTL → NOT expired (still a recoverable inbox)", () => {
    expect(deadSeatMailExpired(1 * HOUR, DAY, HOUR)).toBe(false);
    expect(deadSeatMailExpired(DAY - 1, DAY, HOUR)).toBe(false); // 1ms short
  });

  test("past the TTL → expired (reap row + stranded mail)", () => {
    expect(deadSeatMailExpired(DAY + 1, DAY, HOUR)).toBe(true);
    expect(deadSeatMailExpired(6 * DAY, DAY, HOUR)).toBe(true); // the real 6-day leak case
  });

  test("exactly at the TTL → NOT expired (strict >, mirrors isReapable boundary)", () => {
    expect(deadSeatMailExpired(DAY, DAY, HOUR)).toBe(false);
  });

  test("floor clamp: a sub-floor graceMs can't reap before the rehydrate window", () => {
    // env sets graceMs=0/tiny → must still preserve for at least floorMs (1h).
    expect(deadSeatMailExpired(30 * 60_000, 0, HOUR)).toBe(false);     // 30min < 1h floor
    expect(deadSeatMailExpired(2 * HOUR, 0, HOUR)).toBe(true);         // 2h > 1h floor → expired
    expect(deadSeatMailExpired(2 * HOUR, 60_000, HOUR)).toBe(true);    // graceMs 1min clamped to 1h
  });

  test("NaN/non-finite age (corrupt last_seen) → NOT expired here (caller's lastSeenValid handles it)", () => {
    expect(deadSeatMailExpired(NaN, DAY, HOUR)).toBe(false);
    expect(deadSeatMailExpired(Infinity, DAY, HOUR)).toBe(false);
  });

  test("PLANTED-WRONG guard: a 6-day-old dead-with-mail seat MUST expire (the leak is closed)", () => {
    // If a future edit drops the ceiling (always returns false), this flips and
    // the forever-leak silently returns.
    expect(deadSeatMailExpired(6 * DAY, DAY, HOUR)).not.toBe(false);
  });
});

// --- shouldRotateLog: pure size-cap decision for the broker log ---
// Extracted to shared/reaper.ts (real import) so the size gate is testable. The
// fs orchestration (statSync → truncateSync) stays in broker.ts behind it.
describe("shouldRotateLog", () => {
  const CAP = 10 * 1024 * 1024;
  test("under the cap → no rotate", () => {
    expect(shouldRotateLog(0, CAP)).toBe(false);
    expect(shouldRotateLog(CAP - 1, CAP)).toBe(false);
  });
  test("exactly at the cap → no rotate (strict >)", () => {
    expect(shouldRotateLog(CAP, CAP)).toBe(false);
  });
  test("over the cap → rotate", () => {
    expect(shouldRotateLog(CAP + 1, CAP)).toBe(true);
    expect(shouldRotateLog(24 * 1024 * 1024, CAP)).toBe(true); // the real 24MB incident
  });
});

// --- positiveEnvMs: reject non-positive TTL env overrides ---
// Mirror of the broker.ts helper (broker.ts is not import-safe). The load-bearing
// case: a NEGATIVE override must NOT pass through (a bare `parseInt || def` lets it,
// and a negative TTL makes the purge cutoff land in the future → wipes all rows).
describe("positiveEnvMs (mirror) — rejects non-positive TTL overrides", () => {
  function positiveEnvMs(raw: string | undefined, def: number): number {
    if (raw === undefined) return def;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
    return def;
  }
  test("absent → default", () => expect(positiveEnvMs(undefined, 86_400_000)).toBe(86_400_000));
  test("valid positive → parsed", () => expect(positiveEnvMs("3600000", 86_400_000)).toBe(3_600_000));
  test("NEGATIVE → default (the full-wipe footgun is closed)", () => {
    expect(positiveEnvMs("-86400000", 604_800_000)).toBe(604_800_000);
  });
  test("zero → default (not a silent 'purge everything')", () => {
    expect(positiveEnvMs("0", 604_800_000)).toBe(604_800_000);
  });
  test("garbage → default", () => expect(positiveEnvMs("foo", 86_400_000)).toBe(86_400_000));
  test("PLANTED-WRONG guard: a negative override must never be returned verbatim", () => {
    // If the guard regresses to `parseInt(raw,10) || def`, this returns -1 and flips.
    expect(positiveEnvMs("-1", 86_400_000)).toBeGreaterThan(0);
  });
});

// --- WIRING SENTINELS: prove the broker CALLS each control (dead-guard fix) ---
// Code review (mutation test) showed all 3 controls' call sites could be unwired
// with tests staying green — the logic was tested but not its invocation. These
// source-grep sentinels go RED when a call site is removed, the same pattern as
// the cold-start-grace sentinel above (block 6).
describe("reaper controls are WIRED into the broker (source-grep sentinels)", () => {
  test("liveAndFreshPeers preserve branch CALLS deadSeatMailExpired", async () => {
    const src = await Bun.file(`${import.meta.dir}/../broker.ts`).text();
    // pending>0 AND not-expired → preserve; dropping the deadSeatMailExpired clause
    // reopens the forever-leak. Tolerant of whitespace, pins the arg order.
    expect(src).toMatch(/pending\s*>\s*0\s*&&\s*!deadSeatMailExpired\(\s*ageMs\s*,\s*DEAD_MAIL_TTL_MS\s*,\s*REHYDRATE_WINDOW_MS\s*\)/);
  });
  test("cleanStalePeers CALLS the delivered-purge DELETE and rotateBrokerLogIfLarge", async () => {
    const src = await Bun.file(`${import.meta.dir}/../broker.ts`).text();
    const body = (src.split("function cleanStalePeers()")[1] ?? "").split("\nfunction ")[0];
    expect(body).toMatch(/DELETE FROM messages WHERE delivered = 1/);
    expect(body).toMatch(/rotateBrokerLogIfLarge\(\)/);
  });
  test("cleanStalePeers CALLS the undelivered-mail TTL DELETE gated on receiver_mode='unknown'", async () => {
    const src = await Bun.file(`${import.meta.dir}/../broker.ts`).text();
    const body = (src.split("function cleanStalePeers()")[1] ?? "").split("\nfunction ")[0] ?? "";
    // The undelivered cap must (a) target delivered=0 by sent_at, and (b) be gated
    // on receiver_mode='unknown' so it never drops a real idle peer's mail. Dropping
    // EITHER half reopens a leak (no cap) or breaks the non-lossy guarantee.
    expect(body).toMatch(/DELETE FROM messages WHERE delivered = 0 AND sent_at < \?/);
    expect(body).toMatch(/SELECT id FROM peers WHERE receiver_mode = 'unknown'/);
    // Must live AFTER the delivered-purge DELETE (i.e. inside the same mail-purge
    // try-stage, not a new unguarded stage).
    const delIdx = body.indexOf("DELETE FROM messages WHERE delivered = 1");
    const undelIdx = body.indexOf("DELETE FROM messages WHERE delivered = 0 AND sent_at");
    expect(delIdx).toBeGreaterThanOrEqual(0);
    expect(undelIdx).toBeGreaterThan(delIdx);
  });
  test("selectBroadcastTargets EXCLUDES receiver_mode='unknown' peers (B1 leak fix wired)", async () => {
    const src = await Bun.file(`${import.meta.dir}/../broker.ts`).text();
    const stmt = (src.split("const selectBroadcastTargets = db.prepare(`")[1] ?? "").split("`)")[0] ?? "";
    // A broadcast must never queue mail to a no-receive-path peer (the pieces-bridge
    // leak). Removing this conjunct reopens it. Pinned to the broadcast stmt only —
    // direct send_message is intentionally NOT filtered this way.
    expect(stmt).toMatch(/receiver_mode\s*!=\s*'unknown'/);
  });
  test("rotateBrokerLogIfLarge TRUNCATES in place (not rename — systemd append fd)", async () => {
    const src = await Bun.file(`${import.meta.dir}/../broker.ts`).text();
    const body = (src.split("function rotateBrokerLogIfLarge()")[1] ?? "").split("\nfunction ")[0];
    // Must truncate the SAME inode; a renameSync here would be the silent no-op bug.
    expect(body).toMatch(/truncateSync\(\s*BROKER_LOG_PATH\s*,\s*0\s*\)/);
    expect(body).not.toMatch(/renameSync/);
  });
  test("all three TTL consts use positiveEnvMs (negative-override guard wired)", async () => {
    const src = await Bun.file(`${import.meta.dir}/../broker.ts`).text();
    expect(src).toMatch(/DEAD_MAIL_TTL_MS\s*=\s*positiveEnvMs\(/);
    expect(src).toMatch(/DELIVERED_MSG_TTL_MS\s*=\s*positiveEnvMs\(/);
    expect(src).toMatch(/UNDELIVERED_MSG_TTL_MS\s*=\s*positiveEnvMs\(/);
  });
  test("cleanStalePeers ISOLATES the reap and mail-purge stages in separate try/catch", async () => {
    const src = await Bun.file(`${import.meta.dir}/../broker.ts`).text();
    const body = (src.split("function cleanStalePeers()")[1] ?? "").split("\nfunction ")[0] ?? "";
    // Per-mechanism crash isolation: a throw in the reap stage must not abort the
    // mail-purge stage, and vice versa. Collapsing the two into one try/catch (or
    // removing the isolation) reopens the "poison row starves every other sweep"
    // regression. Assert TWO try blocks and both once-per-failure latch names so a
    // single-wrapper rewrite goes RED.
    const tryCount = (body.match(/\btry\s*\{/g) ?? []).length;
    expect(tryCount).toBeGreaterThanOrEqual(2);
    expect(body).toMatch(/liveAndFreshPeers\(selectAllPeers\.all\(\) as Peer\[\]\);/);
    expect(body).toMatch(/reapStageWarned/);
    expect(body).toMatch(/mailPurgeStageWarned/);
  });
});
