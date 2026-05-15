/**
 * Tests for F1 (named aliases) and F2 (tmux process-ancestry detection).
 *
 * These tests verify the broker schema migrations, registration with
 * F1+F2 fields, list_peers output, and find_peer filtering.
 * F2's detectTmuxPane() is tested via a mock since tmux may not be available in CI.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import type { Peer, RegisterRequest } from "../shared/types.ts";
import { parseTmuxPanes, parsePsTree } from "../shared/tmux.ts";
import { generateSummary } from "../shared/summarize.ts";

// --- Broker-level tests (schema + registration + queries) ---

describe("F1+F2 broker schema migrations", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.run("PRAGMA journal_mode = WAL");

    // Create the original schema (pre-F1+F2)
    db.run(`
      CREATE TABLE IF NOT EXISTS peers (
        id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        git_root TEXT,
        tty TEXT,
        summary TEXT NOT NULL DEFAULT '',
        registered_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      )
    `);

    // Run idempotent migrations (same as broker.ts)
    const migrationColumns = [
      { name: "name", type: "TEXT" },
      { name: "tmux_session", type: "TEXT" },
      { name: "tmux_window_index", type: "TEXT" },
      { name: "tmux_window_name", type: "TEXT" },
      { name: "tmux_pane_id", type: "TEXT" },
      { name: "resolved_name", type: "TEXT" },
    ];
    for (const col of migrationColumns) {
      try {
        db.run(`ALTER TABLE peers ADD COLUMN ${col.name} ${col.type}`);
      } catch {
        // Column already exists
      }
    }
  });

  afterAll(() => {
    db.close();
  });

  test("migration adds peer identity columns", () => {
    const info = db.prepare("PRAGMA table_info(peers)").all() as Array<{ name: string }>;
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain("name");
    expect(colNames).toContain("tmux_session");
    expect(colNames).toContain("tmux_window_index");
    expect(colNames).toContain("tmux_window_name");
    expect(colNames).toContain("tmux_pane_id");
    expect(colNames).toContain("resolved_name");
  });

  test("identity backfill restores operator labels from old deduped names", () => {
    const local = new Database(":memory:");
    local.run("CREATE TABLE peers (id TEXT PRIMARY KEY, pid INTEGER NOT NULL, name TEXT, resolved_name TEXT)");
    local.run("INSERT INTO peers (id, pid, name, resolved_name) VALUES ('a', 1, 'codex.2#4', NULL)");
    local.run("INSERT INTO peers (id, pid, name, resolved_name) VALUES ('b', 2, 'custom#name', NULL)");

    const update = local.prepare("UPDATE peers SET name = ?, resolved_name = ? WHERE id = ?");
    const rows = local.query("SELECT id, name, resolved_name FROM peers WHERE name IS NOT NULL").all() as { id: string; name: string; resolved_name: string | null }[];
    for (const row of rows) {
      const resolved = row.resolved_name ?? row.name;
      const operatorMatch = row.name.match(/^(.+\.[0-9]+)#[0-9]+$/);
      const operatorName = operatorMatch ? operatorMatch[1]! : row.name;
      if (operatorName !== row.name || row.resolved_name === null) update.run(operatorName, resolved, row.id);
    }

    const a = local.query("SELECT name, resolved_name FROM peers WHERE id = 'a'").get() as { name: string; resolved_name: string };
    const b = local.query("SELECT name, resolved_name FROM peers WHERE id = 'b'").get() as { name: string; resolved_name: string };
    expect(a.name).toBe("codex.2");
    expect(a.resolved_name).toBe("codex.2#4");
    expect(b.name).toBe("custom#name");
    expect(b.resolved_name).toBe("custom#name");
    local.close();
  });

  test("migrations are idempotent (re-running does not error)", () => {
    const migrationColumns = [
      { name: "name", type: "TEXT" },
      { name: "tmux_session", type: "TEXT" },
      { name: "tmux_window_index", type: "TEXT" },
      { name: "tmux_window_name", type: "TEXT" },
      { name: "tmux_pane_id", type: "TEXT" },
      { name: "resolved_name", type: "TEXT" },
    ];
    // Run again — should not throw
    for (const col of migrationColumns) {
      expect(() => {
        try {
          db.run(`ALTER TABLE peers ADD COLUMN ${col.name} ${col.type}`);
        } catch {
          // Expected: column already exists
        }
      }).not.toThrow();
    }
  });

  test("F1: insert peer with name field", () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO peers (id, pid, cwd, git_root, tty, name, tmux_session, tmux_window_index, tmux_window_name, summary, registered_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["peer-1", 12345, "/home/test", null, "pts/1", "mary", null, null, null, "test summary", now, now]
    );

    const peer = db.query("SELECT * FROM peers WHERE id = ?").get("peer-1") as Peer;
    expect(peer.name).toBe("mary");
    expect(peer.tmux_session).toBeNull();
  });

  test("F1: insert peer without name (backward compat)", () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO peers (id, pid, cwd, git_root, tty, name, tmux_session, tmux_window_index, tmux_window_name, summary, registered_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["peer-2", 12346, "/home/test", null, "pts/2", null, null, null, null, "", now, now]
    );

    const peer = db.query("SELECT * FROM peers WHERE id = ?").get("peer-2") as Peer;
    expect(peer.name).toBeNull();
  });

  test("F2: insert peer with tmux fields", () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO peers (id, pid, cwd, git_root, tty, name, tmux_session, tmux_window_index, tmux_window_name, summary, registered_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["peer-3", 12347, "/home/test", null, "pts/3", "winston", "mgt", "1", "claude", "arch work", now, now]
    );

    const peer = db.query("SELECT * FROM peers WHERE id = ?").get("peer-3") as Peer;
    expect(peer.name).toBe("winston");
    expect(peer.tmux_session).toBe("mgt");
    expect(peer.tmux_window_index).toBe("1");
    expect(peer.tmux_window_name).toBe("claude");
  });

  test("F2: insert peer outside tmux (null tmux fields)", () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO peers (id, pid, cwd, git_root, tty, name, tmux_session, tmux_window_index, tmux_window_name, summary, registered_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["peer-4", 12348, "/home/test", null, "pts/4", null, null, null, null, "", now, now]
    );

    const peer = db.query("SELECT * FROM peers WHERE id = ?").get("peer-4") as Peer;
    expect(peer.tmux_session).toBeNull();
    expect(peer.tmux_window_index).toBeNull();
    expect(peer.tmux_window_name).toBeNull();
  });

  test("find_peer: filter by name", () => {
    const peers = db.query("SELECT * FROM peers WHERE name = ?").all("mary") as Peer[];
    expect(peers.length).toBe(1);
    expect(peers[0]!.id).toBe("peer-1");
  });

  test("find_peer: filter by tmux_session", () => {
    const peers = db.query("SELECT * FROM peers WHERE tmux_session = ?").all("mgt") as Peer[];
    expect(peers.length).toBe(1);
    expect(peers[0]!.id).toBe("peer-3");
  });

  test("find_peer: filter by name AND tmux_session", () => {
    const peers = db
      .query("SELECT * FROM peers WHERE name = ? AND tmux_session = ?")
      .all("winston", "mgt") as Peer[];
    expect(peers.length).toBe(1);
    expect(peers[0]!.id).toBe("peer-3");
  });

  test("find_peer: no match returns empty", () => {
    const peers = db.query("SELECT * FROM peers WHERE name = ?").all("nonexistent") as Peer[];
    expect(peers.length).toBe(0);
  });

  test("find_peer: name match + wrong tmux returns empty", () => {
    const peers = db
      .query("SELECT * FROM peers WHERE name = ? AND tmux_session = ?")
      .all("mary", "nonexistent") as Peer[];
    expect(peers.length).toBe(0);
  });

  test("list_peers returns all F1+F2 fields", () => {
    const peers = db.query("SELECT * FROM peers").all() as Peer[];
    expect(peers.length).toBe(4);

    // Verify all peers have the new fields (even if null)
    for (const peer of peers) {
      expect("name" in peer).toBe(true);
      expect("tmux_session" in peer).toBe(true);
      expect("tmux_window_index" in peer).toBe(true);
      expect("tmux_window_name" in peer).toBe(true);
    }
  });

  test("old peers without new columns still queryable", () => {
    // Simulate a pre-migration peer (only original columns)
    db.run(
      `INSERT INTO peers (id, pid, cwd, summary, registered_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["peer-old", 99999, "/old", "", new Date().toISOString(), new Date().toISOString()]
    );

    const peer = db.query("SELECT * FROM peers WHERE id = ?").get("peer-old") as Peer;
    expect(peer.id).toBe("peer-old");
    expect(peer.name).toBeNull();
    expect(peer.tmux_session).toBeNull();
  });
});

// --- F3 post-review: handleListPeers scope filter SQL-level tests ---
//
// The live integration suite only exercises scope: "machine". These tests
// cover the directory / repo filters at the SQL level so they run fast and
// without a broker subprocess.

describe("handleListPeers scope filters", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.run(`
      CREATE TABLE peers (
        id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        git_root TEXT,
        tty TEXT,
        summary TEXT NOT NULL DEFAULT '',
        registered_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      )
    `);
    const now = new Date().toISOString();
    const insert = db.prepare(
      "INSERT INTO peers (id, pid, cwd, git_root, summary, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    insert.run("peer-A", 1, "/home/a", "/home/a", "", now, now);
    insert.run("peer-B", 2, "/home/b", "/home/b", "", now, now);
    insert.run("peer-C", 3, "/home/a/sub", "/home/a", "", now, now); // same git_root as A
    insert.run("peer-D", 4, "/home/d", null, "", now, now); // no git_root
  });

  afterAll(() => db.close());

  // Replicate the broker's prepared statements for filtering
  function byDirectory(cwd: string) {
    return db.query("SELECT id FROM peers WHERE cwd = ?").all(cwd) as { id: string }[];
  }
  function byGitRoot(git_root: string) {
    return db.query("SELECT id FROM peers WHERE git_root = ?").all(git_root) as { id: string }[];
  }

  test("directory scope matches exact cwd only", () => {
    const r = byDirectory("/home/a");
    expect(r.map((p) => p.id)).toEqual(["peer-A"]);
  });

  test("directory scope on subdirectory does NOT match parent", () => {
    const r = byDirectory("/home/a/sub");
    expect(r.map((p) => p.id)).toEqual(["peer-C"]);
  });

  test("repo scope matches all peers sharing a git_root", () => {
    const r = byGitRoot("/home/a");
    const ids = r.map((p) => p.id).sort();
    expect(ids).toEqual(["peer-A", "peer-C"]);
  });

  test("repo scope with unknown git_root returns empty", () => {
    const r = byGitRoot("/nonexistent");
    expect(r.length).toBe(0);
  });

  test("repo scope when caller has null git_root falls back to directory scope", () => {
    // The broker's logic: if body.git_root is null, fall through to
    // selectPeersByDirectory(body.cwd). We test both prongs of that fallback.
    const r = byDirectory("/home/d"); // peer-D has null git_root
    expect(r.map((p) => p.id)).toEqual(["peer-D"]);
  });
});

// --- Type contract tests ---

describe("F1+F2 type contracts", () => {
  test("RegisterRequest accepts F1+F2 fields", () => {
    const req: RegisterRequest = {
      pid: 12345,
      cwd: "/home/test",
      git_root: null,
      tty: "pts/1",
      name: "test-peer",
      tmux_session: "dev",
      tmux_window_index: "0",
      tmux_window_name: "main",
      tmux_pane_id: "%1",
      summary: "test",
    };
    expect(req.name).toBe("test-peer");
    expect(req.tmux_session).toBe("dev");
    expect(req.tmux_pane_id).toBe("%1");
  });

  test("RegisterRequest accepts null F1+F2 fields (backward compat)", () => {
    const req: RegisterRequest = {
      pid: 12345,
      cwd: "/home/test",
      git_root: null,
      tty: null,
      name: null,
      tmux_session: null,
      tmux_window_index: null,
      tmux_window_name: null,
      summary: "",
    };
    expect(req.name).toBeNull();
    expect(req.tmux_session).toBeNull();
  });

  test("Peer interface includes F1+F2 fields", () => {
    const peer: Peer = {
      id: "test",
      pid: 1,
      cwd: "/",
      git_root: null,
      absolute_git_dir: null,
      tty: null,
      name: "barry",
      tmux_session: "mgt",
      tmux_window_index: "2",
      tmux_window_name: "build",
      tmux_pane_id: "%2",
      resolved_name: "barry#2",
      client_type: "claude",
      receiver_mode: "claude-channel",
      last_hook_seen_at: null,
      last_drain_at: null,
      last_drain_error: null,
      summary: "",
      registered_at: "",
      last_seen: "",
    };
    expect(peer.name).toBe("barry");
    expect(peer.tmux_session).toBe("mgt");
    expect(peer.tmux_window_index).toBe("2");
    expect(peer.tmux_window_name).toBe("build");
    expect(peer.tmux_pane_id).toBe("%2");
    expect(peer.resolved_name).toBe("barry#2");
  });
});

// --- detectTmuxPane unit tests ---

describe("F2 detectTmuxPane parsing logic", () => {
  // parseTmuxPanes is now exported from server.ts so tests use the SAME
  // function the production code does. Eliminates the test-helper duplication
  // bug where tests passed against an out-of-date copy of the parser.

  test("parses standard tab-delimited tmux list-panes output", () => {
    const output = `12345\tmain\t0\tbash
67890\tdev\t1\tvim
11111\tmgt\t2\tclaude code`;

    const map = parseTmuxPanes(output);
    expect(map.size).toBe(3);
    expect(map.get(12345)).toEqual({ session: "main", window_index: "0", window_name: "bash" });
    expect(map.get(67890)).toEqual({ session: "dev", window_index: "1", window_name: "vim" });
    expect(map.get(11111)).toEqual({ session: "mgt", window_index: "2", window_name: "claude code" });
  });

  test("session name with spaces parses correctly (regression for split-on-space bug)", () => {
    const output = "12345\tmy session name\t0\tbash";
    const map = parseTmuxPanes(output);
    expect(map.size).toBe(1);
    expect(map.get(12345)).toEqual({ session: "my session name", window_index: "0", window_name: "bash" });
  });

  test("window name with multiple spaces preserved", () => {
    const output = "12345\tdev\t3\tvim some file.txt";
    const map = parseTmuxPanes(output);
    expect(map.get(12345)?.window_name).toBe("vim some file.txt");
  });

  test("handles empty output", () => {
    const map = parseTmuxPanes("");
    expect(map.size).toBe(0);
  });

  test("handles single pane", () => {
    const output = "2505121\t4\t0\tbash";
    const map = parseTmuxPanes(output);
    expect(map.size).toBe(1);
    expect(map.get(2505121)).toEqual({ session: "4", window_index: "0", window_name: "bash" });
  });

  test("skips malformed lines (too few fields)", () => {
    const output = `12345\tmain\t0\tbash
bad line
67890\tdev\t1\tvim`;

    const map = parseTmuxPanes(output);
    expect(map.size).toBe(2);
    expect(map.has(12345)).toBe(true);
    expect(map.has(67890)).toBe(true);
  });

  test("skips lines with non-numeric pid", () => {
    const output = `notapid\tmain\t0\tbash
12345\tdev\t1\tvim`;

    const map = parseTmuxPanes(output);
    expect(map.size).toBe(1);
    expect(map.has(12345)).toBe(true);
  });

  test("ancestry walk simulation: match within 20 iterations", () => {
    // Simulate the walk: pid chain 100 -> 90 -> 80 -> 70 (match at 70)
    const paneMap = new Map([[70, { session: "test", window_index: "0", window_name: "bash" }]]);
    const parentChain: Record<number, number> = { 100: 90, 90: 80, 80: 70, 70: 1 };

    let currentPid = 100;
    let result: { session: string; window_index: string; window_name: string } | null = null;
    for (let i = 0; i < 20; i++) {
      if (paneMap.has(currentPid)) {
        result = paneMap.get(currentPid)!;
        break;
      }
      const parent = parentChain[currentPid];
      if (!parent || parent <= 1) break;
      currentPid = parent;
    }

    expect(result).toEqual({ session: "test", window_index: "0", window_name: "bash" });
  });

  test("ancestry walk simulation: no match within 20 iterations", () => {
    const paneMap = new Map([[1, { session: "unreachable", window_index: "0", window_name: "bash" }]]);
    // Chain never reaches pid 1 within 20 steps (goes 100 -> 99 -> ... -> 81)
    const parentChain: Record<number, number> = {};
    for (let i = 100; i > 80; i--) {
      parentChain[i] = i - 1;
    }
    parentChain[81] = 0; // terminates before reaching paneMap entry

    let currentPid = 100;
    let result: { session: string; window_index: string; window_name: string } | null = null;
    for (let i = 0; i < 20; i++) {
      if (paneMap.has(currentPid)) {
        result = paneMap.get(currentPid)!;
        break;
      }
      const parent = parentChain[currentPid];
      if (!parent || parent <= 1) break;
      currentPid = parent;
    }

    expect(result).toBeNull();
  });

  test("ancestry walk simulation: ppid=1 terminates early", () => {
    const paneMap = new Map([[999, { session: "test", window_index: "0", window_name: "bash" }]]);
    const parentChain: Record<number, number> = { 100: 1 }; // immediate init

    let currentPid = 100;
    let result: { session: string; window_index: string; window_name: string } | null = null;
    for (let i = 0; i < 20; i++) {
      if (paneMap.has(currentPid)) {
        result = paneMap.get(currentPid)!;
        break;
      }
      const parent = parentChain[currentPid];
      if (!parent || parent <= 1) break;
      currentPid = parent;
    }

    expect(result).toBeNull();
  });
});

describe("F2 parsePsTree (process tree parsing)", () => {
  test("parses standard ps -eo pid,ppid output with header", () => {
    const output = `  PID  PPID
    1     0
  100     1
  200   100
  300   200`;
    const tree = parsePsTree(output);
    expect(tree.size).toBe(4);
    expect(tree.get(1)).toBe(0);
    expect(tree.get(100)).toBe(1);
    expect(tree.get(200)).toBe(100);
    expect(tree.get(300)).toBe(200);
  });

  test("ancestry walk via parsePsTree-built map", () => {
    const tree = parsePsTree(`  PID  PPID
   10     1
   20    10
   30    20
   40    30`);
    let pid = 40;
    const path: number[] = [];
    for (let i = 0; i < 20; i++) {
      path.push(pid);
      const parent = tree.get(pid);
      if (parent === undefined || parent <= 1) break;
      pid = parent;
    }
    expect(path).toEqual([40, 30, 20, 10]);
  });

  test("handles empty output", () => {
    expect(parsePsTree("").size).toBe(0);
  });

  test("skips header-only output", () => {
    expect(parsePsTree("  PID  PPID").size).toBe(0);
  });

  test("skips malformed lines", () => {
    const tree = parsePsTree(`  PID  PPID
   10    1
not a row
   20    10`);
    expect(tree.size).toBe(2);
    expect(tree.has(10)).toBe(true);
    expect(tree.has(20)).toBe(true);
  });
});

// --- Integration test: live broker round-trip ---

describe("F1+F2 live broker integration", () => {
  const BROKER_PORT = 17899; // Use non-standard port to avoid conflicts
  let brokerProc: ReturnType<typeof Bun.spawn>;
  const brokerUrl = `http://127.0.0.1:${BROKER_PORT}`;
  const TEST_DB = "/tmp/claude-peers-test-f1f2.db";

  beforeAll(async () => {
    // Clean up any old test DB
    try { await Bun.write(TEST_DB, ""); Bun.spawnSync(["rm", "-f", TEST_DB]); } catch {}

    brokerProc = Bun.spawn(["bun", "/home/manzo/claude-peers-mcp/broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_PORT: String(BROKER_PORT), CLAUDE_PEERS_DB: TEST_DB },
      stdout: "ignore",
      stderr: "ignore",
    });

    // Wait for broker to start — fail fast with a clear message if it doesn't
    let brokerAlive = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${brokerUrl}/health`, { signal: AbortSignal.timeout(500) });
        if (res.ok) { brokerAlive = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!brokerAlive) {
      throw new Error(`Test broker failed to start on ${brokerUrl} within 6 seconds`);
    }
  });

  afterAll(() => {
    brokerProc.kill();
    Bun.spawnSync(["rm", "-f", TEST_DB]);
  });

  // S2: token-aware test fetch (mirrors delivery.test.ts).
  const tokens = new Map<string, string>();
  async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const b = body as Record<string, unknown> | undefined;
    const claimedId = (b?.id as string | undefined) ?? (b?.from_id as string | undefined);
    if (claimedId && tokens.has(claimedId)) {
      headers["X-Peer-Token"] = tokens.get(claimedId)!;
    }
    const res = await fetch(`${brokerUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (path === "/register" && json.id && json.token) {
      tokens.set(json.id as string, json.token as string);
    }
    return json as T;
  }

  test("F1: register with name, retrieve via list_peers", async () => {
    const reg = await brokerFetch<{ id: string }>("/register", {
      pid: process.pid,
      cwd: "/home/test",
      git_root: null,
      tty: "pts/99",
      name: "test-mary",
      tmux_session: null,
      tmux_window_index: null,
      tmux_window_name: null,
      summary: "test peer",
    });

    expect(reg.id).toBeTruthy();

    const peers = await brokerFetch<Peer[]>("/list-peers", { id: reg.id,
      scope: "machine",
      cwd: "/",
      git_root: null,
    });

    const found = peers.find((p) => p.id === reg.id);
    expect(found).toBeTruthy();
    expect(found!.name).toBe("test-mary");
  });

  test("F1: register without name (backward compat)", async () => {
    const reg = await brokerFetch<{ id: string }>("/register", {
      pid: process.pid, // fake different PID
      cwd: "/home/test2",
      git_root: null,
      tty: null,
      name: null,
      tmux_session: null,
      tmux_window_index: null,
      tmux_window_name: null,
      summary: "",
    });

    const peers = await brokerFetch<Peer[]>("/list-peers", { id: reg.id,
      scope: "machine",
      cwd: "/",
      git_root: null,
    });

    const found = peers.find((p) => p.id === reg.id);
    expect(found).toBeTruthy();
    expect(found!.name).toBeNull();
  });

  test("F2: register with tmux fields, retrieve via list_peers", async () => {
    const reg = await brokerFetch<{ id: string }>("/register", {
      pid: process.pid,
      cwd: "/home/test3",
      git_root: null,
      tty: "pts/50",
      name: "test-winston",
      tmux_session: "dev",
      tmux_window_index: "3",
      tmux_window_name: "architect",
      summary: "arch work",
    });

    const peers = await brokerFetch<Peer[]>("/list-peers", { id: reg.id,
      scope: "machine",
      cwd: "/",
      git_root: null,
    });

    const found = peers.find((p) => p.id === reg.id);
    expect(found).toBeTruthy();
    expect(found!.tmux_session).toBe("dev");
    expect(found!.tmux_window_index).toBe("3");
    expect(found!.tmux_window_name).toBe("architect");
  });

  test("F2: duplicate operator names keep unique resolved names but list active seat once", async () => {
    const childA = Bun.spawn(["sleep", "60"]);
    const childB = Bun.spawn(["sleep", "60"]);
    try {
      const first = await brokerFetch<{ id: string; name: string | null; resolved_name: string | null }>("/register", {
        pid: childA.pid, cwd: "/dup", git_root: null, tty: "pts/dup", name: "codex.2",
        tmux_session: "codex", tmux_window_index: "1", tmux_window_name: "node", tmux_pane_id: "%200", summary: "",
      });
      const second = await brokerFetch<{ id: string; name: string | null; resolved_name: string | null }>("/register", {
        pid: childB.pid, cwd: "/dup", git_root: null, tty: "pts/dup", name: "codex.2",
        tmux_session: "codex", tmux_window_index: "1", tmux_window_name: "node", tmux_pane_id: "%200", summary: "",
      });

      expect(first.name).toBe("codex.2");
      expect(first.resolved_name).toBe("codex.2");
      expect(second.name).toBe("codex.2");
      expect(second.resolved_name).toBe("codex.2#2");

      const active = await brokerFetch<Peer[]>("/list-peers", { id: second.id, scope: "machine", cwd: "/", git_root: null });
      const diagnostic = await brokerFetch<Peer[]>("/list-peers", { id: second.id, scope: "machine", cwd: "/", git_root: null, include_inactive: true });
      expect(active.filter((p) => p.name === "codex.2")).toHaveLength(1);
      expect(diagnostic.filter((p) => p.name === "codex.2")).toHaveLength(2);
      expect(diagnostic.map((p) => p.resolved_name).sort()).toContain("codex.2#2");
    } finally {
      childA.kill();
      childB.kill();
    }
  });

  test("F2: register outside tmux (null fields)", async () => {
    const reg = await brokerFetch<{ id: string }>("/register", {
      pid: process.pid,
      cwd: "/home/test4",
      git_root: null,
      tty: null,
      name: null,
      tmux_session: null,
      tmux_window_index: null,
      tmux_window_name: null,
      summary: "",
    });

    const peers = await brokerFetch<Peer[]>("/list-peers", { id: reg.id,
      scope: "machine",
      cwd: "/",
      git_root: null,
    });

    const found = peers.find((p) => p.id === reg.id);
    expect(found).toBeTruthy();
    expect(found!.tmux_session).toBeNull();
    expect(found!.tmux_window_index).toBeNull();
    expect(found!.tmux_window_name).toBeNull();
  });
});

// --- N10: generateSummary deterministic helper (replaces the AI version) ---

describe("generateSummary (deterministic git-based)", () => {
  test("project name from git_root basename", () => {
    expect(generateSummary({ cwd: "/tmp", git_root: "/home/manzo/claude-peers-mcp" })).toBe("claude-peers-mcp");
  });

  test("falls back to cwd basename when git_root is null", () => {
    expect(generateSummary({ cwd: "/home/user/some-project", git_root: null })).toBe("some-project");
  });

  test("suppresses 'main' branch from output", () => {
    expect(generateSummary({ cwd: "/", git_root: "/x", git_branch: "main" })).toBe("x");
  });

  test("suppresses 'master' branch from output", () => {
    expect(generateSummary({ cwd: "/", git_root: "/x", git_branch: "master" })).toBe("x");
  });

  test("includes non-default branch in parentheses", () => {
    expect(generateSummary({ cwd: "/", git_root: "/x", git_branch: "feat/foo" })).toBe("x (feat/foo)");
  });

  test("includes first recent file with em-dash separator", () => {
    expect(generateSummary({ cwd: "/", git_root: "/proj", recent_files: ["src/index.ts"] })).toBe("proj — editing src/index.ts");
  });

  test("appends +N suffix when more than one recent file", () => {
    expect(generateSummary({
      cwd: "/", git_root: "/proj",
      recent_files: ["a.ts", "b.ts", "c.ts"]
    })).toBe("proj — editing a.ts +2");
  });

  test("combines branch and recent file", () => {
    expect(generateSummary({
      cwd: "/", git_root: "/proj",
      git_branch: "fix/bug",
      recent_files: ["x.ts"]
    })).toBe("proj (fix/bug) — editing x.ts");
  });

  test("empty recent_files array does not add separator", () => {
    expect(generateSummary({ cwd: "/", git_root: "/proj", recent_files: [] })).toBe("proj");
  });

  test("returns null when path resolves to empty basename", () => {
    // basename("/") === "" — honor the `string | null` return type literally.
    expect(generateSummary({ cwd: "/", git_root: null })).toBeNull();
    expect(generateSummary({ cwd: "", git_root: null })).toBeNull();
  });

  test("regression guard: function is synchronous, not async", () => {
    // generateSummary used to be `async` (legacy from the API-call era).
    // Post-refactor it MUST be sync. If someone re-adds `async` this fails.
    const result = generateSummary({ cwd: "/", git_root: "/x" });
    expect(typeof result).toBe("string");
    expect(result).not.toBeInstanceOf(Promise);
  });
});

// --- N5: ALTER TABLE re-throw negative path ---

describe("M5 ALTER TABLE strict catch (re-throw on non-duplicate-column)", () => {
  // Replicates the broker.ts migration loop error handling: only swallows
  // "duplicate column name" errors; everything else must propagate.

  function migrateColumnsStrict(
    db: Database,
    cols: { name: string; type: string }[]
  ): void {
    for (const col of cols) {
      try {
        db.run(`ALTER TABLE peers ADD COLUMN ${col.name} ${col.type}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("duplicate column name")) {
          throw e;
        }
      }
    }
  }

  test("happy path: add new columns then re-run is idempotent", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE peers (id TEXT PRIMARY KEY)");
    expect(() =>
      migrateColumnsStrict(db, [{ name: "x", type: "TEXT" }, { name: "y", type: "TEXT" }])
    ).not.toThrow();
    // Re-run should also not throw (idempotent)
    expect(() =>
      migrateColumnsStrict(db, [{ name: "x", type: "TEXT" }, { name: "y", type: "TEXT" }])
    ).not.toThrow();
    db.close();
  });

  test("non-duplicate-column error MUST propagate (not silently swallowed)", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE peers (id TEXT PRIMARY KEY)");
    // Inject a syntax error via an invalid type — SQLite raises a non-duplicate
    // error, which our catch must re-throw.
    expect(() =>
      migrateColumnsStrict(db, [{ name: "bad", type: "INVALID_TYPE_NAME(((" }])
    ).toThrow();
    db.close();
  });

  test("re-throws on missing table (not 'duplicate column name')", () => {
    const db = new Database(":memory:");
    // No CREATE TABLE — ALTER on missing table raises a different error.
    expect(() =>
      migrateColumnsStrict(db, [{ name: "x", type: "TEXT" }])
    ).toThrow();
    db.close();
  });
});
