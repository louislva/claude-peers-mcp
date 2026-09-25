import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeerStore, WAKE_DEFAULTS } from "./store.ts";

const dirs:string[]=[]; const stores:PeerStore[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.db.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),"peers-wake-"));dirs.push(dir);
 let time=1_000_000;
 const store=new PeerStore(join(dir,"t.db"),pid=>pid>0,()=>time);stores.push(store);
 const reg=(pid:number)=>store.register({pid,cwd:"/p",git_root:null,tty:null,summary:"",pid_start:`b${pid}`}).id;
 const sender=reg(1),codex=reg(2),claude=reg(3);
 return {store,sender,codex,claude,reg,now:()=>time,advance:(ms:number)=>{time+=ms;}};
}
/** Claim and report every batch through its own attempt id (the fenced path). */
const ring=(f:ReturnType<typeof fixture>,ok=true,err?:string)=>{const bs=f.store.claimWakes();for(const b of bs)f.store.markWoken(b.message_ids,ok,err,b.attempt_id!);return bs;};
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
   {peer_id:f.codex,harness:"codex",host_session_id:"01a0da28-f06c-7a62-b236-cf37ef228046",message_ids:[a,b],attempt_id:expect.any(Number)},
   {peer_id:f.claude,harness:"claude-desktop",host_session_id:"local_a7661a7f-932d-4a9a-aee7-eacd33e50365",message_ids:[c],attempt_id:expect.any(Number)},
  ]);
  expect(f.store.claimWakes()).toEqual([]);
 });
 test("mail already offered by a hook is not woken: the recipient is active",()=>{
  const f=fixture();optInBoth(f);f.store.send(f.sender,f.codex,"x");f.store.poll(f.codex);
  expect(f.store.claimWakes()).toEqual([]);
 });
 test("waking never acknowledges or offers the message",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");
  ring(f);
  expect(f.store.db.query("SELECT delivered,offer_count,acknowledged_at FROM messages WHERE id=?").get(id)).toEqual({delivered:0,offer_count:0,acknowledged_at:null});
  expect(f.store.poll(f.codex).map(m=>m.id)).toEqual([id]);
 });
});

