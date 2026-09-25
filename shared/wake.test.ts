import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeerStore } from "./store.ts";

const dirs:string[]=[]; const stores:PeerStore[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.db.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),"peers-wake-"));dirs.push(dir);
 let time=1_000_000;
 const store=new PeerStore(join(dir,"t.db"),pid=>pid>0,()=>time);stores.push(store);
 const reg=(pid:number)=>store.register({pid,cwd:"/p",git_root:null,tty:null,summary:"",pid_start:`b${pid}`}).id;
 const sender=reg(1),codex=reg(2),claude=reg(3);
 return {store,sender,codex,claude,reg,advance:(ms:number)=>{time+=ms;}};
}
const optInBoth=(f:ReturnType<typeof fixture>)=>{
 f.store.optIn(f.codex,{harness:"codex",host_session_id:"01a0da28-f06c-7a62-b236-cf37ef228046"});
 f.store.optIn(f.claude,{harness:"claude-desktop",host_session_id:"local_a7661a7f-932d-4a9a-aee7-eacd33e50365"});
};

describe("wake-ups are opt-in and separate from delivery",()=>{
 test("mail to a peer that has not opted in is never claimed for waking",()=>{
  const f=fixture();f.store.send(f.sender,f.codex,"hi");
  expect(f.store.claimWakes()).toEqual([]);
 });
 test("opted-in recipient with never-offered mail is claimed once, as one batch per recipient",()=>{
  const f=fixture();optInBoth(f);
  const a=f.store.send(f.sender,f.codex,"one").id,b=f.store.send(f.sender,f.codex,"two").id,c=f.store.send(f.sender,f.claude,"three").id;
  const batches=f.store.claimWakes();
  expect(batches).toEqual([
   {peer_id:f.codex,harness:"codex",host_session_id:"01a0da28-f06c-7a62-b236-cf37ef228046",message_ids:[a,b]},
   {peer_id:f.claude,harness:"claude-desktop",host_session_id:"local_a7661a7f-932d-4a9a-aee7-eacd33e50365",message_ids:[c]},
  ]);
  expect(f.store.claimWakes()).toEqual([]);
 });
 test("mail already offered by a hook is not woken: the recipient is active",()=>{
  const f=fixture();optInBoth(f);f.store.send(f.sender,f.codex,"x");f.store.poll(f.codex);
  expect(f.store.claimWakes()).toEqual([]);
 });
 test("waking never acknowledges or offers the message",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");
  f.store.markWoken(f.store.claimWakes()[0]!.message_ids,true);
  expect(f.store.db.query("SELECT delivered,offer_count,acknowledged_at FROM messages WHERE id=?").get(id)).toEqual({delivered:0,offer_count:0,acknowledged_at:null});
  expect(f.store.poll(f.codex).map(m=>m.id)).toEqual([id]);
 });
});

describe("retry, receipt timeout and give-up",()=>{
 test("a successful wake is not repeated until the receipt timeout passes with the mail still unseen",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");
  f.store.markWoken([id],true);f.advance(5*60_000);
  expect(f.store.claimWakes()).toEqual([]);
  f.advance(6*60_000);
  expect(f.store.claimWakes().map(b=>b.message_ids)).toEqual([[id]]);
 });
 test("a woken message the recipient then fetched is never re-woken",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");
  f.store.markWoken(f.store.claimWakes()[0]!.message_ids,true);f.store.poll(f.codex);f.advance(60*60_000);
  expect(f.store.claimWakes()).toEqual([]);expect(id).toBeGreaterThan(0);
 });
 test("failed wakes back off, stop after 3 attempts and surface as needing attention",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");
  for(let attempt=1;attempt<=3;attempt++){
   const claimed=f.store.claimWakes();expect(claimed.map(b=>b.message_ids)).toEqual([[id]]);
   f.store.markWoken([id],false,`codex queue exit 1 (#${attempt})`);
   expect(f.store.claimWakes()).toEqual([]);
   f.advance(10*60_000);
  }
  expect(f.store.claimWakes()).toEqual([]);
  expect(f.store.wakeAttention().map(m=>({id:m.id,wake_attempts:m.wake_attempts,wake_error:m.wake_error}))).toEqual([{id,wake_attempts:3,wake_error:"codex queue exit 1 (#3)"}]);
 });
 test("an expired claim that was never reported is retried after its lease",()=>{
  const f=fixture();optInBoth(f);f.store.send(f.sender,f.codex,"x");
  expect(f.store.claimWakes()).toHaveLength(1);f.advance(30_000);
  expect(f.store.claimWakes()).toEqual([]);f.advance(40_000);
  expect(f.store.claimWakes()).toHaveLength(1);
 });
});

