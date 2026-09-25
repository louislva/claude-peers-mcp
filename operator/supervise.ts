import type { DeliveryProblem, WakeHarness } from "../shared/store.ts";

export interface SuperviseDeps {
  peer(id: string): Promise<{id:string,pid:number,session_key:string|null} | null>;
  resolve(peer: {pid:number,session_key:string|null}): {harness:WakeHarness,host_session_id:string} | null;
  /** Why an address can't be proven, when there is hard evidence (e.g. archived Codex thread). */
  whyUnreachable?(peer: {pid:number,session_key:string|null}): string | null;
  autoWake(id: string, address: {harness:WakeHarness,host_session_id:string}): Promise<{wake_policy:string}>;
  send(to: string, text: string, replyTo: number): Promise<void>;
  emit(line: string): void;
  /** Durable receipt that this problem was reported (survives watcher restarts). */
  markReported(id: number, reason: string): Promise<void>;
}

const idList=(ids:number[])=>`${ids.length>1?"messages":"message"} ${ids.map(i=>`#${i}`).join(", ")}`;

export function bounceText(ids: number | number[], to: string, reason: string, detail?: string) {
  const list = Array.isArray(ids) ? ids : [ids];
  return `[claude-peers operator] Could not ring ${to} for your ${idList(list)}: ${reason}${detail ? ` (${detail})`:""}. ${list.length>1?"They are":"The message is"} NOT lost: queued in their inbox, arriving when they next take a turn. Check the recipient id or ask Kiel if it's urgent.`;
}

/**
 * The switchboard's obligation: for each message that has not arrived, fix
 * what can be fixed from hard evidence (connect an unaddressed recipient),
 * otherwise tell the caller (bounce) and the operator (one line), once.
 * Notices are grouped: one line per recipient+reason, one bounce per
 * sender+recipient+reason (Astra #1244).
 */
export async function superviseDelivery(problems: DeliveryProblem[], d: SuperviseDeps, seen: Set<string>) {
  const reportable: DeliveryProblem[] = [];
  for (let p of problems) {
    try {
      if (p.reason === "no-wake-address") {
        const peer = await d.peer(p.to_id);
        const address = peer ? d.resolve(peer) : null;
        if (address && (await d.autoWake(p.to_id, address)).wake_policy === "on") continue; // connected; next pass rings it
        if (p.already_reported) continue; // told once already; keep trying to connect silently
        const why = peer && d.whyUnreachable ? d.whyUnreachable(peer) : null;
        p = { ...p, detail: why ?? "no Claude desktop or Codex address could be proven for this peer" };
      }
      if (seen.has(`${p.message_id}:${p.reason}`)) continue;
      reportable.push(p);
    } catch (e) {
      d.emit(`OPERATOR-ERROR message #${p.message_id}: ${String(e).replace(/[\r\n]+/g," ").slice(0,200)}`);
    }
  }
  const clean = (t?: string) => t ? t.replace(/[\r\n]+/g," ").slice(0,200) : undefined;
  const groups = new Map<string, DeliveryProblem[]>();
  for (const p of reportable) {
    const k = JSON.stringify([p.to_id,p.reason,clean(p.detail) ?? ""]);
    groups.set(k,[...(groups.get(k) ?? []),p]);
  }
  for (const group of groups.values()) {
    const {to_id,reason} = group[0]!, detail = clean(group[0]!.detail);
    const ids = group.map(p=>p.message_id);
    try {
      for (const id of ids) seen.add(`${id}:${reason}`);
      d.emit(`UNDELIVERED ${idList(ids)} to ${to_id}: ${reason}${detail ? ` (${detail})`:""}`);
      if (reason !== "woken-not-picked-up") {
        const bySender = new Map<string, number[]>();
        for (const p of group) if (p.from_id !== "cli" && p.from_id !== "operator") bySender.set(p.from_id,[...(bySender.get(p.from_id) ?? []),p.message_id]);
        for (const [sender,senderIds] of bySender) await d.send(sender, bounceText(senderIds.length===1?senderIds[0]!:senderIds, to_id, reason, detail), senderIds[0]!);
      }
      for (const id of ids) await d.markReported(id, reason);
    } catch (e) {
      // One bad group must not stop the ledger; it is retried next pass.
      for (const id of ids) seen.delete(`${id}:${reason}`);
      d.emit(`OPERATOR-ERROR ${idList(ids)}: ${String(e).replace(/[\r\n]+/g," ").slice(0,200)}`);
    }
  }
}