describe("retry, receipt timeout and give-up",()=>{
 test("a successful wake is not repeated until the receipt timeout passes with the mail still unseen",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");
  ring(f);f.advance(5*60_000);
  expect(f.store.claimWakes()).toEqual([]);
  f.advance(6*60_000);
  expect(f.store.claimWakes().map(b=>b.message_ids)).toEqual([[id]]);
 });
 test("a woken message the recipient fetched AND acknowledged is never re-woken",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");
  ring(f);f.store.poll(f.codex);f.store.acknowledge(f.codex,[id]);f.advance(60*60_000);
  expect(f.store.claimWakes()).toEqual([]);expect(f.store.deliveryProblems()).toEqual([]);
 });
 test("Astra P1: an offer that never reached the model (lost hook output) is not a permanent receipt",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");
  f.store.poll(f.codex);                       // offered, then the hook's output is lost
  f.advance(5*60_000);expect(f.store.claimWakes()).toEqual([]);   // recent offer: recipient may be mid-turn
  f.advance(11*60_000);                        // offered 16 min ago, still unacked
  expect(ring(f).map(b=>b.message_ids)).toEqual([[id]]);
  for(let i=0;i<2;i++){f.advance(11*60_000);expect(ring(f)).toHaveLength(1);}
  f.advance(61*60_000);
  expect(f.store.claimWakes()).toEqual([]);    // bounded: 3 attempts
  expect(f.store.deliveryProblems().map(p=>p.reason)).toEqual(["wake-failed"]);
  expect(f.store.wakeAttention().map(m=>m.id)).toEqual([id]);
 });
 test("failed wakes back off, stop after 3 attempts and surface as needing attention",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");
  for(let attempt=1;attempt<=3;attempt++){
   const claimed=ring(f,false,`codex queue exit 1 (#${attempt})`);expect(claimed.map(b=>b.message_ids)).toEqual([[id]]);
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
  for(let i=0;i<21;i++){f.store.send(f.sender,f.codex,`m${i}`);const b=ring(f);if(i<20)expect(b).toHaveLength(1);else expect(b).toEqual([]);f.advance(31_000);}
  f.advance(60*60_000);expect(f.store.claimWakes()).toHaveLength(1);
 });
 test("wakes to one recipient are at least 30 seconds apart; new mail coalesces into the next batch",()=>{
  const f=fixture();optInBoth(f);const a=f.store.send(f.sender,f.codex,"a").id;
  ring(f);
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

describe("participation is on by default",()=>{
 const id={harness:"claude-desktop" as const,host_session_id:"local_2afc162d-c5db-4ebe-b6ed-6f799f288662"};
 test("a bound session that never chose is opted in automatically",()=>{
  const f=fixture();expect(f.store.autoOptIn(f.claude,id).wake_policy).toBe("on");
  f.store.send(f.sender,f.claude,"x");expect(f.store.claimWakes().map(b=>b.host_session_id)).toEqual([id.host_session_id]);
 });
 test("an explicit opt-out sticks: automatic opt-in never overrides it",()=>{
  const f=fixture();f.store.optOut(f.claude);
  expect(f.store.autoOptIn(f.claude,id).wake_policy).toBe("off");
  f.store.send(f.sender,f.claude,"x");expect(f.store.claimWakes()).toEqual([]);
 });
 test("an explicit opt-in after opting out re-enables and later automatic calls keep it on",()=>{
  const f=fixture();f.store.optOut(f.claude);f.store.optIn(f.claude,id);
  expect(f.store.autoOptIn(f.claude,id).wake_policy).toBe("on");
 });
 test("automatic opt-in refreshes a changed host address for an opted-in session",()=>{
  const f=fixture();f.store.autoOptIn(f.claude,id);
  const moved={harness:"claude-desktop" as const,host_session_id:"local_a7661a7f-932d-4a9a-aee7-eacd33e50365"};
  f.store.autoOptIn(f.claude,moved);f.store.send(f.sender,f.claude,"x");
  expect(f.store.claimWakes()[0]!.host_session_id).toBe(moved.host_session_id);
 });
});

test("a Codex opt-in without a thread id uses the bound session key",()=>{
 const f=fixture();f.store.bindSession(f.codex,"01a0da28-f06c-7a62-b236-cf37ef228046");
 expect(f.store.optIn(f.codex,{harness:"codex"}).host_session_id).toBe("01a0da28-f06c-7a62-b236-cf37ef228046");
 const g=fixture();expect(()=>g.store.optIn(g.codex,{harness:"codex"})).toThrow("host session");
});

describe("the operator answers for every message until it arrives",()=>{
 test("mail to a session with no wake address is reported after a 2-minute grace, with the reason",()=>{
  const f=fixture();const {id}=f.store.send(f.sender,f.codex,"x");
  expect(f.store.deliveryProblems()).toEqual([]);f.advance(121_000);
  expect(f.store.deliveryProblems()).toEqual([{message_id:id,from_id:f.sender,to_id:f.codex,reason:"no-wake-address"}]);
 });
 test("mail to an opted-out recipient is reported as waiting on their choice",()=>{
  const f=fixture();optInBoth(f);f.store.optOut(f.codex);const {id}=f.store.send(f.sender,f.codex,"x");f.advance(121_000);
  expect(f.store.deliveryProblems()).toEqual([{message_id:id,from_id:f.sender,to_id:f.codex,reason:"recipient-opted-out"}]);
 });
 test("exhausted wakes are reported with the last error",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");
  for(let i=0;i<3;i++){ring(f,false,"session is archived");f.advance(5*60_000);}
  expect(f.store.deliveryProblems()).toEqual([{message_id:id,from_id:f.sender,to_id:f.codex,reason:"wake-failed",detail:"session is archived"}]);
 });
 test("mail woken but still not picked up after two receipt timeouts is reported",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.claude,"x");
  ring(f);f.advance(21*60_000);
  expect(f.store.deliveryProblems().map(p=>p.reason)).toEqual(["woken-not-picked-up"]);expect(id).toBeGreaterThan(0);
 });
 test("arrived mail, and old history outside the 24-hour window, are never reported",()=>{
  const f=fixture();optInBoth(f);f.store.send(f.sender,f.codex,"old");f.advance(25*3600_000);
  const {id}=f.store.send(f.sender,f.claude,"new");f.store.poll(f.claude);f.advance(121_000);
  expect(f.store.deliveryProblems()).toEqual([]);expect(id).toBeGreaterThan(0);
 });
});

