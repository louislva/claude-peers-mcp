/**
 * Regression test for broker name de-duplication at /register and /set-name.
 *
 * Bug: child Claude processes inherit parent's CLAUDE_PEER_NAME, producing
 * duplicate-name peers (e.g. two "manzocontrol.3" rows when a parent Claude
 * spawns headless sub-Claudes). Broker now auto-suffixes "#2", "#3", … on
 * collision against LIVE peers (dead peers are not considered — the 30s
 * cleanStalePeers reaper handles those).
 *
 * Mirrors the inline-logic test pattern used in delivery.test.ts: copies the
 * disambiguateName implementation into the test against an in-memory DB. If
 * the prod implementation in broker.ts diverges from this copy, the test must
 * be updated alongside.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";

// Mirror of broker.ts disambiguateName(). Keep in sync.
function disambiguateName(
  db: Database,
  rawName: string | null,
  selfId: string,
  livePidCheck: (pid: number) => boolean,
  windowName?: string | null,
): string | null {
  if (!rawName) return null;
  const rows = db
    .query("SELECT pid, name, tmux_window_name AS win FROM peers WHERE name IS NOT NULL AND id != ?")
    .all(selfId) as { pid: number; name: string; win: string | null }[];
  const live = rows.filter((r) => livePidCheck(r.pid));
  const liveNames = new Set(live.map((r) => r.name));
  if (!liveNames.has(rawName)) return rawName;
  // Window-name disambiguator preferred over "#N" (see broker.ts for rationale):
  // self-documenting suffix so two live seats are tellable apart — BUT only when
  // the window actually distinguishes (no same-base seat already live in it).
  const win = windowName?.trim().replace(/[#\s]+/g, "-");
  const sameBaseInSameWindow = win
    ? live.some((r) => (r.name === rawName || (!rawName.includes("#") && r.name.startsWith(`${rawName}#`))) && (r.win?.trim().replace(/[#\s]+/g, "-")) === win)
    : false;
  if (win && !sameBaseInSameWindow) {
    const byWindow = `${rawName}#${win}`;
    if (!liveNames.has(byWindow)) return byWindow;
  }
  // Lane-ordinal allocation for "<lane>.<ordinal>" names (infra.1 -> infra.3),
  // mirroring broker.ts. Non-lane names keep the legacy "#N" walk.
  const laneMatch = rawName.match(/^(.*)\.(\d+)$/);
  if (laneMatch) {
    const base = laneMatch[1];
    let ord = Number(laneMatch[2]) + 1;
    while (liveNames.has(`${base}.${ord}`)) ord++;
    return `${base}.${ord}`;
  }
  let n = 2;
  while (liveNames.has(`${rawName}#${n}`)) n++;
  return `${rawName}#${n}`;
}

describe("broker name de-duplication", () => {
  let db: Database;
  // Test-controlled liveness oracle: any pid in this set is "alive".
  let alive: Set<number>;
  const isAlive = (pid: number) => alive.has(pid);

  beforeEach(() => {
    db = new Database(":memory:");
    db.run(
      "CREATE TABLE peers (id TEXT PRIMARY KEY, pid INTEGER NOT NULL, name TEXT, tmux_window_name TEXT)",
    );
    alive = new Set();
  });

  test("returns name unchanged when no collision", () => {
    db.run("INSERT INTO peers (id, pid, name) VALUES ('a', 100, 'alpha')");
    alive.add(100);
    expect(disambiguateName(db, "beta", "self", isAlive)).toBe("beta");
  });

  test("lane.ordinal name allocates next free ordinal, not #N (manzocontrol.3 -> manzocontrol.4)", () => {
    // Regression for the seat-collision bug: a "<lane>.<ordinal>" name that
    // collides must become a real routable lane seat (next free ordinal), NOT
    // an ambiguous "manzocontrol.3#2" that re-collides with find_peer.
    db.run("INSERT INTO peers (id, pid, name) VALUES ('a', 100, 'manzocontrol.3')");
    alive.add(100);
    expect(disambiguateName(db, "manzocontrol.3", "self", isAlive)).toBe(
      "manzocontrol.4",
    );
  });

  test("lane-ordinal walk skips occupied ordinals (infra.1 with infra.2,3 live -> infra.4)", () => {
    // The exact live-repro shape: infra.1 collides while infra.2 and infra.3 are
    // also live in the same window -> must land on infra.4, never infra.1#2.
    db.run("INSERT INTO peers (id, pid, name) VALUES ('a', 100, 'infra.1')");
    db.run("INSERT INTO peers (id, pid, name) VALUES ('b', 101, 'infra.2')");
    db.run("INSERT INTO peers (id, pid, name) VALUES ('c', 102, 'infra.3')");
    alive.add(100); alive.add(101); alive.add(102);
    const got = disambiguateName(db, "infra.1", "self", isAlive);
    expect(got).toBe("infra.4");
    expect(got).not.toContain("#"); // never the opaque #N suffix
  });

  test("non-lane names (no .ordinal) keep the legacy #N walk", () => {
    // 'obs' has no "<lane>.<ordinal>" shape, so the lane-ordinal branch must NOT
    // fire — it falls through to #N. Guards against the regex over-matching.
    db.run("INSERT INTO peers (id, pid, name) VALUES ('a', 100, 'obs')");
    alive.add(100);
    expect(disambiguateName(db, "obs", "self", isAlive)).toBe("obs#2");
  });

  test("multi-dot lane name: greedy regex treats trailing .N as the ordinal (a.b.1 -> a.b.2)", () => {
    // Locks the GREEDY-regex contract /^(.*)\.(\d+)$/: base='a.b', ord=1 -> 'a.b.2'.
    // Without this, a future change to a lazy group (.*?) would silently re-home
    // 'a.b.1' to 'a.2' and no other test would catch it.
    db.run("INSERT INTO peers (id, pid, name) VALUES ('a', 100, 'proj.v1.2')");
    alive.add(100);
    const got = disambiguateName(db, "proj.v1.2", "self", isAlive);
    expect(got).toBe("proj.v1.3");
    expect(got!.startsWith("proj.v1.")).toBe(true); // dotted prefix preserved as the lane base
  });

  test("walks to #3, #4, … when lower suffixes are already live", () => {
    db.run("INSERT INTO peers (id, pid, name) VALUES ('a', 100, 'obs')");
    db.run("INSERT INTO peers (id, pid, name) VALUES ('b', 101, 'obs#2')");
    db.run("INSERT INTO peers (id, pid, name) VALUES ('c', 102, 'obs#3')");
    alive.add(100); alive.add(101); alive.add(102);
    expect(disambiguateName(db, "obs", "self", isAlive)).toBe("obs#4");
  });

  test("ignores dead peers — 30s reaper hasn't fired yet", () => {
    db.run("INSERT INTO peers (id, pid, name) VALUES ('a', 999, 'ghost')");
    // pid 999 NOT added to `alive` → dead, claim is invalid
    expect(disambiguateName(db, "ghost", "self", isAlive)).toBe("ghost");
  });

  test("excludes self-id (re-register keeps original name)", () => {
    db.run("INSERT INTO peers (id, pid, name) VALUES ('self', 100, 'manzocontrol.3')");
    alive.add(100);
    // Same peer re-registering — should keep its name, not become #2.
    expect(disambiguateName(db, "manzocontrol.3", "self", isAlive)).toBe(
      "manzocontrol.3",
    );
  });

  test("null name passes through (anonymous peers are allowed)", () => {
    expect(disambiguateName(db, null, "self", isAlive)).toBeNull();
  });

  test("fills the first free gap, not always the highest+1", () => {
    // obs and obs#3 are live; obs#2 is dead. New registrant should get #2.
    db.run("INSERT INTO peers (id, pid, name) VALUES ('a', 100, 'obs')");
    db.run("INSERT INTO peers (id, pid, name) VALUES ('b', 101, 'obs#2')"); // dead
    db.run("INSERT INTO peers (id, pid, name) VALUES ('c', 102, 'obs#3')");
    alive.add(100); alive.add(102); // 101 NOT alive
    expect(disambiguateName(db, "obs", "self", isAlive)).toBe("obs#2");
  });

  test("walks past live higher suffixes — true gap-skip case", () => {
    // obs alive, obs#2 alive, obs#3 dead, obs#4 alive → expect obs#3.
    // Without this, the prior gap-fill test passes trivially because obs#2
    // being dead means n=2 returns immediately on first check. This case
    // forces the while-loop to actually iterate past a live entry to find
    // the dead slot — guards against `while (rows.find(...))`-style bugs.
    db.run("INSERT INTO peers (id, pid, name) VALUES ('a', 100, 'obs')");
    db.run("INSERT INTO peers (id, pid, name) VALUES ('b', 101, 'obs#2')");
    db.run("INSERT INTO peers (id, pid, name) VALUES ('c', 102, 'obs#3')"); // dead
    db.run("INSERT INTO peers (id, pid, name) VALUES ('d', 103, 'obs#4')");
    alive.add(100); alive.add(101); alive.add(103); // 102 NOT alive
    expect(disambiguateName(db, "obs", "self", isAlive)).toBe("obs#3");
  });

  test("empty-string maps to null (matches handleSetName contract)", () => {
    expect(disambiguateName(db, "", "self", isAlive)).toBeNull();
  });

  test("already-suffixed input gets nested suffix on collision", () => {
    // Locks the contract: if a peer requests "obs#2" and that name is live,
    // they get "obs#2#2" — broker does NOT parse + increment existing suffix.
    // Slightly ugly but predictable; future "be smart" refactor must update
    // this test deliberately.
    db.run("INSERT INTO peers (id, pid, name) VALUES ('a', 100, 'obs#2')");
    alive.add(100);
    expect(disambiguateName(db, "obs#2", "self", isAlive)).toBe("obs#2#2");
  });

  test("SQL-special chars in name round-trip safely", () => {
    // Names with `'`, `%`, `_` work because the query is parameterized;
    // assert no LIKE-glob misbehavior or injection.
    db.run("INSERT INTO peers (id, pid, name) VALUES ('a', 100, ?)", [
      "weird'name%_",
    ]);
    alive.add(100);
    expect(disambiguateName(db, "weird'name%_", "self", isAlive)).toBe(
      "weird'name%_#2",
    );
    expect(disambiguateName(db, "different'name", "self", isAlive)).toBe(
      "different'name",
    );
  });

  // --- window-name disambiguator (replaces meaningless #N when it actually helps) ---

  test("collision, DIFFERENT window → suffixes the window, not #2", () => {
    // holder is in window 'lane-seo'; registrant is in 'orchA' → window distinguishes.
    db.run("INSERT INTO peers (id, pid, name, tmux_window_name) VALUES ('a', 100, 'coding.1', 'lane-seo')");
    alive.add(100);
    expect(disambiguateName(db, "coding.1", "self", isAlive, "orchA")).toBe("coding.1#orchA");
  });

  test("collision, SAME window → window doesn't help, falls back to next lane ordinal", () => {
    // both seats in window 'orchA' → "#orchA" tells them apart no better than "#N",
    // so it falls through to the numeric tail. For a "<lane>.<ordinal>" name that
    // tail now allocates the next free ordinal (coding.1 -> coding.2), not "#2".
    db.run("INSERT INTO peers (id, pid, name, tmux_window_name) VALUES ('a', 100, 'coding.1', 'orchA')");
    alive.add(100);
    expect(disambiguateName(db, "coding.1", "self", isAlive, "orchA")).toBe("coding.2");
  });

  test("collision WITHOUT a window name → falls back to next lane ordinal", () => {
    db.run("INSERT INTO peers (id, pid, name, tmux_window_name) VALUES ('a', 100, 'coding.1', 'lane-seo')");
    alive.add(100);
    expect(disambiguateName(db, "coding.1", "self", isAlive, null)).toBe("coding.2");
    expect(disambiguateName(db, "coding.1", "self", isAlive, undefined)).toBe("coding.2");
  });

  test("no collision → window name is NOT appended (bare name kept)", () => {
    db.run("INSERT INTO peers (id, pid, name, tmux_window_name) VALUES ('a', 100, 'other', 'orchA')");
    alive.add(100);
    expect(disambiguateName(db, "coding.1", "self", isAlive, "orchA")).toBe("coding.1");
  });

  test("window name with whitespace / '#' is sanitized to hyphens", () => {
    db.run("INSERT INTO peers (id, pid, name, tmux_window_name) VALUES ('a', 100, 'coding.1', 'orchA')");
    alive.add(100);
    expect(disambiguateName(db, "coding.1", "self", isAlive, "lane seo#x")).toBe("coding.1#lane-seo-x");
  });

  test("empty/whitespace-only window name → treated as absent, falls back to next lane ordinal", () => {
    db.run("INSERT INTO peers (id, pid, name, tmux_window_name) VALUES ('a', 100, 'coding.1', 'orchA')");
    alive.add(100);
    expect(disambiguateName(db, "coding.1", "self", isAlive, "   ")).toBe("coding.2");
  });

  test("real process.kill liveness — current pid alive, max int dead", () => {
    // Bridges the test/prod liveness divergence. Test-controlled `alive`
    // Set is the project pattern, but at least one assertion should use the
    // real prod check shape so a refactor of process.kill semantics doesn't
    // silently desync from the test mock.
    const realIsAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        const code = (e as { code?: string } | undefined)?.code;
        return code === "EPERM";
      }
    };
    db.run("INSERT INTO peers (id, pid, name) VALUES ('a', ?, 'self-pid')", [
      process.pid,
    ]);
    db.run("INSERT INTO peers (id, pid, name) VALUES ('b', 2147483646, 'ghost-pid')");
    expect(disambiguateName(db, "self-pid", "self", realIsAlive)).toBe(
      "self-pid#2",
    );
    expect(disambiguateName(db, "ghost-pid", "self", realIsAlive)).toBe(
      "ghost-pid",
    );
  });
});
