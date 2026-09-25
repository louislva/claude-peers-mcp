#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 *
 * Usage:
 *   bun cli.ts status          — Show broker status and all peers
 *   bun cli.ts peers           — List all peers
 *   bun cli.ts send <id> <msg> — Send a message to a peer
 *   bun cli.ts kill-broker     — Stop the broker daemon
 */

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

const cmd = process.argv[2];

function ppid(pid: number): number | undefined {
  const out = new TextDecoder().decode(Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]).stdout).trim();
  return out ? Number(out) : undefined;
}

switch (cmd) {
  case "inbox":
  case "ack":
  case "bind":
  case "recover": {
    const id=process.argv[3];
    if (!id) { console.error("Expected peer ID"); process.exit(1); }
    const path=cmd==="inbox" ? "/poll-messages":cmd==="ack" ? "/ack-messages":cmd==="bind" ? "/bind-session":"/recover-inbox";
    const body=cmd==="inbox" ? {id,protocol:2,force:true}:cmd==="ack" ? {id,message_ids:process.argv.slice(4).map(Number)}:cmd==="bind" ? {id,session_key:process.argv[4]}:{id,from_id:process.argv[4]};
    try { console.log(JSON.stringify(await brokerFetch(path,body),null,2)); }
    catch(e) { console.error(String(e)); process.exitCode=1; }
    break;
  }
  case "join": {
    // One step, run from INSIDE the agent's own shell: bind + opt in + status.
    const { joinSession } = await import("./shared/join.ts");
    const i = process.argv.indexOf("--status");
    const status = i >= 0 ? process.argv.slice(i + 1).join(" ") : undefined;
    try {
      const result = await joinSession({
        env: process.env,
        post: (path, body) => brokerFetch(path, body),
        ancestors: () => { const chain: number[] = []; let pid: number | undefined = process.pid; while (pid && pid > 1 && chain.length < 30) { pid = ppid(pid); if (pid) chain.push(pid); } return chain; },
        parentOf: ppid,
      }, status);
      console.log(JSON.stringify(result, null, 2));
    } catch (e) { console.error(String(e instanceof Error ? e.message : e)); process.exitCode = 1; }
    break;
  }
  case "opt-in":
  case "opt-out":
  case "dnd":
  case "mark-woken":
  case "release-root":
  case "recheck":
  case "wake-attention": {
    // opt-in <peer> <harness> <host-id> | opt-out <peer> | dnd <peer> <minutes>
    // mark-woken <ids,comma> ok|fail [error...] | wake-attention
    const a=process.argv.slice(3);
    // Operator lines carry "attempt=<n>"; pass it through to the attempt record.
    const attemptArg=(()=>{const t=a.find(x=>x.startsWith("attempt="));return t?Number(t.slice(8)):undefined;})();
    const [path,body]=cmd==="opt-in" ? ["/opt-in",{id:a[0],harness:a[1],host_session_id:a[2]}]
      :cmd==="opt-out" ? ["/opt-out",{id:a[0]}]
      :cmd==="dnd" ? ["/set-dnd",{id:a[0],duration_ms:Number(a[1])*60_000}]
      :cmd==="release-root" ? ["/release-root",{root_id:Number(a[0])}]
      :cmd==="recheck" ? ["/recheck-wake",{host_session_id:a[0],message_ids:(a[1]??"").split(",").filter(Boolean).map(Number),attempt_id:attemptArg}]
      :cmd==="mark-woken" ? ["/mark-woken",{message_ids:(a[0]??"").split(",").filter(Boolean).map(Number),ok:a[1]==="ok"||a[1]==="uncertain",uncertain:a[1]==="uncertain",error:a.slice(2).filter(x=>!x.startsWith("attempt=")).join(" ")||undefined,attempt_id:attemptArg}]
      :["/wake-attention",{}];
    try { console.log(JSON.stringify(await brokerFetch(path as string,body),null,2)); }
    catch(e) { console.error(String(e)); process.exitCode=1; }
    break;
  }
  case "status": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker: ${health.status} (${health.peers} peer(s) registered)`);
      console.log(`URL: ${BROKER_URL}`);

      if (health.peers > 0) {
        const peers = await brokerFetch<
          Array<{
            id: string;
            pid: number;
            cwd: string;
            git_root: string | null;
            tty: string | null;
            summary: string;
            last_seen: string;
          }>
        >("/list-peers", {
          scope: "machine",
          cwd: "/",
          git_root: null,
        });

        console.log("\nPeers:");
        for (const p of peers) {
          console.log(`  ${p.id}  PID:${p.pid}  ${p.cwd}`);
          if (p.summary) console.log(`         ${p.summary}`);
          if (p.tty) console.log(`         TTY: ${p.tty}`);
          console.log(`         Last seen: ${p.last_seen}`);
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "peers": {
    try {
      const peers = await brokerFetch<
        Array<{
          id: string;
          pid: number;
          cwd: string;
          git_root: string | null;
          tty: string | null;
          summary: string;
          last_seen: string;
        }>
      >("/list-peers", {
        scope: "machine",
        cwd: "/",
        git_root: null,
        include_offline: process.argv.includes("--all"),
      });

      if (peers.length === 0) {
        console.log("No peers registered.");
      } else {
        for (const p of peers) {
          const parts = [`${p.id}  PID:${p.pid}  ${p.cwd}`];
          if (p.summary) parts.push(`  Summary: ${p.summary}`);
          console.log(parts.join("\n"));
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "send": {
    const toId = process.argv[3];
    const msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) {
      console.error("Usage: bun cli.ts send <peer-id> <message>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
        from_id: "cli",
        to_id: toId,
        text: msg,
      });
      if (result.ok) {
        console.log(`Message sent to ${toId}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);
      // Find and kill the broker process on the port
      const proc = Bun.spawnSync(["lsof", "-t", `-iTCP:${BROKER_PORT}`, "-sTCP:LISTEN"]);
      const pids = new TextDecoder()
        .decode(proc.stdout)
        .trim()
        .split("\n")
        .filter((p) => p);
      for (const pid of pids) {
        process.kill(parseInt(pid), "SIGTERM");
      }
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  default:
    console.log(`claude-peers CLI

Usage:
  bun cli.ts status          Show broker status and all peers
  bun cli.ts peers           List all peers
  bun cli.ts peers --all     Include preserved offline inboxes
  bun cli.ts inbox <id>      Read pending messages without acknowledging
  bun cli.ts ack <id> <message-id...>  Acknowledge messages after reading
  bun cli.ts bind <id> <session-key>   Bind a verified session identity
  bun cli.ts recover <id> <offline-id> Recover pending mail explicitly
  bun cli.ts send <id> <msg> Send a message to a peer
  bun cli.ts join [--status <text>]  From inside an agent's shell: bind + opt in + status, one step
  bun cli.ts opt-in <id> <codex|claude-desktop> <host-id>  Allow wake-ups
  bun cli.ts opt-out <id>    Stop wake-ups (mail still stored)
  bun cli.ts dnd <id> <minutes>  Do-not-disturb (0 clears)
  bun cli.ts mark-woken <ids> ok|fail [error]  Operator: report a wake
  bun cli.ts release-root <id>  Human: let a conversation over its loop budget ring again
  bun cli.ts wake-attention  Mail whose wakes failed 3 times
  bun cli.ts kill-broker     Stop the broker daemon`);
}
