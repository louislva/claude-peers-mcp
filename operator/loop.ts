#!/usr/bin/env bun
/**
 * claude-peers operator watch loop, run and restarted by the watch.ts
 * supervisor (the Monitor command). It prints NOTHING while idle, wakes Codex recipients
 * itself, and prints one "WAKE claude-desktop <local_id> <ids>" line per
 * Claude recipient (the operator model then calls SendMessage and
 * `bun cli.ts mark-woken`). "UNDELIVERED" lines name any recent message that
 * has not reached its recipient, with the reason: the operator must act.
 *
 *   bun operator/loop.ts           # loop every 2s (normally via watch.ts)
 *   bun operator/loop.ts --once    # single pass (tests, manual runs)
 */
import { runWakeCycle } from "./cycle.ts";
import { superviseDelivery } from "./supervise.ts";
import { resolveAddress, liveEvidence } from "./address.ts";
import type { WakeBatch, DeliveryProblem } from "../shared/store.ts";

const BROKER=`http://127.0.0.1:${process.env.CLAUDE_PEERS_PORT ?? "7899"}`;
async function post<T>(path:string,body:unknown={}):Promise<T>{
  const r=await fetch(BROKER+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
  if(!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`);
  return r.json() as Promise<T>;
}
const deps={
  claim:async()=>(await post<{batches:WakeBatch[]}>("/claim-wakes")).batches,
  mark:async(ids:number[],ok:boolean,error?:string,attemptId?:number,permanent?:boolean)=>{await post("/mark-woken",{message_ids:ids,ok,error,attempt_id:attemptId,permanent});},
  spawn:async(argv:string[])=>{
    const p=Bun.spawn(argv,{stdout:"ignore",stderr:"pipe"});
    const timer=setTimeout(()=>p.kill(),60_000);
    const exitCode=await p.exited;clearTimeout(timer);
    return {exitCode,stderr:await new Response(p.stderr).text()};
  },
  emit:(line:string)=>console.log(line),
  recheck:async(host:string,ids:number[],attemptId?:number)=>(await post<{message_ids:number[]}>("/recheck-wake",{host_session_id:host,message_ids:ids,attempt_id:attemptId})).message_ids,
  codexBin:process.env.CODEX_BIN ?? "/opt/homebrew/bin/codex",
  selfHostId:process.env.CLAUDE_CODE_HOST_SESSION_ID,
};
const seen=new Set<string>();
const supervise={
  peer:async(id:string)=>(await post<{id:string,pid:number,session_key:string|null}[]>("/list-peers",{scope:"machine",cwd:"/",git_root:null,include_offline:true})).find(p=>p.id===id) ?? null,
  resolve:(peer:{pid:number,session_key:string|null})=>resolveAddress(peer,liveEvidence),
  whyUnreachable:(peer:{pid:number,session_key:string|null})=>peer.session_key && liveEvidence.codexThreadArchived?.(peer.session_key) ? "Codex thread is archived; unarchive it or re-address the message":null,
  autoWake:(id:string,address:{harness:string,host_session_id:string})=>post<{wake_policy:string}>("/auto-wake",{id,...address}),
  send:async(to:string,text:string,replyTo:number)=>{await post("/send-message",{from_id:"operator",to_id:to,text,reply_to:replyTo});},
  emit:(line:string)=>console.log(line),
  markReported:async(id:number,reason:string)=>{await post("/mark-problem-reported",{message_id:id,reason});},
};
async function pass(){
  await runWakeCycle(deps);
  // The ledger: every recent message that has not arrived. Connect what can be
  // proven, bounce to the caller, and hand the rest to the operator model.
  const {problems}=await post<{problems:DeliveryProblem[]}>("/delivery-problems");
  await superviseDelivery(problems,supervise as any,seen);
  // Alerts, never gates: the operator pushes these to Kiel's phone.
  const {alerts}=await post<{alerts:{kind:string,id:string,count:number,participants?:string[]}[]}>("/activity-alerts");
  for(const a of alerts) console.log(a.kind==="conversation"
    ? `ACTIVITY conversation #${a.id} reached ${a.count} messages among ${(a.participants??[]).join(", ")}`
    : `ACTIVITY peer ${a.id} was rung ${a.count} times in the last hour`);
}
// Self-reload (open item 7): if any watcher/broker-client source changes, exit
// RELOAD_EXIT and the watch.ts supervisor restarts us on the new code. The
// operator model is not in this path. Each pass leaves a stamp for the
// operator's heartbeat (health.ts) to prove the loop is alive.
import { statSync, readdirSync, writeFileSync } from "node:fs";
import { PASS_STAMP } from "./health.ts";
const RELOAD_EXIT=75; // mirrors watch.ts
const SUPERVISOR_PID=Number(process.env.CLAUDE_PEERS_SUPERVISOR_PID ?? 0);
const ROOT=new URL("..",import.meta.url).pathname;
const sources=()=>["operator","shared"].flatMap(d=>readdirSync(ROOT+d).filter(f=>f.endsWith(".ts")&&!f.endsWith(".test.ts")).map(f=>`${ROOT}${d}/${f}`));
const stamp=()=>sources().map(f=>`${f}:${statSync(f).mtimeMs}`).join("|");
const startedWith=stamp();
if(process.argv.includes("--once")) await pass();
else for(;;){
  try{await pass();writeFileSync(PASS_STAMP,JSON.stringify({pid:process.pid,at:Date.now()}));}catch(e){console.error(String(e));}
  if(stamp()!==startedWith) process.exit(RELOAD_EXIT);
  // Supervisor died: never ring as an orphan (an orphan also holds Monitor's
  // stdout open, hiding the outage). Bun caches process.ppid, so probe the pid.
  if(SUPERVISOR_PID){try{process.kill(SUPERVISOR_PID,0);}catch{process.exit(0);}}
  await Bun.sleep(2000);
}
