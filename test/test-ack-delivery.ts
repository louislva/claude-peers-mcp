#!/usr/bin/env bun
/**
 * test-ack-delivery.ts
 *
 * End-to-end test for the ack-based delivery fix. Boots a test broker on a
 * non-standard port + temp DB, exercises the HTTP API directly (no MCP
 * stdio in the loop), and verifies the new at-least-once semantics.
 *
 * Run: bun test/test-ack-delivery.ts
 */

import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";

const TEST_PORT = 7900;
const TEST_DB = `/tmp/claude-peers-test-${Date.now()}.db`;
const BROKER_URL = `http://127.0.0.1:${TEST_PORT}`;

async function fetchJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path}: HTTP ${res.status} — ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function waitForBroker(timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BROKER_URL}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("broker didn't start within timeout");
}

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const brokerScript = new URL("../broker.ts", import.meta.url).pathname;
const proc = Bun.spawn(["bun", brokerScript], {
  env: { ...process.env, CLAUDE_PEERS_PORT: String(TEST_PORT), CLAUDE_PEERS_DB: TEST_DB },
  stdio: ["ignore", "ignore", "pipe"],
});

try {
  await waitForBroker();
  console.log(`[setup] test broker up on :${TEST_PORT}, db: ${TEST_DB}\n`);

  const sender = await fetchJson<{ id: string }>("/register", {
    pid: 99001,
    cwd: "/test/sender",
    git_root: null,
    tty: null,
    summary: "test-sender",
  });
  const recipient = await fetchJson<{ id: string }>("/register", {
    pid: 99002,
    cwd: "/test/recipient",
    git_root: null,
    tty: null,
    summary: "test-recipient",
  });
  console.log(`[setup] sender=${sender.id}, recipient=${recipient.id}\n`);

  // --- Test 1: message survives poll without ack ---
  console.log("[test 1] message survives poll without ack");
  await fetchJson("/send-message", { from_id: sender.id, to_id: recipient.id, text: "msg-1" });
  let res = await fetchJson<{ messages: Array<{ id: number; text: string }> }>("/poll-messages", {
    id: recipient.id,
  });
  assert(res.messages.length === 1, "first poll returns 1 message");
  assert(res.messages[0]?.text === "msg-1", "message text matches");
  const msgId = res.messages[0]!.id;

  const db = new Database(TEST_DB, { readonly: true });
  const row = db.query("SELECT delivered, polled_at FROM messages WHERE id = ?").get(msgId) as
    | { delivered: number; polled_at: string | null }
    | null;
  assert(row !== null, "row visible from a separate readonly connection");
  assert(row?.delivered === 0, "message is NOT marked delivered after poll");
  assert(row?.polled_at !== null, "message IS marked polled_at after poll");
  db.close();
  console.log();

  // --- Test 2: re-poll within lease window returns nothing ---
  console.log("[test 2] re-poll within lease window returns nothing");
  res = await fetchJson("/poll-messages", { id: recipient.id });
  assert(res.messages.length === 0, "re-poll within lease returns 0 messages");
  console.log();

  // --- Test 3: simulate lease expiry, message comes back ---
  console.log("[test 3] message re-pollable after lease expires");
  const dbRw = new Database(TEST_DB);
  dbRw.run("UPDATE messages SET polled_at = ? WHERE id = ?", [
    new Date(Date.now() - 120_000).toISOString(),
    msgId,
  ]);
  dbRw.close();
  res = await fetchJson("/poll-messages", { id: recipient.id });
  assert(res.messages.length === 1, "message re-returned after lease expiry");
  console.log();

  // --- Test 4: ack marks delivered, no more returns ---
  console.log("[test 4] ack marks message delivered, removes from poll");
  await fetchJson("/ack-messages", { id: recipient.id, message_ids: [msgId] });
  const dbR = new Database(TEST_DB, { readonly: true });
  let after = dbR.query("SELECT delivered FROM messages WHERE id = ?").get(msgId) as {
    delivered: number;
  };
  dbR.close();
  assert(after.delivered === 1, "message marked delivered after ack");
  res = await fetchJson("/poll-messages", { id: recipient.id });
  assert(res.messages.length === 0, "acked message no longer returned by poll");
  console.log();

  // --- Test 5: cross-peer ack denied (defense in depth) ---
  console.log("[test 5] cannot ack messages destined for other peers");
  await fetchJson("/send-message", { from_id: sender.id, to_id: recipient.id, text: "msg-2" });
  res = await fetchJson("/poll-messages", { id: recipient.id });
  const msg2Id = res.messages[0]!.id;
  // sender (not recipient) tries to ack
  await fetchJson("/ack-messages", { id: sender.id, message_ids: [msg2Id] });
  const dbR2 = new Database(TEST_DB, { readonly: true });
  const after2 = dbR2.query("SELECT delivered FROM messages WHERE id = ?").get(msg2Id) as {
    delivered: number;
  };
  dbR2.close();
  assert(after2.delivered === 0, "cross-peer ack did NOT mark delivered");
  // recipient acks properly
  await fetchJson("/ack-messages", { id: recipient.id, message_ids: [msg2Id] });
  const dbR3 = new Database(TEST_DB, { readonly: true });
  const after3 = dbR3.query("SELECT delivered FROM messages WHERE id = ?").get(msg2Id) as {
    delivered: number;
  };
  dbR3.close();
  assert(after3.delivered === 1, "correct-peer ack marks delivered");
  console.log();

  // --- Test 6: empty ack is no-op ---
  console.log("[test 6] empty ack is no-op");
  const empty = await fetchJson<{ ok: boolean }>("/ack-messages", {
    id: recipient.id,
    message_ids: [],
  });
  assert(empty.ok === true, "empty ack returns ok=true");
  console.log();

  // --- Test 7: multi-message batched ack ---
  console.log("[test 7] batched ack of multiple messages");
  await fetchJson("/send-message", { from_id: sender.id, to_id: recipient.id, text: "msg-3a" });
  await fetchJson("/send-message", { from_id: sender.id, to_id: recipient.id, text: "msg-3b" });
  await fetchJson("/send-message", { from_id: sender.id, to_id: recipient.id, text: "msg-3c" });
  res = await fetchJson("/poll-messages", { id: recipient.id });
  assert(res.messages.length === 3, "poll returns 3 new messages");
  const ids = res.messages.map((m) => m.id);
  await fetchJson("/ack-messages", { id: recipient.id, message_ids: ids });
  res = await fetchJson("/poll-messages", { id: recipient.id });
  assert(res.messages.length === 0, "batched ack cleared all 3 messages");
  console.log();

  console.log("---");
  console.log(`Result: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
} finally {
  proc.kill();
  // Brief wait so the process actually exits
  await new Promise((r) => setTimeout(r, 200));
  if (existsSync(TEST_DB)) {
    try {
      unlinkSync(TEST_DB);
    } catch {
      /* ignore */
    }
  }
}
