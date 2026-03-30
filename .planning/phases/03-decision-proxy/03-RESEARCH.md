# Phase 3: Decision Proxy - Research

**Researched:** 2026-03-25
**Domain:** Peer protocol / agent coordination / file append patterns
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
None — all implementation choices are at Claude's discretion.

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Key areas:
- Proxy agent file structure (helpers module + agent document, mirroring Phase 2 pattern)
- How proxy detects it should handle `discuss_choice` messages (summary-based identification)
- DECISIONS.md format and append strategy
- Timeout mechanism (60s for proxy response)
- How prior decisions are aggregated and included in each `discuss_choice` payload
- Whether proxy helpers are a separate module or extend existing infrastructure
- Test structure for proxy protocol flows

### Deferred Ideas (OUT OF SCOPE)
None
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PRXY-01 | Decision proxy peer receives `discuss_choice` messages with phase context, question, options, and recommended default | `DiscussChoicePayload` already defined in `shared/types.ts`; `/poll-messages` + `/ack-message` broker endpoints provide the delivery mechanism |
| PRXY-02 | Decision proxy responds with `discuss_answer` containing chosen option and reasoning within 60 seconds | `DiscussAnswerPayload` already defined in `shared/types.ts`; `brokerFetch("/send-message", ...)` pattern from executor-helpers.ts covers the send path; 60s timeout uses `Promise.race` + `AbortSignal` |
| PRXY-03 | Decision proxy includes prior decisions from the same autonomous run in each query for consistency | `prior_decisions` field already present in `DiscussChoicePayload` as optional array; orchestrator side accumulates answers, proxy side reads the field |
| PRXY-04 | All proxy decisions are logged to `.planning/DECISIONS.md` as an audit trail | Standard `Bun.file` append strategy; file created on first decision if absent |
| PRXY-05 | Orchestrator falls back to recommended default if proxy is unavailable or times out | `Promise.race([waitForAnswer(60_000), timeout(60_000)])` pattern; uses `recommended` field from `DiscussChoicePayload` |
</phase_requirements>

---

## Summary

Phase 3 is a pure infrastructure phase — all required type contracts are already defined in `shared/types.ts` (from Phase 1), the broker messaging infrastructure is fully operational (from Phases 1–2), and the executor peer pattern (Phase 2) provides a proven template for the proxy peer pattern. There is nothing novel to research from third-party libraries; the work is entirely about assembling these existing pieces into a new peer role.

The decision proxy is structurally simpler than the executor: it has a two-message protocol (`discuss_choice` → `discuss_answer`), no git operations, no wave/task registration, and no progress reporting. Its unique concerns are (1) the 60-second response timeout, (2) accumulating `prior_decisions` for consistency, (3) appending to `.planning/DECISIONS.md`, and (4) the proxy's idle polling loop that keeps it available throughout the entire autonomous run.

The `prior_decisions` field is already defined in `DiscussChoicePayload` as an optional array of `{ phase: number; question: string; chosen: string }` objects. The orchestrator builds this array by accumulating each `discuss_answer` received during the run and attaching the full history to every subsequent `discuss_choice`. The proxy reads the field and uses it for context when answering.

**Primary recommendation:** Mirror the Phase 2 pattern exactly — one `proxy-helpers.ts` module + one `gsd-proxy.md` agent document + one `proxy-helpers.test.ts` test file. The broker and type infrastructure requires zero changes.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `bun:sqlite` (via broker) | built-in | Message storage + delivery | Already the project's data layer |
| `Bun.file` | built-in | `.planning/DECISIONS.md` append | Project-standard for file I/O |
| `bun:test` | built-in | Test runner | Project-standard per CLAUDE.md |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `shared/types.ts` (project) | n/a | `DiscussChoicePayload`, `DiscussAnswerPayload` | Typed message parsing |
| `fetch` (built-in) | built-in | Broker HTTP calls via `brokerFetch` | Same pattern as executor-helpers.ts |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Single proxy-helpers.ts module | Extending executor-helpers.ts | Separate module keeps proxy concerns isolated, avoids making executor-helpers a multi-role module |
| Bun.file append | fs.appendFile | Bun.file is project convention; fs is Node-style |

**Installation:**
No new packages required. All dependencies are already installed.

---

## Architecture Patterns

