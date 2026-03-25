/**
 * proxy-helpers.ts
 *
 * All proxy protocol functions for the GSD decision proxy agent.
 * Implements: discuss_choice reception, discuss_answer sending,
 * DECISIONS.md logging, orchestrator-side choice sending + timeout/fallback.
 */

import type {
  PeerId,
  Message,
  DiscussChoicePayload,
  DiscussAnswerPayload,
  PollMessagesResponse,
} from "../../shared/types.ts";

// --- Configuration ---

const BROKER_PORT = process.env.CLAUDE_PEERS_PORT ?? "7899";
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

// --- Internal broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

// --- Exported proxy protocol functions ---

/**
 * PRXY-01: Poll for discuss_choice messages addressed to this peer.
 * Does NOT ACK messages — caller decides when to ACK after processing.
 */
export async function pollForChoices(
  myId: PeerId
): Promise<Array<{ id: number; from_id: PeerId; choicePayload: DiscussChoicePayload }>> {
  const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
  return result.messages
    .filter((msg: Message) => msg.msg_type === "discuss_choice")
    .map((msg: Message) => ({
      id: msg.id,
      from_id: msg.from_id,
      choicePayload: parseChoicePayload(msg.payload),
    }));
}

/**
 * PRXY-01 helper: Parse and validate a raw DiscussChoicePayload JSON string.
 * Throws if any required field is missing.
 */
export function parseChoicePayload(raw: string): DiscussChoicePayload {
  const parsed = JSON.parse(raw) as DiscussChoicePayload;
  const requiredFields: (keyof DiscussChoicePayload)[] = [
    "phase_number",
    "question",
    "options",
    "recommended",
  ];
  for (const field of requiredFields) {
    if (parsed[field] === undefined) {
      throw new Error(`Invalid DiscussChoicePayload: missing required field '${field}'`);
    }
  }
  return parsed;
}

/**
 * PRXY-02 helper: Build a DiscussAnswerPayload from individual fields.
 */
export function buildAnswerPayload(
  phaseNumber: number,
  chosen: string,
  reasoning: string
): DiscussAnswerPayload {
  return { phase_number: phaseNumber, chosen, reasoning };
}

/**
 * PRXY-02: Send a discuss_answer message to the orchestrator via the broker.
 */
export async function sendAnswer(
  myId: PeerId,
  orchestratorId: PeerId,
  payload: DiscussAnswerPayload
): Promise<void> {
  await brokerFetch("/send-message", {
    from_id: myId,
    to_id: orchestratorId,
    text: "Phase " + payload.phase_number + " decision: " + payload.chosen,
    msg_type: "discuss_answer",
    payload,
  });
}

/**
 * PRXY-04: Append a decision entry to DECISIONS.md.
 * Creates the file with a header if it does not already exist.
 */
export async function appendDecision(
  decisionsPath: string,
  phaseNumber: number,
  question: string,
  chosen: string,
  reasoning: string
): Promise<void> {
  const entry =
    `## Phase ${phaseNumber}\n` +
    `**Question:** ${question}\n` +
    `**Chosen:** ${chosen}\n` +
    `**Reasoning:** ${reasoning}\n` +
    `**Timestamp:** ${new Date().toISOString()}\n\n`;

  const fileExists = await Bun.file(decisionsPath).exists();
  if (!fileExists) {
    await Bun.write(decisionsPath, "# Autonomous Run Decisions\n\n" + entry);
  } else {
    const existing = await Bun.file(decisionsPath).text();
    await Bun.write(decisionsPath, existing + entry);
  }
}

/**
 * PRXY-01 (orchestrator side): Send a discuss_choice message to the proxy peer.
 */
export async function sendDiscussChoice(
  myId: PeerId,
  proxyId: PeerId,
  choice: DiscussChoicePayload
): Promise<void> {
  await brokerFetch("/send-message", {
    from_id: myId,
    to_id: proxyId,
    text: "Phase " + choice.phase_number + " choice: " + choice.question,
    msg_type: "discuss_choice",
    payload: choice,
  });
}

/**
 * PRXY-05: Poll for a discuss_answer matching phaseNumber with timeout/fallback.
 * Returns null if no answer arrives within timeoutMs (default 60s).
 * ACKs and discards stale discuss_answer messages from other phases.
 */
export async function waitForAnswer(
  myId: PeerId,
  phaseNumber: number,
  timeoutMs: number = 60_000
): Promise<DiscussAnswerPayload | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
    const answerMessages = result.messages.filter(
      (msg: Message) => msg.msg_type === "discuss_answer"
    );

    const staleIds: number[] = [];
    let found: DiscussAnswerPayload | null = null;

    for (const msg of answerMessages) {
      const answerPayload = JSON.parse(msg.payload) as DiscussAnswerPayload;
      if (answerPayload.phase_number === phaseNumber) {
        // ACK the matching answer and return it
        await brokerFetch("/ack-message", { message_ids: [msg.id] });
        found = answerPayload;
        break;
      } else {
        // Stale answer — collect for cleanup
        staleIds.push(msg.id);
      }
    }

    // ACK and discard any stale answers
    if (staleIds.length > 0) {
      await brokerFetch("/ack-message", { message_ids: staleIds });
    }

    if (found !== null) {
      return found;
    }

    // Wait 2 seconds before next poll
    await new Promise((r) => setTimeout(r, 2_000));
  }

  return null;
}

/**
 * ACK a list of message IDs.
 * Exported for proxy agent use after processing discuss_choice messages.
 */
export async function ackMessages(messageIds: number[]): Promise<void> {
  await brokerFetch("/ack-message", { message_ids: messageIds });
}
