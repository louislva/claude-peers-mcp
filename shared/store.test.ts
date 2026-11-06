import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeerStore } from "./store.ts";

const dirs:string[]=[]; const stores:PeerStore[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.db.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),"peers-store-"));dirs.push(dir);
 const path=join(dir,"test.db");const live=new Set([1,2,3]);let time=1000;
 const open=()=>{const s=new PeerStore(path,pid=>live.has(pid),()=>time);stores.push(s);return s;};
 const store=open();
 const reg=(pid:number,key?:string)=>store.register({pid,cwd:"/same-project",git_root:"/repo",tty:null,summary:"test",session_key:key,pid_start:`birth-${pid}`}).id;
 return {store,open,live,reg,path,advance:()=>{time+=31000;}};
}

describe("durable receipt and recovery contract",()=>{
 test("fetch does not ACK; lease expiry redelivers the same ID; ACK is idempotent",()=>{
  const f=fixture(),a=f.reg(1),b=f.reg(2);const {id}=f.store.send(a,b,"finding");
  expect(f.store.poll(b).map(m=>m.id)).toEqual([id]);
  expect(f.store.db.query("SELECT delivered,acknowledged_at FROM messages WHERE id=?").get(id)).toEqual({delivered:0,acknowledged_at:null});
  expect(f.store.poll(b)).toHaveLength(0);f.advance();
  expect(f.store.poll(b).map(m=>m.id)).toEqual([id]);
  f.store.acknowledge(b,[id]);f.store.acknowledge(b,[id]);
  expect(f.store.poll(b,true)).toHaveLength(0);
 });
 test("manual read recovers an in-flight offer without waiting",()=>{
  const f=fixture(),a=f.reg(1),b=f.reg(2);f.store.send(a,b,"x");
  expect(f.store.poll(b)).toHaveLength(1);expect(f.store.poll(b,true)).toHaveLength(1);
 });
 test("ACK validates recipient and whole batch before mutating",()=>{
  const f=fixture(),a=f.reg(1),b=f.reg(2);const {id}=f.store.send(a,b,"x");
  expect(()=>f.store.acknowledge(b,[id])).toThrow("fetched");f.store.poll(b);
  expect(()=>f.store.acknowledge(a,[id])).toThrow("outside");
  expect(()=>f.store.acknowledge(b,[id,id+100])).toThrow("outside");
  expect(f.store.poll(b,true)).toHaveLength(1);
 });
 test("same-process registration preserves identity and pending inbox",()=>{
  const f=fixture(),a=f.reg(1),b=f.reg(2);const {id}=f.store.send(a,b,"x");
  expect(f.reg(2)).toBe(b);expect(f.store.poll(b).map(m=>m.id)).toEqual([id]);
 });
 test("process death and broker restart retain pending mail and offline discovery",()=>{
  const f=fixture(),a=f.reg(1),b=f.reg(2,"task-b");const {id}=f.store.send(a,b,"x");
  f.store.poll(b);f.live.delete(2);f.store.cleanStale();
  expect(f.store.list("machine").map(p=>p.id)).not.toContain(b);
  expect(f.store.list("machine",undefined,undefined,undefined,true).find(p=>p.id===b)?.pending_count).toBe(1);
  const restarted=f.open();f.live.add(3);
  expect(restarted.register({pid:3,cwd:"/same-project",git_root:"/repo",tty:null,summary:"",session_key:"task-b",pid_start:"new"}).id).toBe(b);
  expect(restarted.poll(b).map(m=>m.id)).toEqual([id]);
 });
 test("unregister preserves inbox and permits offline sends",()=>{
  const f=fixture(),a=f.reg(1),b=f.reg(2);f.store.unregister(b);
  expect(f.store.send(a,b,"offline").queued).toBe(true);
  expect(f.store.poll(b,true)).toHaveLength(1);
 });
 test("same cwd never merges distinct sessions or guessed identities",()=>{
  const f=fixture(),a=f.reg(1,"task-a"),b=f.reg(2,"task-b");
  expect(a).not.toBe(b);expect(()=>f.store.bindSession(a,"task-b")).toThrow();
  expect(f.store.resolveSession("task-a")?.id).toBe(a);
  expect(f.store.resolveSession("unknown")).toBeNull();
 });
 test("live session cannot be taken over",()=>{
  const f=fixture();f.reg(1,"task-a");expect(()=>f.reg(2,"task-a")).toThrow("live");
 });
 test("late GUI binding resumes original identity; provisional ID remains routable",()=>{
  const f=fixture(),old=f.reg(1,"gui-session"),sender=f.reg(2);
  const {id}=f.store.send(sender,old,"pending across GUI restart");
  f.live.delete(1);f.store.cleanStale();const provisional=f.reg(3);
  const newer=f.store.send(sender,provisional,"pending before binding");
  expect(f.store.bindSession(provisional,"gui-session").id).toBe(old);
  expect(f.store.resolveSession("gui-session")?.id).toBe(old);
  expect(f.store.poll(provisional,true).map(m=>m.id)).toEqual([id,newer.id]);
  f.store.acknowledge(provisional,[id,newer.id]);
  expect(f.store.send(sender,provisional,"routed").to_id).toBe(old);
 });
 test("legacy set_summary explicitly binds and removes marker from display summary",()=>{
  const f=fixture(),a=f.reg(1);
  expect(f.store.setSummary(a,"[session:task-123] useful work").id).toBe(a);
  expect(f.store.resolveSession("task-123")?.summary).toBe("useful work");
  expect(()=>f.store.setSummary(a,"[session:another-task] no")).toThrow();
 });
 test("offline recovery is explicit and auditable",()=>{
  const f=fixture(),a=f.reg(1),b=f.reg(2);f.store.send(a,b,"old inbox");
  expect(()=>f.store.recover(b,a)).toThrow("offline");f.store.unregister(b);
  expect(f.store.recover(b,a).recovered).toBe(1);
  expect(f.store.poll(a)).toHaveLength(1);
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM inbox_recoveries").get()).toEqual({n:1});
 });
 test("atomic leases prevent separate database connections offering the same batch",()=>{
  const f=fixture(),a=f.reg(1),b=f.reg(2);f.store.send(a,b,"x");const other=f.open();
  expect(f.store.poll(b)).toHaveLength(1);expect(other.poll(b)).toHaveLength(0);
 });
 test("migration preserves pending and historic delivery, exposes orphan inboxes, is repeatable",()=>{
  const dir=mkdtempSync(join(tmpdir(),"peers-migration-"));dirs.push(dir);const path=join(dir,"legacy.db");
  const legacy=new Database(path);
  legacy.run("CREATE TABLE peers(id TEXT PRIMARY KEY,pid INTEGER NOT NULL,cwd TEXT NOT NULL,git_root TEXT,tty TEXT,summary TEXT NOT NULL DEFAULT '',registered_at TEXT NOT NULL,last_seen TEXT NOT NULL)");
  legacy.run("CREATE TABLE messages(id INTEGER PRIMARY KEY,from_id TEXT NOT NULL,to_id TEXT NOT NULL,text TEXT NOT NULL,sent_at TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0)");
  legacy.run("INSERT INTO messages VALUES(1,'sender','orphan','pending','then',0),(2,'sender','orphan','old delivered','then',1)");legacy.close();
  for(let i=0;i<2;i++){
   const s=new PeerStore(path,()=>false);stores.push(s);
   expect(s.list("machine",undefined,undefined,undefined,true)).toHaveLength(1);
   expect(s.poll("orphan",true).map(m=>m.id)).toEqual([1]);
   expect(s.db.query("SELECT acknowledged_at FROM messages WHERE id=2").get()).toEqual({acknowledged_at:null});
   expect(s.db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({n:2});
  }
 });
});
