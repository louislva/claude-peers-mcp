import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root=import.meta.dir,dir=mkdtempSync(join(tmpdir(),"peers-integration-")),dbPath=join(dir,"broker.db");
const reservation=Bun.serve({port:0,fetch:()=>new Response()});const port=reservation.port;reservation.stop(true);
const env={PATH:process.env.PATH!,HOME:dir,CLAUDE_PEERS_PORT:String(port),CLAUDE_PEERS_DB:dbPath};
let broker:ReturnType<typeof Bun.spawn>;const clients:Client[]=[];
const url=`http://127.0.0.1:${port}`;
async function post(path:string,body:unknown){const r=await fetch(url+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});if(!r.ok)throw new Error(await r.text());return r.json() as Promise<any>;}
async function start(){
 broker=Bun.spawn([process.execPath,join(root,"broker.ts")],{env,stdout:"ignore",stderr:"pipe"});
 for(let i=0;i<100;i++){try{const r=await fetch(url+"/health");if(r.ok)return;}catch{}await Bun.sleep(20);}
 throw new Error("Test broker failed to start");
}
beforeAll(start);
afterAll(async()=>{for(const c of clients)await c.close();broker.kill();await broker.exited;rmSync(dir,{recursive:true,force:true});});
async function client(){
 const c=new Client({name:"test-gui",version:"1"},{capabilities:{}});
 await c.connect(new StdioClientTransport({command:process.execPath,args:[join(root,"server.ts")],cwd:root,env,stderr:"pipe"}));clients.push(c);return c;
}
const text=(r:any)=>(r.content ?? []).map((c:any)=>c.text ?? "").join("\n");
async function hook(session:string,event="PostToolUse",active=false,extra:Record<string,unknown>={}){
 const p=Bun.spawn([process.execPath,join(root,"hooks/inbox-hook.ts"),event==="Stop" ? "stop":"context"],{env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
 p.stdin.write(JSON.stringify({session_id:session,hook_event_name:event,stop_hook_active:active,...extra}));p.stdin.end();
 const out=await new Response(p.stdout).text();expect(await p.exited).toBe(0);return out ? JSON.parse(out):null;
}

test("MCP receipt contract and GUI hooks isolate sibling tasks sharing cwd/parent",async()=>{
 const a=await client(),b=await client();
 expect((await a.listTools()).tools.some(t=>t.name==="acknowledge_messages")).toBe(true);
 expect((await hook("gui-b")).hookSpecificOutput.additionalContext).toContain("[session:gui-b]");
 expect((await b.callTool({name:"set_summary",arguments:{summary:"[session:gui-b] receiver"}})).isError).not.toBe(true);
 await a.callTool({name:"bind_session",arguments:{session_key:"gui-a"}});
 const pa=(await post("/resolve-session",{session_key:"gui-a"})).peer;
 const pb=(await post("/resolve-session",{session_key:"gui-b"})).peer;
 expect(pa.id).not.toBe(pb.id);
 const send=await a.callTool({name:"send_message",arguments:{to_id:pb.id,message:"integration finding"}});expect(send.isError).not.toBe(true);
 expect(await hook("gui-a")).toBeNull();
 expect(await hook("gui-b","PostToolUse",false,{agent_id:"child"})).toBeNull();
 expect(await hook("gui-b","PostToolUse",false,{model:"test",transcript_path:"/sessions/rollout-child.jsonl"})).toBeNull();
 const output=await hook("gui-b");expect(output.hookSpecificOutput.hookEventName).toBe("PostToolUse");
 expect(output.hookSpecificOutput.additionalContext).toContain("integration finding");
 expect(output.decision).toBeUndefined(); // never replace the real tool output
 const db=new Database(dbPath,{readonly:true});
 const row=db.query("SELECT id,delivered,acknowledged_at FROM messages WHERE to_id=?").get(pb.id) as any;
 expect(row.delivered).toBe(0);expect(row.acknowledged_at).toBeNull();
 expect(text(await b.callTool({name:"check_messages",arguments:{}}))).toContain(`Message #${row.id}`);
 const wrong=await a.callTool({name:"acknowledge_messages",arguments:{message_ids:[row.id]}});expect(wrong.isError).toBe(true);
 expect((await b.callTool({name:"acknowledge_messages",arguments:{message_ids:[row.id]}})).isError).not.toBe(true);
 expect(await hook("gui-b")).toBeNull();
 const stopMessage=await post("/send-message",{from_id:pa.id,to_id:pb.id,text:"stop finding"});
 expect(await hook("gui-b","Stop",true)).toBeNull();
 expect((await hook("gui-b","Stop")).reason).toContain("stop finding");
 expect(db.query("SELECT delivered FROM messages WHERE id=?").get(stopMessage.id)).toEqual({delivered:0});
 await post("/ack-messages",{id:pb.id,message_ids:[stopMessage.id]});
 db.close();
},15000);

test("legacy client gets receipt IDs; broker restart retains fetched unacknowledged mail",async()=>{
 const a=await post("/register",{pid:process.pid,cwd:root,git_root:null,tty:null,summary:"legacy"});
 const sent=await post("/send-message",{from_id:"cli",to_id:a.id,text:"retain after offered"});
 const response=await post("/poll-messages",{id:a.id});
 expect(response.messages[0].text).toContain(`receipt IDs: ${sent.id}`);
 expect(response.messages[0].text).toContain(" ack ");
 broker.kill();await broker.exited;await start();
 expect((await post("/poll-messages",{id:a.id,protocol:2,force:true})).messages.map((m:any)=>m.id)).toEqual([sent.id]);
 await post("/ack-messages",{id:a.id,message_ids:[sent.id]});
},15000);
