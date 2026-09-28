/**
 * Native wake delivery: nudge a recipient harness so it reads its claude-peers inbox now
 * instead of whenever it next polls. The nudge is fixed text that never carries the message
 * body; the recipient reads the body through check_messages, which keeps broker-attributed
 * sender metadata and is the only place messages are acknowledged.
 */

import { connect } from "node:net";
import { basename, dirname } from "node:path";
import type { WakeStatus, WakeTransport } from "./shared/types.ts";

const INBOX_TIMEOUT_MS = Number(process.env.CLAUDE_PEERS_INBOX_TIMEOUT_MS ?? 2_000);
const CODEX_TIMEOUT_MS = Number(process.env.CLAUDE_PEERS_CODEX_TIMEOUT_MS ?? 10_000);

// launchd's PATH omits Homebrew, where both `codex` and the `node` its shebang needs live.
export const CODEX_BIN =
  process.env.CLAUDE_PEERS_CODEX_BIN ??
  Bun.which("codex", { PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` }) ??
  "codex";

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const INBOX_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;

export function validateWake(transport: unknown, address: unknown, secret?: unknown): string | null {
  if (transport === "codex_queue") {
    // A leading dash would be parsed by `codex queue` as a flag.
    if (typeof address !== "string" || !THREAD_ID.test(address)) return "invalid codex thread id";
    return null;
  }
  if (transport === "claude_inbox") {
    if (typeof address !== "string" || !address.startsWith("/") || address.length > 512 || /[\0\n]/.test(address)) {
      return "invalid inbox socket path";
    }
    if (secret != null && (typeof secret !== "string" || !INBOX_TOKEN.test(secret))) return "invalid inbox token";
    return null;
  }
  return "unknown wake transport";
}

function sanitize(value: string): string {
  return value.replace(/[^\w.-]/g, "").slice(0, 40);
}

export function wakeText(senderId: string, senderClient: string, senderCwd: string): string {
  const place = sanitize(basename(senderCwd)) || "unknown";
  return `[claude-peers] New message from ${sanitize(senderId)} (${sanitize(senderClient)}, ${place}). Call check_messages to read and reply.`;
}

export function deliverClaudeInbox(socketPath: string, token: string | null, text: string): Promise<WakeStatus> {
  return new Promise((resolve) => {
    let written = false;
    let settled = false;
    const client = connect(socketPath);
    const finish = (status: WakeStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      resolve(status);
    };
    // A timeout before anything was written means nothing was submitted.
    const timer = setTimeout(() => finish(written ? "ambiguous" : "failed"), INBOX_TIMEOUT_MS);

    client.on("connect", () => {
      const auth = token ? JSON.stringify({ type: "auth", token }) + "\n" : "";
      const user = JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
      client.write(auth + user, () => {
        written = true;
        client.end();
      });
    });
    client.on("error", () => finish(written ? "ambiguous" : "failed"));
    // The inbox never acknowledges, and Bun's client closes right after end() regardless of
    // the peer, so "queued" means written and flushed, not read.
    client.on("close", () => finish(written ? "queued" : "failed"));
  });
}

export async function deliverCodexQueue(bin: string, thread: string, text: string): Promise<WakeStatus> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, "queue", "--thread", thread, "--message", text], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${dirname(bin)}:${process.env.PATH ?? ""}` },
    });
  } catch {
    return "failed";
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), CODEX_TIMEOUT_MS);
  });
  const result = await Promise.race([proc.exited, timedOut]);
  clearTimeout(timer);

  if (result === "timeout") {
    proc.kill();
    return "ambiguous";
  }
  if (result === 0) return "queued";
  // 126/127: the shell or `env` could not execute codex (e.g. no node on PATH), so nothing ran.
  if (result === 126 || result === 127) return "failed";

  const output =
    (await new Response(proc.stderr as ReadableStream).text()) + (await new Response(proc.stdout as ReadableStream).text());
  // Only a rejected thread is a definite non-delivery; any other error may have queued.
  return /no rollout found|thread not found/i.test(output) ? "failed" : "ambiguous";
}

export function deliverWake(
  transport: WakeTransport,
  address: string,
  secret: string | null,
  text: string,
): Promise<WakeStatus> {
  return transport === "claude_inbox"
    ? deliverClaudeInbox(address, secret, text)
    : deliverCodexQueue(CODEX_BIN, address, text);
}
