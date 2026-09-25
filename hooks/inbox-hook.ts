#!/usr/bin/env bun
/** Session-bound, at-least-once inbox delivery. Never ACK on stdout/socket write. */
import { receiptEnvelope } from "../shared/receipts.ts";
import { hookWakeIdentity } from "../shared/wake-identity.ts";
import type { Message, Peer } from "../shared/types.ts";

const BROKER = `http://127.0.0.1:${process.env.CLAUDE_PEERS_PORT ?? "7899"}`;
const mode = process.argv[2];
if (mode !== "context" && mode !== "stop") process.exit(2);

async function post<T>(path: string, body: unknown): Promise<T> {
  const response=await fetch(BROKER+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(2000)});
  if (!response.ok) throw new Error(`Broker ${response.status}`);
  return response.json() as Promise<T>;
}

let input: Record<string,unknown>={};
try { if (!process.stdin.isTTY) input=JSON.parse(await Bun.stdin.text() || "{}"); } catch { process.exit(0); }
// Codex may report the parent session_id for subagent hooks. Never deliver a
// hands-on parent's mailbox into a child context when child evidence exists.
if (input.agent_id || input.agent_transcript_path) process.exit(0);
if (typeof input.transcript_path === "string" && /(?:\/subagents\/|\/agent-[^/]+$)/.test(input.transcript_path)) process.exit(0);
if (typeof input.session_id === "string" && process.env.CODEX_THREAD_ID && input.session_id !== process.env.CODEX_THREAD_ID) process.exit(0);
if (typeof input.model === "string" && typeof input.session_id === "string" && typeof input.transcript_path === "string" && !input.transcript_path.split("/").at(-1)?.includes(input.session_id)) process.exit(0);
// Prevent Stop continuations from becoming autonomous acknowledgement loops.
if (mode === "stop" && input.stop_hook_active === true) process.exit(0);
const event=typeof input.hook_event_name === "string" ? input.hook_event_name : mode === "stop" ? "Stop":"UserPromptSubmit";
if (!["UserPromptSubmit","PostToolUse","SessionStart","Stop"].includes(event)) process.exit(0);
const explicitIndex=process.argv.indexOf("--peer-id");
let peerId=explicitIndex>=0 ? process.argv[explicitIndex+1]:undefined;
const session=typeof input.session_id === "string" ? input.session_id:process.env.CODEX_THREAD_ID;

function emitContext(text:string) {
  console.log(JSON.stringify({hookSpecificOutput:{hookEventName:event,additionalContext:text}}));
}
try {
  if (!peerId && session && /^[a-zA-Z0-9:_-]{1,200}$/.test(session)) {
    const result=await post<{peer:Peer|null}>("/resolve-session",{session_key:session});
    peerId=result.peer?.id;
    if (!peerId && mode!=="stop") {
      emitContext(`[claude-peers setup: this GUI task's session ID is ${session}. `+
        `Bind only THIS task's claude-peers connection by calling its set_summary tool with `+
        `a summary beginning exactly [session:${session}] followed by your current work summary. `+
        `This is a one-time mailbox binding so other GUI tasks cannot consume your messages. `+
        `Do not use another task's peer ID or a parent PID. Then call check_messages. `+
        `If this task has no claude-peers tools, continue without binding.]`);
      process.exit(0);
    }
  }
  // Never guess based on cwd or parent PID: desktop tasks share these values.
  if (!peerId) process.exit(0);
  // Wake-ups are on by default for bound GUI sessions (never overrides an
  // explicit opt-out). Only for session-resolved peers, never --peer-id.
  if (explicitIndex<0) {
    const identity=hookWakeIdentity(process.env,session);
    if (identity) await post("/auto-wake",{id:peerId,...identity}).catch(()=>{});
  }
  const {messages}=await post<{messages:Message[]}>("/poll-messages",{id:peerId,protocol:2});
  if (!messages.length) process.exit(0);
  const text=receiptEnvelope(messages,peerId);
  if (mode === "stop") console.log(JSON.stringify({decision:"block",reason:text}));
  else emitContext(text);
} catch {
  // Unavailable broker or missing binding does not consume mail or block tools.
  process.exit(0);
}
