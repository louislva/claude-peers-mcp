import type { DeliveryProblem, WakeHarness } from "../shared/store.ts";

export interface SuperviseDeps {
  peer(id: string): Promise<{id:string,pid:number,session_key:string|null} | null>;
  resolve(peer: {pid:number,session_key:string|null}): {harness:WakeHarness,host_session_id:string} | null;
  autoWake(id: string, address: {harness:WakeHarness,host_session_id:string}): Promise<{wake_policy:string}>;
  send(to: string, text: string, replyTo: number): Promise<void>;
  emit(line: string): void;
  /** Durable receipt that this problem was reported (survives watcher restarts). */
  markReported(id: number, reason: string): Promise<void>;
}

export function bounceText(id: number, to: string, reason: string, detail?: string) {
  return `[claude-peers operator] Your message #${id} to ${to} has not been delivered: ${reason}${detail ? ` (${detail})`:""}. It stays queued in their inbox; check the recipient id or ask Kiel.`;
}

/**
 * The switchboard's obligation: for each message that has not arrived, fix
 * what can be fixed from hard evidence (connect an unaddressed recipient),
 * otherwise tell the caller (bounce) and the operator (one line), once.
 */
export async function superviseDelivery(problems: DeliveryProblem[], d: SuperviseDeps, seen: Set<string>) {
  for (let p of problems) {
    try {
      const key = `${p.message_id}:${p.reason}`;
      if (p.reason === "no-wake-address") {
        const peer = await d.peer(p.to_id);
        const address = peer ? d.resolve(peer) : null;
        if (address && (await d.autoWake(p.to_id, address)).wake_policy === "on") continue; // connected; next pass rings it
        if (p.already_reported) continue; // told once already; keep trying to connect silently
        p = { ...p, detail: "no Claude desktop or Codex address could be proven for this peer" };
      }
      if (seen.has(key)) continue;
      seen.add(key);
      const detail = p.detail ? ` (${p.detail.replace(/[\r\n]+/g," ").slice(0,200)})` : "";
      d.emit(`UNDELIVERED message #${p.message_id} to ${p.to_id}: ${p.reason}${detail}`);
      if (p.reason !== "woken-not-picked-up" && p.from_id !== "cli" && p.from_id !== "operator")
        await d.send(p.from_id, bounceText(p.message_id, p.to_id, p.reason, p.detail), p.message_id);
      await d.markReported(p.message_id, p.reason);
    } catch (e) {
      // One bad problem must not stop the ledger; it is retried next pass.
      seen.delete(`${p.message_id}:${p.reason}`);
      d.emit(`OPERATOR-ERROR message #${p.message_id}: ${String(e).replace(/[\r\n]+/g," ").slice(0,200)}`);
    }
  }
}