### Recommended Project Structure
```
gsd-plugin/
├── executor/
│   ├── executor-helpers.ts      # Phase 2 (reference)
│   ├── executor-helpers.test.ts # Phase 2 (reference)
├── proxy/                       # NEW — mirrors executor/
│   ├── proxy-helpers.ts         # Broker + file I/O functions
│   └── proxy-helpers.test.ts    # Integration tests
└── agents/
    ├── gsd-executor.md          # Phase 2 (reference)
    └── gsd-proxy.md             # NEW — proxy agent document
```

### Pattern 1: brokerFetch Pattern (from executor-helpers.ts)

**What:** Internal HTTP helper for broker calls. All proxy broker calls use this same function.
**When to use:** Every broker endpoint call — `/send-message`, `/poll-messages`, `/ack-message`

```typescript
// Source: gsd-plugin/executor/executor-helpers.ts (lines 27-38)
const BROKER_PORT = process.env.CLAUDE_PEERS_PORT ?? "7899";
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

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
```

### Pattern 2: DiscussChoicePayload / DiscussAnswerPayload (from shared/types.ts)

**What:** Both payload types are fully defined in Phase 1. No changes needed.
**When to use:** Parse incoming `discuss_choice` messages; construct outgoing `discuss_answer` messages.

```typescript
// Source: shared/types.ts (lines 189-203)
export interface DiscussChoicePayload {
  phase_number: number;
  phase_goal: string;
  question: string;
  options: string[];
  recommended: string;
  context: string;
  prior_decisions?: Array<{ phase: number; question: string; chosen: string }>;
}

export interface DiscussAnswerPayload {
  phase_number: number;
  chosen: string;
  reasoning: string;
}
```

### Pattern 3: 60-Second Timeout with Promise.race

**What:** Proxy waits up to 60 seconds for the Claude agent to respond with a `discuss_answer`. If time elapses, uses recommended default.
**When to use:** Orchestrator side — after sending `discuss_choice`, before continuing discuss-phase.

```typescript
// Pattern for PRXY-05 timeout/fallback
async function waitForAnswer(
  proxyId: PeerId,
  phaseNumber: number,
  timeoutMs = 60_000
): Promise<DiscussAnswerPayload | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await brokerFetch<{ messages: Message[] }>("/poll-messages", { id: myId });
    const answer = msgs.messages.find(
      (m) => m.msg_type === "discuss_answer" &&
             (JSON.parse(m.payload) as DiscussAnswerPayload).phase_number === phaseNumber
    );
    if (answer) {
      await brokerFetch("/ack-message", { message_ids: [answer.id] });
      return JSON.parse(answer.payload) as DiscussAnswerPayload;
    }
    await new Promise((r) => setTimeout(r, 2_000)); // poll every 2s
  }
  return null; // timeout — use recommended default
}
```

### Pattern 4: DECISIONS.md Append with Bun.file

**What:** Each proxy decision is appended to `.planning/DECISIONS.md`. File is created on first write if absent.
**When to use:** Proxy side — after constructing the `discuss_answer`, before sending it.

```typescript
// Source: Bun built-in file I/O — project convention per CLAUDE.md
async function appendDecision(
  decisionsPath: string,
  phaseNumber: number,
  question: string,
  chosen: string,
  reasoning: string
): Promise<void> {
  const file = Bun.file(decisionsPath);
  const exists = await file.exists();
  const header = exists ? "" : "# Autonomous Run Decisions\n\n";
  const entry = `## Phase ${phaseNumber}\n**Question:** ${question}\n**Chosen:** ${chosen}\n**Reasoning:** ${reasoning}\n**Timestamp:** ${new Date().toISOString()}\n\n`;
  const existing = exists ? await file.text() : "";
  await Bun.write(decisionsPath, header + existing + entry);
}
```

Note: `Bun.write` does not have a native append mode that prepends; the pattern above reads existing content and writes the full file. For true append (entries added at bottom), use:

```typescript
// Append-only variant (entries accumulate at bottom)
const existing = exists ? await file.text() : "# Autonomous Run Decisions\n\n";
await Bun.write(decisionsPath, existing + entry);
```

### Pattern 5: Proxy Lifecycle (State Machine)

**What:** Proxy has a simple two-state machine — IDLE and ANSWERING — much simpler than the executor.

```
IDLE
  │
  ├─ poll messages every 2s
  │   ├─ receive discuss_choice → ANSWERING
  │   └─ other msg types → ignore
  │
