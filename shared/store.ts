import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Message, Peer, RegisterRequest } from "./types.ts";

// Explicit receipt ACKs are distinct from offers, task acceptance and completion.
export class PeerStore {
  readonly db: Database;
  constructor(path: string, private alive = (pid: number) => {
    if (pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  }, private now = () => Date.now()) {
    this.db = new Database(path);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = FULL");
    this.db.run("PRAGMA busy_timeout = 3000");
    this.db.transaction(() => {
      this.db.run(`CREATE TABLE IF NOT EXISTS peers (
        id TEXT PRIMARY KEY, pid INTEGER NOT NULL, cwd TEXT NOT NULL,
        git_root TEXT, tty TEXT, summary TEXT NOT NULL DEFAULT '',
        registered_at TEXT NOT NULL, last_seen TEXT NOT NULL)`);
      this.db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL,
        to_id TEXT NOT NULL, text TEXT NOT NULL, sent_at TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0)`);
      this.addColumn("peers", "online", "INTEGER NOT NULL DEFAULT 1");
      this.addColumn("peers", "session_key", "TEXT");
      this.addColumn("peers", "pid_start", "TEXT");
      this.addColumn("messages", "acknowledged_at", "TEXT");
      this.addColumn("messages", "lease_until", "INTEGER NOT NULL DEFAULT 0");
      this.addColumn("messages", "offer_count", "INTEGER NOT NULL DEFAULT 0");
      this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS peer_session_key ON peers(session_key) WHERE session_key IS NOT NULL");
      this.db.run("CREATE INDEX IF NOT EXISTS pending_inbox ON messages(to_id, delivered, lease_until, id)");
      this.db.run("CREATE TABLE IF NOT EXISTS peer_aliases (alias TEXT PRIMARY KEY, canonical TEXT NOT NULL)");
      this.db.run(`CREATE TABLE IF NOT EXISTS inbox_recoveries (
        id INTEGER PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
        message_count INTEGER NOT NULL, recovered_at TEXT NOT NULL)`);
      // Recover discoverability of already-orphaned legacy inboxes. Never
      // replay old delivered=1 messages: their actual receipt is unknown.
      this.db.run(`INSERT INTO peers(id,pid,cwd,summary,registered_at,last_seen,online)
        SELECT DISTINCT to_id,0,'','Recovered legacy inbox; original session metadata unavailable',
          '', '',0 FROM messages WHERE delivered=0 AND to_id NOT IN (SELECT id FROM peers)`);
      this.db.run("PRAGMA user_version = 2");
    })();
    this.cleanStale();
  }
  private addColumn(table: string, column: string, definition: string) {
    const columns = this.db.query(`PRAGMA table_info(${table})`).all() as {name: string}[];
    if (!columns.some(c => c.name === column)) this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  canonical(id: string): string {
    const row = this.db.query("SELECT canonical FROM peer_aliases WHERE alias=?").get(id) as {canonical: string} | null;
    return row?.canonical ?? id;
  }
  peer(id: string): Peer {
    const row = this.db.query("SELECT * FROM peers WHERE id=?").get(this.canonical(id)) as Peer | null;
    if (!row) throw new Error(`Peer ${id} not found`);
    return row;
  }
  private isOnline(peer: Peer) { return Boolean(peer.online) && this.alive(peer.pid); }
  cleanStale() {
    for (const peer of this.db.query("SELECT * FROM peers WHERE online=1").all() as Peer[]) {
      if (!this.alive(peer.pid)) this.db.run("UPDATE peers SET online=0 WHERE id=?", [peer.id]);
    }
  }
  register(input: RegisterRequest): { id: string } {
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0 || typeof input.cwd !== "string") throw new Error("Invalid peer registration");
    if (input.session_key !== undefined && !/^[a-zA-Z0-9:_-]{1,200}$/.test(input.session_key)) throw new Error("Invalid session key");
    return this.db.transaction(() => {
      this.cleanStale();
      let existing = input.session_key ? this.db.query("SELECT * FROM peers WHERE session_key=?").get(input.session_key) as Peer | null : null;
      const sameProcess = this.db.query("SELECT * FROM peers WHERE pid=? AND online=1 AND id NOT IN (SELECT alias FROM peer_aliases)").get(input.pid) as Peer | null;
      if (!existing && sameProcess && (!input.pid_start || !sameProcess.pid_start || sameProcess.pid_start === input.pid_start)) {
        if (input.session_key && sameProcess.session_key && sameProcess.session_key !== input.session_key) throw new Error("Process already bound to another session");
        existing = sameProcess;
      }
      if (existing && this.isOnline(existing) && (existing.pid !== input.pid || (existing.pid_start && input.pid_start && existing.pid_start !== input.pid_start))) throw new Error("Session already owned by a live process");
      const id = existing?.id ?? randomUUID().replaceAll("-", "").slice(0, 16);
      const timestamp = new Date(this.now()).toISOString();
      this.db.run(`INSERT INTO peers(id,pid,cwd,git_root,tty,summary,registered_at,last_seen,online,session_key,pid_start)
        VALUES(?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET
        pid=excluded.pid,cwd=excluded.cwd,git_root=excluded.git_root,tty=excluded.tty,
        summary=CASE WHEN excluded.summary='' THEN peers.summary ELSE excluded.summary END,
        last_seen=excluded.last_seen,online=1,session_key=COALESCE(excluded.session_key,peers.session_key),pid_start=excluded.pid_start`,
        [id,input.pid,input.cwd,input.git_root,input.tty,input.summary,timestamp,timestamp,input.session_key ?? null,input.pid_start ?? null]);
      this.db.run("UPDATE messages SET lease_until=0 WHERE to_id=? AND delivered=0", [id]);
      return { id };
    })();
  }
  bindSession(id: string, key: string): { id: string } {
    if (!/^[a-zA-Z0-9:_-]{1,200}$/.test(key)) throw new Error("Invalid session key");
    return this.db.transaction(() => {
      const current = this.peer(id);
      if (current.session_key && current.session_key !== key) throw new Error("Peer is already bound to a different session");
      const previous = this.db.query("SELECT * FROM peers WHERE session_key=?").get(key) as Peer | null;
      if (!previous || previous.id === current.id) {
        this.db.run("UPDATE peers SET session_key=? WHERE id=?", [key,current.id]);
        return { id: current.id };
      }
      if (this.isOnline(previous)) throw new Error("Session already owned by a live process");
      // Keep the original identity; redirect the new MCP client's provisional
      // ID so already-running clients remain usable after binding.
      this.db.run("UPDATE messages SET to_id=?,lease_until=0 WHERE to_id=? AND delivered=0", [previous.id,current.id]);
      this.db.run(`UPDATE peers SET pid=?,pid_start=?,cwd=?,git_root=?,tty=?,summary=?,last_seen=?,online=1 WHERE id=?`,
        [current.pid,current.pid_start ?? null,current.cwd,current.git_root,current.tty,current.summary,current.last_seen,previous.id]);
      this.db.run("UPDATE peers SET online=0,session_key=NULL WHERE id=?", [current.id]);
      this.db.run("UPDATE peer_aliases SET canonical=? WHERE canonical=?", [previous.id,current.id]);
      this.db.run("INSERT OR REPLACE INTO peer_aliases(alias,canonical) VALUES(?,?)", [current.id,previous.id]);
      this.db.run("UPDATE messages SET lease_until=0 WHERE to_id=? AND delivered=0", [previous.id]);
      return { id: previous.id };
    })();
  }
  resolveSession(key: string): Peer | null {
    const peer = this.db.query("SELECT * FROM peers WHERE session_key=?").get(key) as Peer | null;
    return peer && this.isOnline(peer) ? peer : null;
  }
  list(scope: string, cwd?: string, gitRoot?: string | null, exclude?: string, includeOffline=false) {
    this.cleanStale();
    return (this.db.query(`SELECT peers.*, (SELECT COUNT(*) FROM messages WHERE to_id=peers.id AND delivered=0) AS pending_count
      FROM peers WHERE id NOT IN (SELECT alias FROM peer_aliases) ORDER BY last_seen DESC`).all() as Peer[]).filter(p =>
      (includeOffline || p.online) && p.id !== (exclude ? this.canonical(exclude) : undefined) &&
      (scope === "machine" || (scope === "repo" && gitRoot ? p.git_root === gitRoot : p.cwd === cwd)));
  }
  heartbeat(id: string) {
    this.db.run("UPDATE peers SET last_seen=?,online=1 WHERE id=?", [new Date(this.now()).toISOString(),this.peer(id).id]);
  }
  setSummary(id: string, summary: string) {
    if (typeof summary !== "string") throw new Error("Expected summary text");
    // Existing MCP clients have set_summary but not bind_session. An explicit
    // anchored marker lets their hook bootstrap without restarting the GUI.
    const match = summary.match(/^\[session:([a-zA-Z0-9:_-]{1,200})\]\s*/);
    if (match) { this.bindSession(id,match[1]!); summary=summary.slice(match[0].length); }
    const peer = this.peer(id);
    this.db.run("UPDATE peers SET summary=? WHERE id=?", [summary,peer.id]);
    return { id: peer.id };
  }
  unregister(id: string) { this.db.run("UPDATE peers SET online=0 WHERE id=?", [this.peer(id).id]); }
  send(from: string, to: string, text: string) {
    if (typeof text !== "string" || !text.trim() || text.length > 64000) throw new Error("Message must contain 1-64000 characters");
    const target = this.peer(to);
    const result = this.db.query("INSERT INTO messages(from_id,to_id,text,sent_at,delivered) VALUES(?,?,?,?,0)").run(this.canonical(from),target.id,text,new Date(this.now()).toISOString());
    return { ok:true,id:Number(result.lastInsertRowid),to_id:target.id,queued:!this.isOnline(target) };
  }
  poll(id: string, force=false, leaseMs=30000): Message[] {
    const target = this.peer(id).id;
    return this.db.transaction(() => {
      const messages = this.db.query(`SELECT * FROM messages WHERE to_id=? AND delivered=0 AND (? OR lease_until<=?) ORDER BY id LIMIT 20`).all(target,force ? 1:0,this.now()) as Message[];
      for (const message of messages) this.db.run("UPDATE messages SET lease_until=?,offer_count=offer_count+1 WHERE id=?", [this.now()+leaseMs,message.id]);
      return messages;
    })();
  }
  acknowledge(id: string, ids: number[]) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every(n=>Number.isSafeInteger(n)&&n>0)) throw new Error("Expected 1-100 positive message IDs");
    const target = this.peer(id).id;
    return this.db.transaction(() => {
      const rows = ids.map(messageId=>this.db.query("SELECT * FROM messages WHERE id=? AND to_id=?").get(messageId,target) as Message | null);
      if (rows.some(m=>!m)) throw new Error("Cannot acknowledge a message outside this inbox");
      if (rows.some(m=>!m!.delivered && m!.offer_count === 0)) throw new Error("Message must be fetched before acknowledgement");
      for (const row of rows) if (!row!.delivered) this.db.run("UPDATE messages SET delivered=1,acknowledged_at=?,lease_until=0 WHERE id=?", [new Date(this.now()).toISOString(),row!.id]);
      return { ok:true,acknowledged:ids };
    })();
  }
  recover(fromId: string, toId: string) {
    return this.db.transaction(() => {
      const from=this.peer(fromId),to=this.peer(toId);
      if (from.id===to.id || this.isOnline(from)) throw new Error("Recovery requires a different, offline source inbox");
      const result=this.db.run("UPDATE messages SET to_id=?,lease_until=0 WHERE to_id=? AND delivered=0", [to.id,from.id]);
      this.db.run("INSERT INTO inbox_recoveries(from_id,to_id,message_count,recovered_at) VALUES(?,?,?,?)", [from.id,to.id,result.changes,new Date(this.now()).toISOString()]);
      return { ok:true,recovered:result.changes,from_id:from.id,to_id:to.id };
    })();
  }
}
