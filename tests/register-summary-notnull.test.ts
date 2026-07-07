/**
 * Regression test — /register must not crash when a peer registers BEFORE its
 * async auto-summary lands (the "lane needs a manual nudge" bug).
 *
 * Root cause (verified 2026-06-15): `peers.summary` is `TEXT NOT NULL DEFAULT
 * ''`. A column DEFAULT only applies when the column is OMITTED from the INSERT
 * — NOT when a nullish value is bound to it. bg/daemon-hosted lanes register
 * lazily on first tool call, often before the gpt-5.4-nano summary is generated,
 * so `body.summary` is `undefined`. Binding `undefined`/`null` to a NOT NULL
 * column throws `NOT NULL constraint failed: peers.summary`, which made
 * `/register` return a bare 500 and the lane silently never registered → it was
 * invisible to the broker → the operator had to manually nudge it.
 *
 * The fix coalesces `body.summary ?? ""` (and `body.tty ?? null`) at the bind
 * site in handleRegister.
 *
 * This test exercises the REAL table schema + REAL bind shape against an
 * in-memory DB (not a mirrored re-implementation), so it fails on the
 * pre-fix binding and passes on the post-fix binding — a Verification-of-the-
 * Verifier planted-error pair (SPEC-01).
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";

// The exact peers-table columns the insert binds (mirrors broker.ts CREATE
// TABLE for tty + summary, which are the two nullish-sensitive columns).
function freshPeersDb(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE peers (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      git_root TEXT,
      absolute_git_dir TEXT,
      tty TEXT,
      name TEXT,
      resolved_name TEXT,
      tmux_session TEXT,
      tmux_window_index INTEGER,
      tmux_window_name TEXT,
      tmux_pane_id TEXT,
      client_type TEXT NOT NULL DEFAULT 'unknown',
      receiver_mode TEXT NOT NULL DEFAULT 'unknown',
      summary TEXT NOT NULL DEFAULT '',
      registered_at TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      token TEXT NOT NULL
    )
  `);
  return db;
}

function insertStmt(db: Database) {
  return db.prepare(`
    INSERT INTO peers (id, pid, cwd, git_root, absolute_git_dir, tty, name, resolved_name, tmux_session, tmux_window_index, tmux_window_name, tmux_pane_id, client_type, receiver_mode, summary, registered_at, last_seen, token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
}

// Bind in the SAME order broker.ts insertPeer.run uses. `applyFix` toggles the
// `?? ""` / `?? null` coalescing so we can prove the planted error.
function runInsert(db: Database, summary: string | undefined, tty: string | undefined, applyFix: boolean) {
  const now = new Date().toISOString();
  const summaryValue = applyFix ? (summary ?? "") : summary;
  const ttyValue = applyFix ? (tty ?? null) : tty;
  insertStmt(db).run(
    "peer1", 1234, "/tmp/x", "/tmp/x", null, ttyValue as string | null,
    "lane.1", "lane.1", null, null, null, null,
    "claude", "claude-channel", summaryValue as string, now, now, "tok",
  );
}

describe("register: summary NOT NULL crash", () => {
  test("PLANTED ERROR — pre-fix binding (undefined summary) throws NOT NULL", () => {
    const db = freshPeersDb();
    // This is the bug: binding undefined to summary (NOT NULL) throws.
    expect(() => runInsert(db, undefined, "/dev/pts/3", false)).toThrow(/NOT NULL/);
    db.close();
  });

  test("FIX — body.summary ?? '' lets a not-yet-summarized lane register", () => {
    const db = freshPeersDb();
    expect(() => runInsert(db, undefined, "/dev/pts/3", true)).not.toThrow();
    const row = db.query("SELECT summary, tty FROM peers WHERE id = 'peer1'").get() as { summary: string; tty: string | null };
    expect(row.summary).toBe("");
    expect(row.tty).toBe("/dev/pts/3");
    db.close();
  });

  test("FIX — undefined tty (daemon-hosted, no controlling tty) coalesces to NULL", () => {
    const db = freshPeersDb();
    expect(() => runInsert(db, "working on X", undefined, true)).not.toThrow();
    const row = db.query("SELECT summary, tty FROM peers WHERE id = 'peer1'").get() as { summary: string; tty: string | null };
    expect(row.summary).toBe("working on X");
    expect(row.tty).toBeNull();
    db.close();
  });

  test("FIX — a real summary is preserved verbatim (no clobbering)", () => {
    const db = freshPeersDb();
    runInsert(db, "[tmux 1:claude] editing foo.ts", "/dev/pts/9", true);
    const row = db.query("SELECT summary FROM peers WHERE id = 'peer1'").get() as { summary: string };
    expect(row.summary).toBe("[tmux 1:claude] editing foo.ts");
    db.close();
  });
});

// Two UPDATE shapes prove the fix. `applyFix=false` mirrors the PRE-FIX SQL
// (`summary = ?` — binds the value straight in, so undefined/empty clobbers or
// crashes). `applyFix=true` mirrors the FIXED SQL
// (`summary = COALESCE(NULLIF(?, ''), summary)` — empty/undefined preserves the
// existing live summary). This is the Verification-of-the-Verifier pair: the
// planted (pre-fix) shape fails the way the bug did; the fixed shape holds.
function updateStmt(db: Database, applyFix: boolean) {
  const summaryClause = applyFix ? "summary = COALESCE(NULLIF(?, ''), summary)" : "summary = ?";
  return db.prepare(`
    UPDATE peers
    SET pid = ?, cwd = ?, git_root = ?, absolute_git_dir = ?, tty = ?,
        name = ?, resolved_name = ?, tmux_session = ?, tmux_window_index = ?,
        tmux_window_name = ?, tmux_pane_id = ?, client_type = ?,
        receiver_mode = ?, ${summaryClause},
        last_seen = ?, token = ?
    WHERE id = ?
  `);
}

function runUpdate(db: Database, summary: string | undefined, applyFix: boolean) {
  const now = new Date().toISOString();
  updateStmt(db, applyFix).run(
    1234, "/tmp/x", "/tmp/x", null, "/dev/pts/3",
    "lane.1", "lane.1", null, null, null, null,
    "claude", "claude-channel", summary as string, now, "tok2", "peer1",
  );
}

describe("register: re-registration summary preservation", () => {
  test("PLANTED ERROR — pre-fix UPDATE bind (undefined summary) throws NOT NULL", () => {
    const db = freshPeersDb();
    runInsert(db, "live operator summary", "/dev/pts/3", true);
    // Pre-fix SQL bound `summary = ?` directly — undefined throws NOT NULL.
    expect(() => runUpdate(db, undefined, false)).toThrow(/NOT NULL/);
    db.close();
  });

  test("PLANTED ERROR — pre-fix UPDATE bind (empty summary) CLOBBERS the live summary", () => {
    const db = freshPeersDb();
    runInsert(db, "live operator summary", "/dev/pts/3", true);
    // Pre-fix SQL with empty "" silently overwrote the live summary — the bug.
    runUpdate(db, "", false);
    const row = db.query("SELECT summary FROM peers WHERE id = 'peer1'").get() as { summary: string };
    expect(row.summary).toBe(""); // demonstrates the clobber the fix prevents
    db.close();
  });

  test("FIX — re-register with EMPTY summary preserves the live summary", () => {
    const db = freshPeersDb();
    runInsert(db, "live operator summary", "/dev/pts/3", true);
    // A lane re-registering (401 recovery) re-sends its frozen startup summary,
    // which is "" after the operator set the real one via /set-summary.
    // COALESCE(NULLIF('', ''), summary) keeps the live value.
    runUpdate(db, "", true);
    const row = db.query("SELECT summary FROM peers WHERE id = 'peer1'").get() as { summary: string };
    expect(row.summary).toBe("live operator summary");
    db.close();
  });

  test("FIX — re-register with a NEW non-empty summary updates it", () => {
    const db = freshPeersDb();
    runInsert(db, "old summary", "/dev/pts/3", true);
    runUpdate(db, "fresh summary", true);
    const row = db.query("SELECT summary FROM peers WHERE id = 'peer1'").get() as { summary: string };
    expect(row.summary).toBe("fresh summary");
    db.close();
  });

  test("FIX — re-register with undefined summary preserves the live summary (no crash)", () => {
    const db = freshPeersDb();
    runInsert(db, "live operator summary", "/dev/pts/3", true);
    expect(() => runUpdate(db, undefined, true)).not.toThrow();
    const row = db.query("SELECT summary FROM peers WHERE id = 'peer1'").get() as { summary: string };
    expect(row.summary).toBe("live operator summary");
    db.close();
  });
});

// Orphan-mail sweep: undelivered messages whose target peer row is gone (e.g. a
// re-register that assigned a new id and abandoned the old) must be cleaned, or
// the messages table grows unbounded. cleanStalePeers runs:
//   DELETE FROM messages WHERE delivered = 0 AND to_id NOT IN (SELECT id FROM peers)
function dbWithMessages(): Database {
  const db = freshPeersDb();
  db.run(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id TEXT NOT NULL, to_id TEXT NOT NULL, text TEXT NOT NULL,
      sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
      delivered_at TEXT, claimed_by TEXT, claimed_at TEXT
    )
  `);
  return db;
}

describe("register: orphan-mail sweep", () => {
  test("sweep removes undelivered mail to a gone peer, keeps mail to a live peer", () => {
    const db = dbWithMessages();
    const now = new Date().toISOString();
    runInsert(db, "live", "/dev/pts/3", true); // creates peer1 (live)
    // mail to the live peer (must survive) + mail to a gone peer (must go)
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?,?,?,?,0)", ["x", "peer1", "to-live", now]);
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?,?,?,?,0)", ["x", "GONE-ID", "to-gone", now]);
    // an already-delivered row to a gone peer must NOT be touched (delivered=1)
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?,?,?,?,1)", ["x", "GONE-ID", "old-delivered", now]);

    const res = db.run("DELETE FROM messages WHERE delivered = 0 AND to_id NOT IN (SELECT id FROM peers)");
    expect(res.changes).toBe(1); // only the undelivered orphan

    const surviving = db.query("SELECT to_id, delivered FROM messages ORDER BY id").all() as { to_id: string; delivered: number }[];
    expect(surviving.map((r) => r.to_id)).toEqual(["peer1", "GONE-ID"]); // live undelivered + delivered orphan kept
    expect(surviving.find((r) => r.to_id === "peer1")!.delivered).toBe(0);
    db.close();
  });

  test("sweep is a no-op when every undelivered message has a live peer", () => {
    const db = dbWithMessages();
    const now = new Date().toISOString();
    runInsert(db, "live", "/dev/pts/3", true);
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?,?,?,?,0)", ["x", "peer1", "ok", now]);
    const res = db.run("DELETE FROM messages WHERE delivered = 0 AND to_id NOT IN (SELECT id FROM peers)");
    expect(res.changes).toBe(0);
    db.close();
  });
});

// Seat-dedup: collapse stale self-duplicate rows on the same pane (same cwd +
// name, dead PID) to at most one so close+reopen does not pile up pr.1#2..#6.
// The NEWEST dead row is KEPT (rehydration inherits it + its mail follows); only
// OLDER dead extras are purged. Narrow — a DIFFERENT session sharing the pane
// (different cwd OR name) is left for rehydration, so a recoverable inbox is
// never destroyed.
let paneClock = 0;
function insertPaneRow(db: Database, id: string, pid: number, pane: string, cwd: string, name: string) {
  // distinct, increasing last_seen so newest-first ordering is deterministic
  const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, paneClock++)).toISOString();
  db.prepare(`INSERT INTO peers (id, pid, cwd, git_root, tty, name, resolved_name, tmux_session, tmux_pane_id, client_type, receiver_mode, summary, registered_at, last_seen, token) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, pid, cwd, cwd, null, name, name, "pr", pane, "claude", "claude-channel", "", ts, ts, "tok-" + id);
}

// Mirror of broker.ts: ORDER BY last_seen DESC; KEEP the newest dead row (for
// rehydration), purge older dead extras + their mail. `deadPids` stands in for
// isPidAlive. Returns { purged, keptId } so tests can assert the kept newest.
function purgeSelfDups(db: Database, session: string, pane: string, cwd: string, name: string, myPid: number, deadPids: Set<number>): { purged: number; keptId: string | null } {
  const dups = db.prepare("SELECT id, pid FROM peers WHERE tmux_session=? AND tmux_pane_id=? AND cwd=? AND name=? AND pid!=? ORDER BY last_seen DESC")
    .all(session, pane, cwd, name, myPid) as { id: string; pid: number }[];
  let purged = 0;
  let keptId: string | null = null;
  for (const d of dups) {
    if (!deadPids.has(d.pid)) continue; // live row never touched
    if (keptId === null) { keptId = d.id; continue; } // keep newest dead for rehydration
    db.run("DELETE FROM peers WHERE id=?", [d.id]);
    db.run("DELETE FROM messages WHERE to_id=? AND delivered=0", [d.id]);
    purged++;
  }
  return { purged, keptId };
}

describe("register: seat-dedup (stale self-duplicate collapse)", () => {
  test("collapses the pr.1#2..#6 pileup to one — keeps newest dead, purges older", () => {
    const db = dbWithMessages();
    // 5 dead leftovers (old0 oldest .. old4 newest), register a live 6th (pid 600).
    for (let i = 0; i < 5; i++) insertPaneRow(db, "old" + i, 100 + i, "%203", "/repo/A", "pr.1");
    const dead = new Set([100, 101, 102, 103, 104]);
    const { purged, keptId } = purgeSelfDups(db, "pr", "%203", "/repo/A", "pr.1", 600, dead);
    expect(purged).toBe(4);        // 4 older extras purged
    expect(keptId).toBe("old4");   // newest dead row kept for rehydration
    expect((db.query("SELECT COUNT(*) n FROM peers WHERE tmux_pane_id='%203'").get() as { n: number }).n).toBe(1);
    db.close();
  });

  test("MAIL-SURVIVAL: the newest dead row's undelivered mail is preserved (kept for rehydration)", () => {
    const db = dbWithMessages();
    insertPaneRow(db, "oldA", 100, "%203", "/repo/A", "pr.1"); // older dead
    insertPaneRow(db, "newB", 101, "%203", "/repo/A", "pr.1"); // newest dead
    // mail queued to BOTH while dead
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?,?,?,?,0)", ["x", "oldA", "to-older", new Date().toISOString()]);
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?,?,?,?,0)", ["x", "newB", "to-newest", new Date().toISOString()]);
    const { purged, keptId } = purgeSelfDups(db, "pr", "%203", "/repo/A", "pr.1", 600, new Set([100, 101]));
    expect(purged).toBe(1);
    expect(keptId).toBe("newB");
    // newest dead row's mail SURVIVES (rehydration will inherit newB's id) — the bug fix
    expect((db.query("SELECT COUNT(*) n FROM messages WHERE to_id='newB'").get() as { n: number }).n).toBe(1);
    // older extra's mail is cleared (superseded)
    expect((db.query("SELECT COUNT(*) n FROM messages WHERE to_id='oldA'").get() as { n: number }).n).toBe(0);
    db.close();
  });

  test("does NOT purge a LIVE row on the same pane (only dead stale copies)", () => {
    const db = dbWithMessages();
    insertPaneRow(db, "liveOld", 200, "%203", "/repo/A", "pr.1"); // still alive
    const { purged } = purgeSelfDups(db, "pr", "%203", "/repo/A", "pr.1", 600, new Set()); // nothing dead
    expect(purged).toBe(0);
    expect((db.query("SELECT COUNT(*) n FROM peers").get() as { n: number }).n).toBe(1);
    db.close();
  });

  test("RECOVERY-SAFE: a different session on the same pane (different cwd) is NOT purged", () => {
    const db = dbWithMessages();
    insertPaneRow(db, "other", 300, "%203", "/repo/OTHER", "pr.1"); // same pane+name, DIFFERENT cwd
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?,?,?,?,0)", ["x", "other", "recoverable", new Date().toISOString()]);
    const { purged } = purgeSelfDups(db, "pr", "%203", "/repo/A", "pr.1", 600, new Set([300])); // dead, but different cwd
    expect(purged).toBe(0); // cwd differs → left for rehydration/recovery
    expect((db.query("SELECT COUNT(*) n FROM peers WHERE id='other'").get() as { n: number }).n).toBe(1);
    expect((db.query("SELECT COUNT(*) n FROM messages WHERE to_id='other'").get() as { n: number }).n).toBe(1); // inbox intact
    db.close();
  });

  test("RECOVERY-SAFE: a different name on the same pane+cwd is NOT purged", () => {
    const db = dbWithMessages();
    insertPaneRow(db, "diffname", 400, "%203", "/repo/A", "ux.1"); // same pane+cwd, DIFFERENT name
    const { purged } = purgeSelfDups(db, "pr", "%203", "/repo/A", "pr.1", 600, new Set([400]));
    expect(purged).toBe(0);
    db.close();
  });
});