ANSWERING
  │
  ├─ parse DiscussChoicePayload
  ├─ evaluate options (using prior_decisions for context)
  ├─ append to DECISIONS.md (PRXY-04)
  ├─ send discuss_answer to orchestrator (PRXY-02)
  └─ return to IDLE
```

The proxy NEVER handles `execute_phase`, `reclaim_task`, or `status_request`. It ignores all other message types (same dispatch switch pattern as executor).

### Pattern 6: Proxy Identification via Summary

**What:** The orchestrator identifies the proxy by checking if peer summary contains "decision proxy" (case-insensitive substring match).
**Source:** design-peer-autonomous.md lines 86-99

The proxy session must call `set_summary("Decision proxy — answering discuss-phase choices for autonomous runs")` on startup. The orchestrator's peer classification logic (Phase 4) will look for this string.

### Recommended `proxy-helpers.ts` Exported Functions

Following the executor-helpers.ts pattern, proxy-helpers.ts exports named functions only — no classes, no singletons.

| Function | Purpose | PRXY req |
|----------|---------|----------|
| `pollForChoices(myId)` | Poll broker for undelivered `discuss_choice` messages | PRXY-01 |
| `sendAnswer(myId, orchestratorId, payload)` | Send `discuss_answer` to orchestrator | PRXY-02 |
| `appendDecision(decisionsPath, ...)` | Append decision to DECISIONS.md | PRXY-04 |
| `parseChoicePayload(raw)` | Safely parse JSON payload string | PRXY-01 |
| `buildAnswerPayload(phaseNumber, chosen, reasoning)` | Construct typed answer | PRXY-02 |

### Anti-Patterns to Avoid

- **Merging proxy helpers into executor-helpers.ts:** Executor and proxy are distinct roles with different lifecycles. Keeping them in separate modules prevents coupling and makes role boundaries clear.
- **Synchronous file I/O for DECISIONS.md:** Always use async `Bun.file` / `Bun.write`. Sync I/O blocks the message poll loop.
- **Blocking the proxy on slow reasoning:** The 60s timeout is measured by the orchestrator, not the proxy. The proxy should respond as soon as it has an answer — do not artificially delay.
- **Polling too aggressively:** 2-second poll interval is appropriate. 100ms polling creates unnecessary broker load across a long autonomous run.
- **Including message IDs without ACK-ing:** Always ACK `discuss_choice` messages after processing via `/ack-message`. Unacknowledged messages will re-appear on every poll.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Typed message payload parsing | Custom parser | `JSON.parse(msg.payload) as DiscussChoicePayload` | Types already defined in shared/types.ts |
| HTTP broker calls | Custom fetch wrapper | `brokerFetch` (copy pattern from executor-helpers.ts) | Already battle-tested in Phase 2 |
| Message delivery | Custom queue | `/send-message` + `/poll-messages` + `/ack-message` broker endpoints | ACK-based delivery with retention is already implemented |
| File existence check | `fs.existsSync` | `await Bun.file(path).exists()` | Project convention per CLAUDE.md |

**Key insight:** The hard work (broker, types, message delivery) is done. Phase 3 is purely assembly work connecting existing pieces.

---

## Common Pitfalls

### Pitfall 1: Phase Number Mismatch on discuss_answer
**What goes wrong:** Orchestrator sends `discuss_choice` for phase 5, then polls for `discuss_answer` messages. Another stale answer for phase 3 arrives first and is used.
**Why it happens:** Message delivery is FIFO but the broker does not filter by payload content. Old messages from previous questions could still be undelivered.
**How to avoid:** Always validate `answer.phase_number === requested_phase_number` before accepting the answer. Discard non-matching answers (ACK and discard them to clean the queue).
**Warning signs:** Orchestrator uses wrong choice for wrong phase.

### Pitfall 2: DECISIONS.md Concurrent Write Race
**What goes wrong:** If two orchestrators run simultaneously (unlikely but possible), concurrent writes to DECISIONS.md corrupt the file.
**Why it happens:** `Bun.write` is not atomic across processes.
**How to avoid:** The design spec specifies at most one decision proxy per run. This is not a problem in practice for v1 since only one proxy exists at a time. Document the assumption explicitly.

### Pitfall 3: Proxy Blocks Its Own Poll Loop During Reasoning
**What goes wrong:** Proxy agent spends 45 seconds reasoning, then the orchestrator times out at 60s and uses the default. Proxy answer arrives 16 seconds after timeout — causes double-handling.
**Why it happens:** The proxy agent document doesn't enforce a response deadline for itself.
**How to avoid:** Proxy agent document should instruct: "Respond within 30 seconds of receiving the choice. You have 60 seconds before the orchestrator gives up — aim for 30 to leave margin."

### Pitfall 4: Missing ACK After Poll
**What goes wrong:** Proxy processes a `discuss_choice` but doesn't ACK it. Next poll returns the same message. Proxy sends duplicate `discuss_answer`.
**Why it happens:** Forgetting that `/poll-messages` does NOT auto-ACK — that's by design for reliable delivery.
**How to avoid:** Every processed message MUST be ACKed via `/ack-message` immediately after handling.

### Pitfall 5: Dynamic Import Required in Tests
**What goes wrong:** Tests that import proxy-helpers.ts at the top level read `CLAUDE_PEERS_PORT` at module init time (before test setup sets it). Test broker is on a different port, so calls fail.
**Why it happens:** Bun evaluates static imports before test `beforeAll` runs.
**How to avoid:** Use dynamic import inside `beforeAll`, same pattern as `executor-helpers.test.ts` lines 98-115.

---

## Code Examples

### Send discuss_answer to orchestrator
```typescript
// Pattern: proxy-helpers.ts sendAnswer function
// Source: mirrors executor-helpers.ts sendPhaseComplete (lines 164-176)
export async function sendAnswer(
  myId: PeerId,
  orchestratorId: PeerId,
  payload: DiscussAnswerPayload
): Promise<void> {
  await brokerFetch("/send-message", {
    from_id: myId,
    to_id: orchestratorId,
    text: `Phase ${payload.phase_number} decision: ${payload.chosen}`,
    msg_type: "discuss_answer",
    payload,
  });
}
```

### Poll for discuss_choice messages
```typescript
// Pattern: proxy-helpers.ts pollForChoices function
export async function pollForChoices(
  myId: PeerId
): Promise<Array<{ id: number; from_id: PeerId; choicePayload: DiscussChoicePayload }>> {
  const result = await brokerFetch<{ messages: Message[] }>("/poll-messages", { id: myId });
  return result.messages
    .filter((m) => m.msg_type === "discuss_choice")
    .map((m) => ({
      id: m.id,
      from_id: m.from_id,
      choicePayload: JSON.parse(m.payload) as DiscussChoicePayload,
    }));
}
```

### Orchestrator: send choice + wait for answer with fallback
```typescript
// Pattern for PRXY-05 — used in orchestrator (Phase 4), described here for completeness
async function discussViaProxy(
  myId: PeerId,
  proxyId: PeerId,
  choice: DiscussChoicePayload
): Promise<string> {
  await brokerFetch("/send-message", {
    from_id: myId,
    to_id: proxyId,
    text: `Phase ${choice.phase_number} choice: ${choice.question}`,
    msg_type: "discuss_choice",
    payload: choice,
  });

  const answer = await waitForAnswer(myId, proxyId, choice.phase_number, 60_000);
  if (answer) {
    return answer.chosen;
  }
  // PRXY-05: fallback to recommended default
  console.log(`Decision proxy timeout — using recommended default: ${choice.recommended}`);
  return choice.recommended;
}
```

### DECISIONS.md entry format
```markdown
# Autonomous Run Decisions