describe("receipts for the operator's own actions are durable",()=>{
 test("a reported problem is not reported again, even by a fresh watcher; a new reason is",()=>{
  const f=fixture();const {id}=f.store.send(f.sender,f.codex,"x");f.advance(121_000);
  expect(f.store.deliveryProblems()).toHaveLength(1);
  f.store.markProblemReported(id,"no-wake-address");f.store.markProblemReported(id,"no-wake-address");
  expect(f.store.deliveryProblems()).toEqual([{message_id:id,from_id:f.sender,to_id:f.codex,reason:"no-wake-address",already_reported:true}]);
  f.store.optOut(f.codex);expect(f.store.deliveryProblems().map(p=>p.reason)).toEqual(["recipient-opted-out"]);
 });
 test("the operator may thread a bounce onto any message; peers still may not reply to conversations they are not in",()=>{
  const f=fixture();const q=f.store.send(f.sender,f.codex,"q").id;
  expect(f.store.send("operator",f.sender,"bounce",q).id).toBeGreaterThan(q);
  expect(()=>f.store.send(f.claude,f.sender,"no",q)).toThrow("reply_to");
 });
});

describe("revocation is re-checked right before each dispatch (Astra P1)",()=>{
 const host="01a0da28-f06c-7a62-b236-cf37ef228046";
 test("still-eligible ids pass the re-check unchanged",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");const [b]=f.store.claimWakes();
  expect(f.store.recheckWake(host,[id],b!.attempt_id!)).toEqual([id]);
 });
 for (const [name,revoke] of [
  ["opt-out",(f:any)=>f.store.optOut(f.codex)],
  ["DND",(f:any)=>f.store.setDnd(f.codex,60_000)],
  ["ACK",(f:any)=>{f.store.poll(f.codex);f.store.acknowledge(f.codex,f.store.poll(f.codex,true).map((m:any)=>m.id));}],
  ["fresh offer",(f:any)=>f.store.poll(f.codex)],
  ["address change",(f:any)=>f.store.optIn(f.codex,{harness:"codex",host_session_id:"01a0cfaf-460b-7ff3-a3b3-b7fc168b74f1"})],
 ] as const) test(`${name} after the claim drops the id and releases the attempt`,()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");const [b]=f.store.claimWakes();
  revoke(f);
  expect(f.store.recheckWake(host,[id],b!.attempt_id)).toEqual([]);
  expect(f.store.db.query("SELECT wake_attempts,wake_claim_until,wake_claim_attempt FROM messages WHERE id=?").get(id)).toEqual({wake_attempts:0,wake_claim_until:0,wake_claim_attempt:null});
 });
});

describe("every wake attempt has its own durable record (open item 1)",()=>{
 const attempts=(f:any)=>f.store.db.query("SELECT id,peer_id,host_session_id,message_ids,status,error FROM wake_attempts ORDER BY id").all();
 test("a claim creates a 'claimed' attempt and the batch carries its id",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");
  const [b]=f.store.claimWakes();
  expect(b!.attempt_id).toBeGreaterThan(0);
  expect(attempts(f)).toEqual([{id:b!.attempt_id,peer_id:f.codex,host_session_id:"01a0da28-f06c-7a62-b236-cf37ef228046",message_ids:JSON.stringify([id]),status:"claimed",error:null}]);
 });
 test("outcomes are recorded per attempt: dispatched, uncertain, failed; revoked by recheck",()=>{
  const f=fixture();optInBoth(f);
  const out:Record<string,string>={};
  for (const outcome of ["dispatched","uncertain","failed"] as const){
   const {id}=f.store.send(f.sender,f.codex,outcome);const [b]=f.store.claimWakes();
   f.store.markWoken(b!.message_ids,outcome!=="failed",outcome==="failed"?"exit 1":undefined,b!.attempt_id,outcome==="uncertain");
   out[outcome]=(f.store.db.query("SELECT status FROM wake_attempts WHERE id=?").get(b!.attempt_id) as any).status;
   f.advance(31_000);expect(id).toBeGreaterThan(0);
  }
  const {id}=f.store.send(f.sender,f.codex,"r");const [b]=f.store.claimWakes();f.store.optOut(f.codex);
  f.store.recheckWake("01a0da28-f06c-7a62-b236-cf37ef228046",[id],b!.attempt_id);
  out.revoked=(f.store.db.query("SELECT status FROM wake_attempts WHERE id=?").get(b!.attempt_id) as any).status;
  expect(out).toEqual({dispatched:"dispatched",uncertain:"uncertain",failed:"failed",revoked:"revoked"});
 });
 test("an uncertain dispatch still counts as sent for the message (no re-ring until the receipt timeout)",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");const [b]=f.store.claimWakes();
  f.store.markWoken([id],true,undefined,b!.attempt_id,true);f.advance(5*60_000);
  expect(f.store.claimWakes()).toEqual([]);
 });
});

