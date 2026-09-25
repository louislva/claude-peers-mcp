#!/usr/bin/env bun
/**
 * claude-peers operator watch loop. Run it as the Claude operator session's
 * Monitor command: it prints NOTHING while idle, wakes Codex recipients
 * itself, and prints one "WAKE claude-desktop <local_id> <ids>" line per
 * Claude recipient (the operator model then calls SendMessage and
 * `bun cli.ts mark-woken`). "ATTENTION" lines flag mail whose wakes failed 3x.
 *
 *   bun operator/watch.ts          # loop every 2s
 *   bun operator/watch.ts --once   # single pass (tests, manual runs)
 */
import { runWakeCycle } from "./cycle.ts";
import type { Message } from "../shared/types.ts";
import type { WakeBatch } from "../shared/store.ts";

const BROKER=`http://127.0.0.1:${process.env.CLAUDE_PEERS_PORT ?? "7899"}`;
async function post<T>(path:string,body:unknown={}):Promise<T>{
  const r=await fetch(BROKER+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
  if(!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`);
  return r.json() as Promise<T>;
}
const deps={
  claim:async()=>(await post<{batches:WakeBatch[]}>("/claim-wakes")).batches,
  mark:async(ids:number[],ok:boolean,error?:string)=>{await post("/mark-woken",{message_ids:ids,ok,error});},
  spawn:async(argv:string[])=>{
    const p=Bun.spawn(argv,{stdout:"ignore",stderr:"pipe"});
    const timer=setTimeout(()=>p.kill(),60_000);
    const exitCode=await p.exited;clearTimeout(timer);
    return {exitCode,stderr:await new Response(p.stderr).text()};
  },
  emit:(line:string)=>console.log(line),
  codexBin:process.env.CODEX_BIN ?? "/opt/homebrew/bin/codex",
  selfHostId:process.env.CLAUDE_CODE_HOST_SESSION_ID,
};
const flagged=new Set<number>();
async function pass(){
  await runWakeCycle(deps);
  for(const m of (await post<{messages:Message[]}>("/wake-attention")).messages){
    if(flagged.has(m.id)) continue; flagged.add(m.id);
    console.log(`ATTENTION message #${m.id} to ${m.to_id}: ${m.wake_attempts} wake attempts failed (${m.wake_error ?? "no error recorded"})`);
  }
}
if(process.argv.includes("--once")) await pass();
else for(;;){
  try{await pass();}catch(e){console.error(String(e));}
  await Bun.sleep(2000);
}