## Phase 3
**Question:** Use REST or GraphQL for the API?
**Chosen:** REST
**Reasoning:** User prefers simplicity and fewer dependencies. Consistent with Phase 1 decision to minimize external deps.
**Timestamp:** 2026-03-25T14:23:00.000Z

## Phase 5
**Question:** Include auth in this phase or defer?
**Chosen:** Defer auth to later phases
**Reasoning:** Prior decisions show shipping speed over extensibility; auth is separable.
**Timestamp:** 2026-03-25T14:31:00.000Z
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| User manually answers discuss-phase prompts | Decision proxy answers on user's behalf | Phase 3 | Enables fully autonomous runs |
| `prior_decisions` field absent | `prior_decisions?: Array<{...}>` in DiscussChoicePayload | Phase 1 (already done) | Consistency across a run's decisions is built-in |

**No deprecated patterns in this phase** — all patterns are new for Phase 3.

---

## Open Questions

1. **Where does the orchestrator call `discussViaProxy`?**
   - What we know: The orchestrator workflow is Phase 4. Phase 3 only builds the proxy side and the `proxy-helpers.ts` send/receive functions.
   - What's unclear: The helper function that sends `discuss_choice` and waits for `discuss_answer` — should it live in proxy-helpers.ts or in a future orchestrator-helpers.ts?
   - Recommendation: Place `sendDiscussChoice` + `waitForAnswer` in `proxy-helpers.ts` with comment "used by orchestrator." Phase 4 imports from proxy-helpers.ts. This keeps all discuss-proxy protocol in one module.

