import { expect, test } from "bun:test";
import { superviseDelivery, bounceText, type SuperviseDeps } from "./supervise.ts";
import type { DeliveryProblem } from "../shared/store.ts";

function deps(over:Partial<SuperviseDeps>={}){
 const log={autoWake:[] as any[],sent:[] as any[],emitted:[] as string[]};
 const d:SuperviseDeps={
  peer:async id=>({id,pid:10,session_key:"54dff50f-c90d-4972-b988-e1fa7da1e819"}),
  resolve:()=>({harness:"claude-desktop",host_session_id:"local_2afc162d-c5db-4ebe-b6ed-6f799f288662"}),
  autoWake:async(id,a)=>{log.autoWake.push([id,a]);return {wake_policy:"on"};},
  send:async(to,text,replyTo)=>{log.sent.push([to,text,replyTo]);},
  emit:l=>log.emitted.push(l),
  markReported:async()=>{},
  ...over};
 return {d,log,seen:new Set<string>()};
}
const P=(reason:string,extra:Partial<DeliveryProblem>={}):DeliveryProblem=>({message_id:7,from_id:"sender1",to_id:"rcpt1",reason,...extra});

test("a recipient with no address on file is found from evidence and connected, silently",async()=>{
 const {d,log,seen}=deps();await superviseDelivery([P("no-wake-address")],d,seen);
 expect(log.autoWake).toEqual([["rcpt1",{harness:"claude-desktop",host_session_id:"local_2afc162d-c5db-4ebe-b6ed-6f799f288662"}]]);
 expect(log.emitted).toEqual([]);expect(log.sent).toEqual([]);
});
test("if the address cannot be proven, the operator is told once and the sender gets a bounce",async()=>{
 const {d,log,seen}=deps({resolve:()=>null});
 await superviseDelivery([P("no-wake-address")],d,seen);await superviseDelivery([P("no-wake-address")],d,seen);
 expect(log.emitted).toEqual(["UNDELIVERED message #7 to rcpt1: no-wake-address (no Claude desktop or Codex address could be proven for this peer)"]);
 expect(log.sent).toEqual([["sender1",bounceText(7,"rcpt1","no-wake-address","no Claude desktop or Codex address could be proven for this peer"),7]]);
});
test("failed wakes bounce to the sender with the concrete error",async()=>{
 const {d,log,seen}=deps();await superviseDelivery([P("wake-failed",{detail:"session 01a0 is archived"})],d,seen);
 expect(log.sent[0][1]).toContain("session 01a0 is archived");
 expect(log.emitted).toEqual(["UNDELIVERED message #7 to rcpt1: wake-failed (session 01a0 is archived)"]);
});
test("an opted-out recipient is respected: no connect attempt, sender told",async()=>{
 const {d,log,seen}=deps();await superviseDelivery([P("recipient-opted-out")],d,seen);
 expect(log.autoWake).toEqual([]);expect(log.sent).toHaveLength(1);
});
test("never bounce to the CLI or to the operator itself (no bounce loops)",async()=>{
 const {d,log,seen}=deps();
 await superviseDelivery([P("wake-failed",{from_id:"cli"}),P("wake-failed",{message_id:8,from_id:"operator"})],d,seen);
 expect(log.sent).toEqual([]);expect(log.emitted).toHaveLength(2);
});
test("woken but not picked up goes to the operator model to ring again by hand",async()=>{
 const {d,log,seen}=deps();await superviseDelivery([P("woken-not-picked-up")],d,seen);
 expect(log.emitted).toEqual(["UNDELIVERED message #7 to rcpt1: woken-not-picked-up"]);expect(log.sent).toEqual([]);
});

test("a failing bounce is reported as an operator error and retried, and does not stop the ledger",async()=>{
 const {d,log,seen}=deps({send:async()=>{throw new Error("broker 400");}});
 await superviseDelivery([P("wake-failed"),P("recipient-opted-out",{message_id:9})],d,seen);
 expect(log.emitted.filter(l=>l.startsWith("OPERATOR-ERROR"))).toHaveLength(2);
 expect(seen.size).toBe(0);
});

test("an already-reported unaddressed recipient keeps being connected when evidence appears, without repeat reports",async()=>{
 const {d,log,seen}=deps({resolve:()=>null});
 await superviseDelivery([P("no-wake-address",{already_reported:true})],d,seen);
 expect(log.emitted).toEqual([]);expect(log.sent).toEqual([]);
 const ok=deps();await superviseDelivery([P("no-wake-address",{already_reported:true})],ok.d,ok.seen);
 expect(ok.log.autoWake).toHaveLength(1);
});