describe("archived threads are permanent (open item 2)",()=>{
 test("a permanent failure exhausts the message's attempts at once and reports wake-failed",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");const [b]=f.store.claimWakes();
  f.store.markWoken([id],false,"session is archived",b!.attempt_id,false,true);
  f.advance(10*60_000);expect(f.store.claimWakes()).toEqual([]);
  expect(f.store.deliveryProblems().map(p=>[p.reason,p.detail])).toEqual([["wake-failed","session is archived"]]);
 });
});

describe("recheck refunds are once-only and claim-scoped (Astra P1, R1.2)",()=>{
 const host="01a0da28-f06c-7a62-b236-cf37ef228046";
 const attemptsOf=(f:any,id:number)=>(f.store.db.query("SELECT wake_attempts FROM messages WHERE id=?").get(id) as any).wake_attempts;
 test("Astra's repro: exhausted failures stay exhausted after opt-out and repeated rechecks",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");
  const ids:number[]=[];for(let i=0;i<3;i++){const [b]=ring(f,false,"x");ids.push(b!.attempt_id!);f.advance(10*60_000);}
  f.store.optOut(f.codex);
  for(const a of [...ids,...ids])expect(f.store.recheckWake(host,[id],a)).toEqual([]);
  expect(attemptsOf(f,id)).toBe(3);
 });
 test("a duplicate recheck (and duplicate ids) refund at most once",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");const [b]=f.store.claimWakes();
  f.store.optOut(f.codex);
  f.store.recheckWake(host,[id,id],b!.attempt_id);f.store.recheckWake(host,[id],b!.attempt_id);
  expect(attemptsOf(f,id)).toBe(0);
 });
 test("a completed or expired claim is never refunded",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");const [b]=f.store.claimWakes();
  f.store.markWoken([id],true,undefined,b!.attempt_id);f.store.optOut(f.codex);
  f.store.recheckWake(host,[id],b!.attempt_id);expect(attemptsOf(f,id)).toBe(1);
  const g=fixture();optInBoth(g);const m=g.store.send(g.sender,g.codex,"y").id;const [c]=g.store.claimWakes();
  g.advance(61_000);g.store.optOut(g.codex);g.store.recheckWake(host,[m],c!.attempt_id);expect(attemptsOf(g,m)).toBe(1);
 });
 test("a stale claimant cannot cancel a newer claim",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");
  const [old]=f.store.claimWakes();f.advance(61_000);          // old claim expires unreported
  const [fresh]=f.store.claimWakes();expect(fresh!.attempt_id).not.toBe(old!.attempt_id);
  f.store.setDnd(f.codex,60_000);
  f.store.recheckWake(host,[id],old!.attempt_id);
  expect(attemptsOf(f,id)).toBe(2);
  expect(f.store.db.query("SELECT wake_claim_attempt FROM messages WHERE id=?").get(id)).toEqual({wake_claim_attempt:fresh!.attempt_id});
 });
});

describe("claim fencing on dispatch and completion (Astra P1, R1.3)",()=>{
 const host="01a0da28-f06c-7a62-b236-cf37ef228046";
 const col=(f:any,id:number,c:string)=>(f.store.db.query(`SELECT ${c} AS v FROM messages WHERE id=?`).get(id) as any).v;
 test("(A) a completed FAILURE is not refunded by a later recheck",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");const [b]=f.store.claimWakes();
  f.store.markWoken([id],false,"exit 1",b!.attempt_id!);f.store.optOut(f.codex);
  expect(f.store.recheckWake(host,[id],b!.attempt_id!)).toEqual([]);
  expect(col(f,id,"wake_attempts")).toBe(1);
 });
 test("(B) a stale claimant can neither dispatch nor complete a newer claim",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");
  const [a]=f.store.claimWakes();f.advance(61_000);const [b]=f.store.claimWakes();
  expect(f.store.recheckWake(host,[id],a!.attempt_id!)).toEqual([]);          // not eligible for A
  expect(f.store.markWoken([id],true,undefined,a!.attempt_id!).marked).toBe(0);  // A's completion is fenced off
  expect(col(f,id,"woken_at")).toBeNull();expect(col(f,id,"wake_claim_attempt")).toBe(b!.attempt_id);
  expect(f.store.recheckWake(host,[id],b!.attempt_id!)).toEqual([id]);
 });
 test("a failure's retry-not-before is not an active claim",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");const [b]=f.store.claimWakes();
  f.store.markWoken([id],false,"exit 1",b!.attempt_id!);
  expect(col(f,id,"wake_claim_attempt")).toBeNull();expect(col(f,id,"wake_claim_until")).toBe(0);
  expect(col(f,id,"wake_retry_after")).toBeGreaterThan(0);
 });
 test("reporting without the claim's attempt id is refused",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");f.store.claimWakes();
  expect(()=>(f.store as any).markWoken([id],true)).toThrow("attempt id");
  expect(()=>(f.store as any).recheckWake(host,[id])).toThrow("attempt id");
 });
});

