#!/usr/bin/env bun
import { PeerStore } from "./shared/store.ts";
import { receiptEnvelope } from "./shared/receipts.ts";

const PORT = Number(process.env.CLAUDE_PEERS_PORT ?? "7899");
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const store = new PeerStore(DB_PATH);
setInterval(()=>store.cleanStale(),30000).unref();

const server = Bun.serve({
  port:PORT, hostname:"127.0.0.1",
  async fetch(req): Promise<Response> {
    const path=new URL(req.url).pathname;
    if (req.method==="GET" && path==="/health") return Response.json({status:"ok",protocol:2,version:"0.2.0",pid:process.pid,port:server.port,peers:store.list("machine").length});
    if (req.method!=="POST") return Response.json({error:"not found"},{status:404});
    try {
      const body=await req.json() as Record<string,any>;
      if (!body || typeof body!=="object" || Array.isArray(body)) throw new Error("Expected an object");
      switch(path) {
        case "/register": return Response.json(store.register(body as any));
        case "/heartbeat": store.heartbeat(body.id); return Response.json({ok:true});
        case "/set-summary": return Response.json(store.setSummary(body.id,body.summary));
        case "/list-peers": return Response.json(store.list(body.scope,body.cwd,body.git_root,body.exclude_id,body.include_offline===true));
        case "/send-message": return Response.json(store.send(body.from_id,body.to_id,body.text));
        case "/poll-messages": {
          const messages=store.poll(body.id,body.force===true);
          // Old clients omit IDs. Include a receipt envelope for CLI ACKs.
          return Response.json({messages:body.protocol===2 ? messages : messages.map(m=>({...m,text:receiptEnvelope([m],store.peer(body.id).id)}))});
        }
        case "/ack-messages": return Response.json(store.acknowledge(body.id,body.message_ids));
        case "/bind-session": return Response.json(store.bindSession(body.id,body.session_key));
        case "/resolve-session": return Response.json({peer:store.resolveSession(body.session_key)});
        case "/recover-inbox": return Response.json(store.recover(body.from_id,body.id));
        case "/unregister": store.unregister(body.id); return Response.json({ok:true});
        default: return Response.json({error:"not found"},{status:404});
      }
    } catch(e) { return Response.json({error:e instanceof Error ? e.message:String(e)},{status:400}); }
  }
});
console.error(`[claude-peers broker] protocol 2 listening on 127.0.0.1:${server.port}`);