2. **DECISIONS.md file path**
   - What we know: CONTEXT.md specifies `.planning/DECISIONS.md` relative to the project root.
   - What's unclear: Should the path be hardcoded or passed as a parameter?
   - Recommendation: Accept `decisionsPath` as a parameter with `.planning/DECISIONS.md` as the default. Enables testing without touching the real file.

3. **Prior decisions persistence across sessions**
   - What we know: PRXY-03 says "prior decisions from the same autonomous run." APRX-01 (cross-session persistence) is deferred to v2.
   - What's unclear: Who is responsible for accumulating `prior_decisions` — the orchestrator or the proxy?
   - Recommendation: Orchestrator accumulates the array in memory. Each time it calls `sendDiscussChoice`, it attaches the full accumulated array. The proxy reads it from the payload — no separate persistence needed. This keeps the proxy stateless between questions.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | bun:test (built-in) |
| Config file | none — Bun auto-discovers *.test.ts files |
| Quick run command | `bun test gsd-plugin/proxy/proxy-helpers.test.ts` |
| Full suite command | `bun test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PRXY-01 | Proxy receives discuss_choice messages via poll | integration | `bun test gsd-plugin/proxy/proxy-helpers.test.ts` | Wave 0 |
| PRXY-02 | Proxy sends discuss_answer within 60s | integration | `bun test gsd-plugin/proxy/proxy-helpers.test.ts` | Wave 0 |
| PRXY-03 | prior_decisions array is included in each payload | unit | `bun test gsd-plugin/proxy/proxy-helpers.test.ts` | Wave 0 |
| PRXY-04 | Decisions are appended to DECISIONS.md | unit | `bun test gsd-plugin/proxy/proxy-helpers.test.ts` | Wave 0 |
| PRXY-05 | Timeout returns null (caller uses recommended default) | unit | `bun test gsd-plugin/proxy/proxy-helpers.test.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** `bun test gsd-plugin/proxy/proxy-helpers.test.ts`
- **Per wave merge:** `bun test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `gsd-plugin/proxy/proxy-helpers.ts` — core proxy protocol functions
- [ ] `gsd-plugin/proxy/proxy-helpers.test.ts` — covers PRXY-01 through PRXY-05
- [ ] `gsd-plugin/agents/gsd-proxy.md` — proxy agent document

*(No framework install needed — bun:test is built-in and already in use)*

---

## Sources

### Primary (HIGH confidence)
- `shared/types.ts` — `DiscussChoicePayload`, `DiscussAnswerPayload`, `MessageType` (lines 189-203, 16-18) — verified by direct file read
- `gsd-plugin/executor/executor-helpers.ts` — `brokerFetch` pattern, message send pattern, `readProcessOutput` (full file) — verified by direct file read
- `gsd-plugin/executor/executor-helpers.test.ts` — dynamic import in beforeAll pattern (lines 73-135), `drainMessages` helper pattern — verified by direct file read
- `gsd-plugin/agents/gsd-executor.md` — agent document structure, state machine format, message dispatch pattern — verified by direct file read
- `design-peer-autonomous.md` — `discuss_via_proxy` step (lines 104-163), proxy identification pattern (lines 86-99), user priming flow (lines 149-163) — verified by direct file read
- `CLAUDE.md` — Bun conventions: `Bun.file`, `Bun.write`, `bun test`, no `fs.readFile` — verified by direct file read

### Secondary (MEDIUM confidence)
- `.planning/REQUIREMENTS.md` PRXY-01 through PRXY-05 — requirement details confirmed against design doc and type definitions

### Tertiary (LOW confidence)
- None

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all dependencies verified from project source files; zero new packages needed
- Architecture: HIGH — type contracts verified in shared/types.ts; broker endpoints verified in broker.ts; executor pattern confirmed as valid template
- Pitfalls: HIGH — timeout/ACK patterns verified from existing test file; file I/O pattern verified from Bun CLAUDE.md conventions

**Research date:** 2026-03-25
**Valid until:** 2026-04-24 (stable domain — internal codebase only, no external API churn risk)