describe("two watchers on one broker database (open item 4)",()=>{
 test("a batch claimed through one connection can't be claimed through another; either can complete it with the attempt id",()=>{
  const f=fixture();optInBoth(f);const {id}=f.store.send(f.sender,f.codex,"x");
  const other=new PeerStore(f.store.db.filename,pid=>pid>0,()=>f.now());stores.push(other);
  const [a]=f.store.claimWakes();expect(other.claimWakes()).toEqual([]);
  expect(other.markWoken([id],true,undefined,a!.attempt_id!).marked).toBe(1);
  expect(f.store.markWoken([id],true,undefined,a!.attempt_id!).marked).toBe(0);   // duplicate completion: no-op
 });
 test("interleaved claims across connections never overlap",()=>{
  const f=fixture();optInBoth(f);
  const other=new PeerStore(f.store.db.filename,pid=>pid>0,()=>f.now());stores.push(other);
  for(let i=0;i<10;i++)f.store.send(f.sender,i%2?f.codex:f.claude,`m${i}`);
  const seen=[...f.store.claimWakes(),...other.claimWakes()].flatMap(b=>b.message_ids);
  expect(new Set(seen).size).toBe(seen.length);expect(seen).toHaveLength(10);
 });
});

describe("age window (open item 0)",()=>{
 test("mail older than 24 hours is not rung (hooks still deliver it)",()=>{
  const f=fixture();optInBoth(f);f.store.send(f.sender,f.codex,"ancient");f.advance(25*3600_000);
  expect(f.store.claimWakes()).toEqual([]);
  const {id}=f.store.send(f.sender,f.codex,"fresh");expect(f.store.claimWakes().map(b=>b.message_ids)).toEqual([[id]]);
 });
});

describe("causal-chain budget (open item 5)",()=>{
 test("replies carry the conversation root and hop count",()=>{
  const f=fixture();const a=f.store.send(f.sender,f.codex,"q").id;const b=f.store.send(f.codex,f.sender,"a",a).id;const c=f.store.send(f.sender,f.claude,"fwd",b).id;
  expect(f.store.db.query("SELECT id,root_id,hop FROM messages WHERE id IN (?,?,?) ORDER BY id").all(a,b,c)).toEqual([{id:a,root_id:a,hop:0},{id:b,root_id:a,hop:1},{id:c,root_id:a,hop:2}]);
 });
 test("a conversation over its hourly budget stops ringing (mail kept), shows up in the ledger, and a manual release restores it",()=>{
  const f=fixture();optInBoth(f);
  let last=f.store.send(f.sender,f.codex,"start").id;
  for(let i=1;i<WAKE_DEFAULTS.rootBudgetPerHour;i++){last=f.store.send(i%2?f.codex:f.sender,i%2?f.sender:f.codex,`r${i}`,last).id;}
  f.store.db.run("UPDATE messages SET offer_count=1,delivered=1");        // earlier turns were handled
  const over=f.store.send(f.sender,f.codex,"one more",last).id;          // exceeds the budget for this root
  expect(f.store.claimWakes()).toEqual([]);
  f.advance(121_000);
  expect(f.store.deliveryProblems().map(p=>[p.message_id,p.reason])).toEqual([[over,"loop-budget"]]);
  f.store.releaseRoot((f.store.db.query("SELECT root_id FROM messages WHERE id=?").get(over) as any).root_id);
  expect(f.store.claimWakes().map(b=>b.message_ids)).toEqual([[over]]);
 });
});
