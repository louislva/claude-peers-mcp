#!/usr/bin/env bun
/**
 * claude-peers read-only dashboard (open item 6).
 *   bun operator/dashboard.ts            -> http://127.0.0.1:7897
 * Opens the broker DB READ-ONLY; delivery problems come from the broker API.
 * Local boundary: binds 127.0.0.1, rejects non-local Host headers (DNS
 * rebinding), GET only, strict CSP (no scripts, no remote loads).
 */
import { Database } from "bun:sqlite";
import { renderPage } from "./dashboard-render.ts";

const PORT=Number(process.env.CLAUDE_PEERS_DASHBOARD_PORT ?? "7897");
const DB_PATH=process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const BROKER=`http://127.0.0.1:${process.env.CLAUDE_PEERS_PORT ?? "7899"}`;
const db=new Database(DB_PATH,{readonly:true});

async function brokerProblems(){
  try{const r=await fetch(BROKER+"/delivery-problems",{method:"POST",headers:{"content-type":"application/json"},body:"{}",signal:AbortSignal.timeout(3000)});return r.ok?(await r.json()).problems:[];}
  catch{return [];}
}
const server=Bun.serve({port:PORT,hostname:"127.0.0.1",async fetch(req){
  const url=new URL(req.url);
  const host=(req.headers.get("host")??"").split(":")[0];
  if(!["127.0.0.1","localhost"].includes(host)) return new Response("forbidden host",{status:403});
  if(req.method!=="GET") return new Response("read-only",{status:405});
  if(url.pathname!=="/") return new Response("not found",{status:404});
  const all=url.searchParams.get("all")==="1";
  const since=new Date(Date.now()-(all?3650:1)*24*3600_000).toISOString();
  const messages=db.query(`SELECT id,from_id,to_id,text,sent_at,offer_count,delivered,acknowledged_at,reply_to,root_id,hop,woken_at,wake_attempts,wake_error
    FROM messages WHERE sent_at>=? ORDER BY id DESC LIMIT 500`).all(since) as any[];
  const peers=db.query("SELECT id,online,harness,wake_policy,wake_choice,dnd_until,summary,last_seen FROM peers ORDER BY last_seen DESC").all() as any[];
  const attempts=db.query("SELECT id,peer_id,message_ids,status,claimed_at,finished_at,error FROM wake_attempts ORDER BY id DESC LIMIT 30").all() as any[];
  const html=renderPage({messages,peers,attempts,problems:await brokerProblems(),
    filter:{peer:url.searchParams.get("peer")??undefined,root:url.searchParams.get("root")??undefined},generatedAt:new Date().toISOString()});
  return new Response(html,{headers:{"content-type":"text/html; charset=utf-8",
    "content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "x-content-type-options":"nosniff","referrer-policy":"no-referrer","cache-control":"no-store"}});
}});
console.error(`[claude-peers dashboard] read-only on http://127.0.0.1:${server.port}`);
