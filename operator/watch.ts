#!/usr/bin/env bun
/**
 * claude-peers operator watch loop. Run it as the Claude operator session's
 * Monitor command: it prints NOTHING while idle, wakes Codex recipients
 * itself, and prints one "WAKE claude-desktop <local_id> <ids>" line per
 * Claude recipient (the operator model then calls SendMessage and
 * `bun cli.ts mark-woken`). "UNDELIVERED" lines name any recent message that
 * has not reached its recipient, with the reason: the operator must act.
 *
 *   bun operator/watch.ts          # loop every 2s
 *   bun operator/watch.ts --once   # single pass (tests, manual runs)
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
}
if(process.argv.includes("--once")) await pass();
else for(;;){
  try{await pass();}catch(e){console.error(String(e));}
  await Bun.sleep(2000);
}
