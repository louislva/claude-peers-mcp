import { expect, test } from "bun:test";
import { resolveAddress, codexThreadExistsIn, codexThreadArchivedIn } from "./address.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env=(m:Record<number,string>)=>(pid:number)=>m[pid]??"";
test("a Claude desktop peer's address is read from its MCP server's own environment",()=>{
 expect(resolveAddress({pid:24947,session_key:"54dff50f-c90d-4972-b988-e1fa7da1e819"},{processEnv:env({24947:"bun /x/server.ts CLAUDE_CODE_SESSION_ID=54dff50f-c90d-4972-b988-e1fa7da1e819 CLAUDE_CODE_HOST_SESSION_ID=local_2afc162d-c5db-4ebe-b6ed-6f799f288662 HOME=/u"}),codexThreadExists:()=>false}))
  .toEqual({harness:"claude-desktop",host_session_id:"local_2afc162d-c5db-4ebe-b6ed-6f799f288662"});
});
test("a Codex peer's address is its bound thread id, proven by the thread's rollout file",()=>{
 expect(resolveAddress({pid:22395,session_key:"01a0da49-dc8f-7420-bf85-feeeb7bdd0fb"},{processEnv:env({}),codexThreadExists:k=>k==="01a0da49-dc8f-7420-bf85-feeeb7bdd0fb"}))
  .toEqual({harness:"codex",host_session_id:"01a0da49-dc8f-7420-bf85-feeeb7bdd0fb"});
});
test("the env address must belong to the same session the peer is bound to",()=>{
 expect(resolveAddress({pid:1,session_key:"aaaaaaaa-0000-0000-0000-000000000000"},{processEnv:env({1:"CLAUDE_CODE_SESSION_ID=bbbbbbbb-0000-0000-0000-000000000000 CLAUDE_CODE_HOST_SESSION_ID=local_2afc162d-c5db-4ebe-b6ed-6f799f288662"}),codexThreadExists:()=>false})).toBeNull();
});
test("no evidence, no address: the operator never guesses",()=>{
 expect(resolveAddress({pid:5,session_key:null},{processEnv:env({}),codexThreadExists:()=>true})).toBeNull();
 expect(resolveAddress({pid:5,session_key:"not-a-thread"},{processEnv:env({}),codexThreadExists:()=>true})).toBeNull();
});

test("Codex thread lookup survives stray files like .DS_Store at any level",()=>{
 const root=mkdtempSync(join(tmpdir(),"codex-sessions-"));
 writeFileSync(join(root,".DS_Store"),"x");mkdirSync(join(root,"2026","09","23"),{recursive:true});
 writeFileSync(join(root,"2026",".DS_Store"),"x");
 writeFileSync(join(root,"2026","09","23","rollout-2026-09-23T15-12-45-01a0cfaf-460b-7ff3-a3b3-b7fc168b74f1.jsonl"),"{}");
 expect(codexThreadExistsIn(root,"01a0cfaf-460b-7ff3-a3b3-b7fc168b74f1")).toBe(true);
 expect(codexThreadExistsIn(root,"01a0cfaf-460b-7ff3-a3b3-b7fc168b74f2")).toBe(false);
 expect(codexThreadExistsIn(root,"*")).toBe(false);
});

test("archived Codex threads are recognised in flat and dated archive layouts",()=>{
 const root=mkdtempSync(join(tmpdir(),"codex-archived-"));
 writeFileSync(join(root,"rollout-2026-09-25T15-00-00-01a0d945-603a-7ba2-966c-839900d44ca6.jsonl"),"{}");
 mkdirSync(join(root,"2026","09","25"),{recursive:true});
 writeFileSync(join(root,"2026","09","25","rollout-x-01a0da28-f06c-7a62-b236-cf37ef228046.jsonl"),"{}");
 expect(codexThreadArchivedIn(root,"01a0d945-603a-7ba2-966c-839900d44ca6")).toBe(true);
 expect(codexThreadArchivedIn(root,"01a0da28-f06c-7a62-b236-cf37ef228046")).toBe(true);
 expect(codexThreadArchivedIn(root,"01a0cfaf-460b-7ff3-a3b3-b7fc168b74f1")).toBe(false);
});
