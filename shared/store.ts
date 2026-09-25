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
      // Wake-ups (operator plan 2026-09-25). Opt-in, and kept separate from
      // delivery: a wake only says "check your inbox"; it never offers or ACKs.
      this.addColumn("peers", "harness", "TEXT");
      this.addColumn("peers", "host_session_id", "TEXT");
      this.addColumn("peers", "wake_policy", "TEXT NOT NULL DEFAULT 'off'");
      this.addColumn("peers", "dnd_until", "INTEGER NOT NULL DEFAULT 0");
      this.addColumn("peers", "last_wake_at", "INTEGER NOT NULL DEFAULT 0");
      // NULL = never chose (automatic opt-in applies); 'on'/'off' = explicit choice.
      this.addColumn("peers", "wake_choice", "TEXT");
      // Durable receipt of the operator's own report/bounce, keyed by reason.
      this.addColumn("messages", "problem_reported", "TEXT");
      // Which wake attempt currently holds this message's claim (refund scoping).
      this.addColumn("messages", "wake_claim_attempt", "INTEGER");
      // Claim fencing (Astra P1 R1.3): an ACTIVE claim (owner + until) is distinct
      // from a failed attempt's retry-not-before. wake_lease_until is retired.
      this.addColumn("messages", "wake_claim_until", "INTEGER NOT NULL DEFAULT 0");
      this.addColumn("messages", "wake_retry_after", "INTEGER NOT NULL DEFAULT 0");
      this.addColumn("messages", "reply_to", "INTEGER");
      this.addColumn("messages", "woken_at", "INTEGER");
      this.addColumn("messages", "wake_attempts", "INTEGER NOT NULL DEFAULT 0");
      this.addColumn("messages", "wake_error", "TEXT");
      this.addColumn("messages", "wake_lease_until", "INTEGER NOT NULL DEFAULT 0");
      this.db.run(`CREATE TABLE IF NOT EXISTS wake_log (
        id INTEGER PRIMARY KEY, peer_id TEXT NOT NULL, claimed_at INTEGER NOT NULL, message_ids TEXT NOT NULL)`);
      this.db.run("CREATE INDEX IF NOT EXISTS wake_log_peer ON wake_log(peer_id, claimed_at)");
      // One row per wake attempt: claimed -> dispatched | uncertain | failed | revoked.
      this.db.run(`CREATE TABLE IF NOT EXISTS wake_attempts (
        id INTEGER PRIMARY KEY, peer_id TEXT NOT NULL, host_session_id TEXT NOT NULL,
        message_ids TEXT NOT NULL, status TEXT NOT NULL, claimed_at INTEGER NOT NULL,
        finished_at INTEGER, error TEXT)`);
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
      this.db.run("PRAGMA user_version = 3");
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
  send(from: string, to: string, text: string, replyTo?: number | null) {
    if (typeof text !== "string" || !text.trim() || text.length > 64000) throw new Error("Message must contain 1-64000 characters");
    const target = this.peer(to);
    const sender = this.canonical(from);
    if (replyTo !== undefined && replyTo !== null) {
      const parent = Number.isSafeInteger(replyTo) ? this.db.query("SELECT from_id,to_id FROM messages WHERE id=?").get(replyTo) as {from_id:string,to_id:string} | null : null;
      if (!parent || (sender !== "operator" && parent.from_id !== sender && parent.to_id !== sender)) throw new Error("reply_to must reference a message the sender sent or received");
    }
    const result = this.db.query("INSERT INTO messages(from_id,to_id,text,sent_at,delivered,reply_to) VALUES(?,?,?,?,0,?)").run(sender,target.id,text,new Date(this.now()).toISOString(),replyTo ?? null);
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
  optIn(id: string, wake: { harness: WakeHarness; host_session_id?: string }) {
    const pattern = HOST_SESSION_PATTERNS[wake?.harness];
    if (!pattern) throw new Error(`Unknown harness ${String(wake?.harness)}; expected ${Object.keys(HOST_SESSION_PATTERNS).join(" or ")}`);
    // A Codex MCP server may lack CODEX_THREAD_ID; its verified bound session key IS the thread id.
    if (wake.host_session_id === undefined && wake.harness === "codex") wake = { ...wake, host_session_id: this.peer(id).session_key ?? undefined };
    if (typeof wake.host_session_id !== "string" || !pattern.test(wake.host_session_id)) throw new Error(`Malformed host session id for ${wake.harness}`);
    const peer = this.peer(id);
    this.db.run("UPDATE peers SET harness=?,host_session_id=?,wake_policy='on',wake_choice='on' WHERE id=?", [wake.harness,wake.host_session_id,peer.id]);
    return { ok:true,id:peer.id,harness:wake.harness,host_session_id:wake.host_session_id };
  }
  optOut(id: string) {
    const peer = this.peer(id);
    this.db.run("UPDATE peers SET wake_policy='off',wake_choice='off' WHERE id=?", [peer.id]);
    return { ok:true,id:peer.id };
  }
  /**
   * Participation is on by default: hooks call this for every bound session.
   * It never overrides an explicit opt-out, and it keeps the host address fresh.
   */
  autoOptIn(id: string, wake: { harness: WakeHarness; host_session_id: string }) {
    const peer = this.peer(id) as Peer & { wake_choice?: string | null };
    if (peer.wake_choice === "off") return { id:peer.id,wake_policy:"off" };
    const pattern = HOST_SESSION_PATTERNS[wake?.harness];
    if (!pattern || typeof wake.host_session_id !== "string" || !pattern.test(wake.host_session_id)) throw new Error("Malformed wake identity");
    this.db.run("UPDATE peers SET harness=?,host_session_id=?,wake_policy='on' WHERE id=?", [wake.harness,wake.host_session_id,peer.id]);
    return { id:peer.id,wake_policy:"on" };
  }
  /** Suppress wakes for durationMs from now; 0 clears. Mail is still stored and delivered by hooks. */
  setDnd(id: string, durationMs: number) {
    if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 7*24*3600_000) throw new Error("DND duration must be 0-7 days in ms");
    const peer = this.peer(id), until = durationMs === 0 ? 0 : this.now()+durationMs;
    this.db.run("UPDATE peers SET dnd_until=? WHERE id=?", [until,peer.id]);
    return { ok:true,id:peer.id,dnd_until:until };
  }
  /**
   * Atomically claim wake batches: one per opted-in recipient, for mail the
   * recipient has never been offered. Offered mail means the recipient is
   * active (its hooks are delivering), so it is not woken.
   */
  claimWakes(opts: Partial<typeof WAKE_DEFAULTS> = {}): WakeBatch[] {
    const o = { ...WAKE_DEFAULTS, ...opts }, now = this.now();
    return this.db.transaction(() => {
      const rows = this.db.query(`SELECT m.id, p.id AS peer_id, p.harness, p.host_session_id FROM messages m
        JOIN peers p ON p.id = m.to_id
        WHERE m.delivered=0 AND (m.offer_count=0 OR m.lease_until<=?) AND m.wake_attempts<? AND m.wake_claim_until<=? AND m.wake_retry_after<=?
          AND (m.woken_at IS NULL OR m.woken_at<=?)
          AND p.wake_policy='on' AND p.host_session_id IS NOT NULL AND p.dnd_until<=?
          AND p.last_wake_at<=?
          AND (SELECT COUNT(*) FROM wake_log w WHERE w.peer_id=p.id AND w.claimed_at>?)<?
        ORDER BY m.id`).all(now-o.staleOfferMs,o.maxAttempts,now,now,now-o.receiptTimeoutMs,now,now-o.minGapMs,now-3600_000,o.maxPerHour) as {id:number,peer_id:string,harness:WakeHarness,host_session_id:string}[];
      const batches = new Map<string,WakeBatch>();
      for (const row of rows) {
        const batch = batches.get(row.peer_id) ?? {peer_id:row.peer_id,harness:row.harness,host_session_id:row.host_session_id,message_ids:[]};
        if (batch.message_ids.length < o.maxBatch) batch.message_ids.push(row.id);
        batches.set(row.peer_id,batch);
      }
      for (const batch of batches.values()) {
        batch.attempt_id = Number(this.db.query("INSERT INTO wake_attempts(peer_id,host_session_id,message_ids,status,claimed_at) VALUES(?,?,?,'claimed',?)")
          .run(batch.peer_id,batch.host_session_id,JSON.stringify(batch.message_ids),now).lastInsertRowid);
        for (const messageId of batch.message_ids) this.db.run("UPDATE messages SET wake_claim_until=?,wake_attempts=wake_attempts+1,wake_claim_attempt=? WHERE id=?", [now+o.leaseMs,batch.attempt_id,messageId]);
        this.db.run("UPDATE peers SET last_wake_at=? WHERE id=?", [now,batch.peer_id]);
        this.db.run("INSERT INTO wake_log(peer_id,claimed_at,message_ids) VALUES(?,?,?)", [batch.peer_id,now,JSON.stringify(batch.message_ids)]);
      }
      return [...batches.values()];
    })();
  }
  /**
   * Re-check a claimed batch immediately before dispatch: opt-out, DND, ACK,
   * a fresh offer, or an address change since the claim all revoke it.
   * Revoked ids have their claim released (no attempt is charged).
   */
  recheckWake(hostSessionId: string, ids: number[], attemptId: number): number[] {
    if (!Array.isArray(ids) || ids.length > 100 || !ids.every(n=>Number.isSafeInteger(n)&&n>0)) throw new Error("Expected 0-100 positive message IDs");
    if (!Number.isSafeInteger(attemptId) || attemptId <= 0) throw new Error("recheck requires the claim's attempt id");
    const now = this.now();
    return this.db.transaction(() => {
      const ok: number[] = [];
      for (const id of [...new Set(ids)]) {
        // Fenced: only the attempt that holds an ACTIVE claim may dispatch it.
        const owned = this.db.query("SELECT 1 FROM messages WHERE id=? AND wake_claim_attempt=? AND wake_claim_until>?").get(id,attemptId,now);
        if (!owned) continue; // expired, completed, or taken over by a newer claim: neither dispatch nor refund
        const row = this.db.query(`SELECT m.id FROM messages m JOIN peers p ON p.id=m.to_id
          WHERE m.id=? AND m.delivered=0 AND (m.offer_count=0 OR m.lease_until<=?)
            AND p.wake_policy='on' AND p.dnd_until<=? AND p.host_session_id=?`).get(id,now-WAKE_DEFAULTS.staleOfferMs,now,hostSessionId);
        if (row) ok.push(id);
        // Revoked while this attempt holds the active claim: release it and
        // refund once (clearing the owner makes repeats/stale calls no-ops).
        else this.db.run("UPDATE messages SET wake_claim_until=0,wake_claim_attempt=NULL,wake_attempts=MAX(0,wake_attempts-1) WHERE id=?", [id]);
      }
      if (ok.length === 0) this.db.run("UPDATE wake_attempts SET status='revoked',finished_at=? WHERE id=? AND status='claimed'", [now,attemptId]);
      return ok;
    })();
  }
  /**
   * Report a wake outcome for the claim `attemptId` holds. Fenced: messages
   * whose claim was taken over by a newer attempt are left untouched.
   * Failure sets a retry-not-before with exponential backoff (1, 2, 4 min...).
   */
  markWoken(ids: number[], ok: boolean, error: string | undefined, attemptId: number, uncertain = false, permanent = false) {
    if (!Array.isArray(ids) || ids.length > 100 || !ids.every(n=>Number.isSafeInteger(n)&&n>0)) throw new Error("Expected 0-100 positive message IDs");
    if (!Number.isSafeInteger(attemptId) || attemptId <= 0) throw new Error("mark-woken requires the claim's attempt id");
    const now = this.now(), err = String(error ?? "wake failed").slice(0,500);
    return this.db.transaction(() => {
      this.db.run("UPDATE wake_attempts SET status=?,finished_at=?,error=? WHERE id=? AND status='claimed'",
        [ok ? (uncertain ? "uncertain":"dispatched"):"failed",now,ok ? null:err,attemptId]);
      let marked = 0;
      for (const id of [...new Set(ids)]) {
        const row = this.db.query("SELECT wake_attempts FROM messages WHERE id=? AND wake_claim_attempt=?").get(id,attemptId) as {wake_attempts:number} | null;
        if (!row) continue; // not (or no longer) this attempt's claim
        marked++;
        if (ok) this.db.run("UPDATE messages SET woken_at=?,wake_error=NULL,wake_claim_until=0,wake_claim_attempt=NULL WHERE id=?", [now,id]);
        else {
          const backoff = 60_000 * 2 ** Math.max(0,row.wake_attempts-1);
          // Permanent (e.g. archived thread): don't burn more attempts first.
          this.db.run(`UPDATE messages SET wake_error=?,wake_claim_until=0,wake_claim_attempt=NULL,wake_retry_after=?${permanent ? ",wake_attempts=MAX(wake_attempts,?)":""} WHERE id=?`,
            permanent ? [err,now+backoff,WAKE_DEFAULTS.maxAttempts,id] : [err,now+backoff,id]);
        }
      }
      return { ok:true,marked };
    })();
  }
  /**
   * The operator's ledger: recent mail that has NOT arrived (never offered to
   * the recipient) and why. Arrival = the recipient's hook/inbox fetched it.
   */
  deliveryProblems(graceMs = 120_000, windowMs = 24*3600_000): DeliveryProblem[] {
    const now = this.now(), o = WAKE_DEFAULTS;
    const rows = this.db.query(`SELECT m.id,m.from_id,m.to_id,m.sent_at,m.woken_at,m.wake_attempts,m.wake_error,m.problem_reported,p.wake_policy,p.wake_choice,p.host_session_id
      FROM messages m LEFT JOIN peers p ON p.id=m.to_id
      WHERE m.delivered=0 AND (m.offer_count=0 OR m.lease_until<=?) AND m.sent_at>=? AND m.sent_at<=? ORDER BY m.id`)
      .all(now-o.staleOfferMs,new Date(now-windowMs).toISOString(),new Date(now-graceMs).toISOString()) as any[];
    const out: DeliveryProblem[] = [];
    for (const r of rows) {
      const base = {message_id:r.id,from_id:r.from_id,to_id:r.to_id};
      if (r.wake_attempts >= o.maxAttempts) out.push({...base,reason:"wake-failed",detail:r.wake_error ?? "no error recorded"});
      else if (r.wake_choice === "off") out.push({...base,reason:"recipient-opted-out"});
      else if (r.wake_policy !== "on" || !r.host_session_id) out.push({...base,reason:"no-wake-address"});
      else if (r.woken_at !== null && r.woken_at <= now - 2*o.receiptTimeoutMs) out.push({...base,reason:"woken-not-picked-up"});
    }
    // Reported problems are not reported again. Unaddressed ones stay listed
    // (flagged) so the operator keeps trying to connect them from evidence.
    return out.flatMap(p => rows.find(r=>r.id===p.message_id)?.problem_reported !== p.reason ? [p]
      : p.reason === "no-wake-address" ? [{...p,already_reported:true}] : []);
  }
  /** Idempotent: record that the operator reported/bounced this message for this reason. */
  markProblemReported(id: number, reason: string) {
    this.db.run("UPDATE messages SET problem_reported=? WHERE id=?", [String(reason).slice(0,50),id]);
    return { ok:true };
  }
  /** Undelivered mail whose wakes were exhausted: a human should look. */
  wakeAttention(maxAttempts = WAKE_DEFAULTS.maxAttempts): Message[] {
    return this.db.query("SELECT * FROM messages WHERE delivered=0 AND (offer_count=0 OR lease_until<=?) AND wake_attempts>=? ORDER BY id").all(this.now()-WAKE_DEFAULTS.staleOfferMs,maxAttempts) as Message[];
  }
}

export type WakeHarness = "codex" | "claude-desktop";
export interface DeliveryProblem { message_id: number; from_id: string; to_id: string; reason: string; detail?: string; already_reported?: boolean }
export interface WakeBatch { peer_id: string; harness: WakeHarness; host_session_id: string; message_ids: number[]; attempt_id?: number }
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Host ids reach a shell (`codex queue --thread`) and a session tool, so they
// are validated to their exact shapes, never passed through as free text.
const HOST_SESSION_PATTERNS: Record<string,RegExp> = {
  "codex": new RegExp(`^${UUID}$`),
  "claude-desktop": new RegExp(`^local_${UUID}$`),
};
// staleOfferMs: an offer not acknowledged this long after its lease expired is not treated
// as arrival (the hook output may never have reached the model; Astra P1).
export const WAKE_DEFAULTS = { staleOfferMs:15*60_000, leaseMs:60_000, minGapMs:30_000, receiptTimeoutMs:10*60_000, maxAttempts:3, maxPerHour:20, maxBatch:20 };