describe("recipient controls and loop guards",()=>{
 test("opt-out and do-not-disturb suppress wakes without touching mail",()=>{
  const f=fixture();optInBoth(f);f.store.send(f.sender,f.codex,"x");f.store.send(f.sender,f.claude,"y");
  f.store.optOut(f.codex);f.store.setDnd(f.claude,60_000);
  expect(f.store.claimWakes()).toEqual([]);
  f.advance(61_000);expect(f.store.claimWakes().map(b=>b.peer_id)).toEqual([f.claude]);
  expect(f.store.poll(f.codex,true)).toHaveLength(1);
 });
 test("at most 20 wakes per recipient per hour; excess waits, it is not dropped",()=>{
  const f=fixture();optInBoth(f);
  for(let i=0;i<21;i++){f.store.send(f.sender,f.codex,`m${i}`);const b=f.store.claimWakes();if(i<20)expect(b).toHaveLength(1);else expect(b).toEqual([]);f.store.markWoken(b.flatMap(x=>x.message_ids),true);f.advance(31_000);}
  f.advance(60*60_000);expect(f.store.claimWakes()).toHaveLength(1);
 });
 test("wakes to one recipient are at least 30 seconds apart; new mail coalesces into the next batch",()=>{
  const f=fixture();optInBoth(f);const a=f.store.send(f.sender,f.codex,"a").id;
  f.store.markWoken(f.store.claimWakes()[0]!.message_ids,true);
  const b=f.store.send(f.sender,f.codex,"b").id,c=f.store.send(f.sender,f.codex,"c").id;
  expect(f.store.claimWakes()).toEqual([]);f.advance(31_000);
  expect(f.store.claimWakes().map(x=>x.message_ids)).toEqual([[b,c]]);expect(a).toBeLessThan(b);
 });
 test("a batch names at most 20 messages",()=>{
  const f=fixture();optInBoth(f);for(let i=0;i<25;i++)f.store.send(f.sender,f.codex,`m${i}`);
  expect(f.store.claimWakes()[0]!.message_ids).toHaveLength(20);
 });
});

describe("registration of wake identity",()=>{
 test("opt-in rejects unknown harnesses and malformed host session ids",()=>{
  const f=fixture();
  expect(()=>f.store.optIn(f.codex,{harness:"slack" as any,host_session_id:"x"})).toThrow("harness");
  expect(()=>f.store.optIn(f.codex,{harness:"codex",host_session_id:"; rm -rf /"})).toThrow("host session");
  expect(()=>f.store.optIn(f.claude,{harness:"claude-desktop",host_session_id:"01a0da28-f06c-7a62-b236-cf37ef228046"})).toThrow("host session");
 });
 test("re-registration of the same process keeps its opt-in",()=>{
  const f=fixture();optInBoth(f);expect(f.reg(2)).toBe(f.codex);f.store.send(f.sender,f.codex,"x");
  expect(f.store.claimWakes()).toHaveLength(1);
 });
});

describe("threading for the dashboard",()=>{
 test("reply_to is stored and must reference a message in the same conversation",()=>{
  const f=fixture();const q=f.store.send(f.sender,f.codex,"question").id;
  const a=f.store.send(f.codex,f.sender,"answer",q).id;
  expect(f.store.db.query("SELECT reply_to FROM messages WHERE id=?").get(a)).toEqual({reply_to:q});
  expect(()=>f.store.send(f.claude,f.sender,"not in that conversation",q)).toThrow("reply_to");
  expect(()=>f.store.send(f.codex,f.sender,"dangling",999999)).toThrow("reply_to");
 });
});
