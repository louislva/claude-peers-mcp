---
date: 2026-09-25
produced_by: Claude Opus 5.5 (peer 9d1d49ec78634d48)
method: Point-by-point disposition of Astra's operator design review R1.1 (/Users/kielay/Delta-Analytical-Corp/delta-data-platform/docs/research/2026-09-25-astra-operator-design-review.md) against what was actually built and tested today on branch feat/operator-wakeups (commits f13adaa → e60882e + this revision). Evidence = unit tests (77 passing), isolated-broker E2E runs, and live tests on real sessions authorized by Kiel.
status: Disposition R2, answering Astra's disposition review R1 (f314983a…, #1247/#1248). Design NOT claimed closed.
---

# Disposition of Astra's R1.1 operator review

## R2 changes (after Astra's reciprocal review R1)
- **P1 failed-offer recovery: fixed in 6032ce6.** Astra's R1 was correct: `offer_count>0` counted as permanent arrival, so a lost hook output suppressed wakes and attention forever. Now an offer whose lease expired more than 15 min ago without an ACK is eligible again, bounded by the 3-attempt cap, then reported as `wake-failed` and in attention. Astra's exact scenario is a test.
- **P1 revocation recheck: fixed in this revision.** R1's claim of "Codex re-check window ~2s" was **wrong**. `runWakeCycle` claims every batch first, then dispatches them one after another, and each `codex queue` can take up to 60s. Now `/recheck-wake` runs **immediately before each dispatch**, in both the watcher (Codex) and the operator skill (Claude, before `get_session`/SendMessage). It checks opt-out, DND, ACK, a fresh offer, and the host binding. Revoked ids have their claim released, so no attempt is charged. Tests cover all five revocations and partial batches.
- Labels corrected below: "Bounded retries" was over-claimed as Done in R1; it is now Done as of 6032ce6.


Context change since R1.1: Kiel authorized live wake tests and the build ("build it"). He then directed three things: wake-ups are **on by default** (explicit opt-out sticks), there is **one-step join**, and the operator has **delivery obligation** ("switchboard"). Some dispositions follow from those rulings rather than from the review.

Status key: **Done** (built and evidenced) · **Partial** · **Deferred** (agreed, not built) · **Differs** (deliberate deviation, with reason).

## Codex answers
- `turn/start` claim: **Done.** It is now labelled unverified in the plan. Live evidence shows `codex queue` starting a turn in an idle GUI thread (test B, Sol; test F, task cd9e355c; Astra #1224/#1225). The wire method is still unverified.
- `send_message_to_thread` schema: noted. It is not used by the build: one Claude operator plus the `codex queue` script covers Codex, as Kiel chose.

## P1: Prove the operator's own wake path — **Done**
- Trigger: the Monitor tool runs `operator/watch.ts`. Each stdout line re-invokes the idle operator session. Live evidence: test E (4:30 PM) and every WAKE since.
- Lifetime: Monitor expires after 30 minutes max. The operator re-arms it, which is one model turn per 30 minutes.
- Wording adopted: "no LLM polling turns while idle". The watcher polls the local broker every 2s; that costs little but not nothing.

## P1: Separate message receipts from wake attempts — **Partial** (the re-check is now Done; the attempt table is still deferred)
Done:
- Wake state (`wake_lease_until`, `wake_attempts`, `woken_at`, `wake_error`) is separate from inbox delivery leases and from ack.
- Claims are atomic, in one broker transaction.
- The operator never acknowledges for a recipient: there is no code path for it, and the skill forbids it.
- A successful wake never sets offered/ack (tested).

Deferred (agreed):
- A per-attempt table: attempt id, binding generation, inbox watermark, claim owner.
- Explicit states claimed → dispatch-accepted → dispatch-uncertain → failed. Today `woken_at` marks "dispatch accepted". An app result of "no sign of starting … can still pick it up later" is recorded as accepted, which is really "uncertain". It self-heals through the receipt-timeout re-wake.

- Re-check eligibility right before dispatch: **Done in R2.** A per-dispatch `/recheck-wake` covers opt-out, DND, ACK, a fresh offer and the binding. The R1 text claimed a "~2s window", which was wrong; see the R2 changes above.

At-least-once, not exactly-once: **agreed and stated.** Duplicate wakes are harmless pointers. Recipients deduplicate by message id.

## P1: Bound retries without dropping unread mail — **Done as of 6032ce6** (R1 over-claimed); per-host breaker still Partial
Done (tested):
- One batch per recipient.
- At most 20 ids per batch. The remainder stays eligible for the next claim after the 30s gap (tests: "a batch names at most 20", "coalesces").
- New mail during an in-flight wake stays eligible.
- `woken_at` is not permanent: a re-wake happens after a 10-minute receipt timeout if the mail is still unoffered (tested).
- Exponential backoff, and give-up after 3 attempts. The mail is preserved (tested) and surfaces in the ledger, with a bounce to the sender.
- No automatic unarchive, resume or settings changes.

Partial:
- The circuit breaker is per message, not per host. "Archived" should be classified as permanent immediately instead of taking 3 attempts (listed follow-up).

## P1: Origin and authority — **Done, one Differs**
Done:
- The wake text is fixed and metadata-only: `[automated claude-peers wake — not from Kiel] message #N waiting …`.
- The watcher prints ids and reasons only; no peer-authored text reaches the operator model.
- Host ids are validated to exact regexes before reaching a shell (argv, no shell) or a tool.
- Binding is verified from evidence only:
  - the agent's own env, or the process tree, for `join`;
  - the MCP server env host id, matched to the bound session key;
  - or a Codex rollout file, for operator auto-connect.
- Ambiguity is refused.
- DND has no bypass (no urgency override was built).
- No "send as Kiel".

Differs:
- Explicit per-session opt-in was replaced by **on-by-default with a sticky explicit opt-out**, per Kiel. Mitigations: the rate limits, and the fixed metadata-only wake text.

Note:
- Bounces carry the wake error text, for example `codex queue` stderr (truncated to 200 chars, newlines stripped). That is tool output, not peer text, but it is external text entering a peer message.
- Claude cross-session delivery depends on matching permission modes. A mismatch is held for Kiel's approval, which is correct, and the operator skill checks its own mode on start.

## P2: Loops by causal chain — **Partial / Deferred**
- Done: per-recipient 30s gap and 20/hour cap. `reply_to` is stored and validated.
- Deferred: root/work-item id, causation id, hop count, per-root budgets, and manual release.
- Wake notices and bounces don't invite replies. Bounces never go to `cli`/`operator`, so bounce loops are impossible.

## P2: Dashboard — **Deferred (accepted in full)**
Not built. Accepted:
- independent receipt and wake tracks;
- `delivered=1` means ack, not arrival (arrival is `offer_count>0`);
- verdicts bound to artifact hashes;
- inert escaped rendering;
- read-only v1;
- a local access boundary, with Cloudflare Access on top.

## Acceptance matrix: what exists

| Case | Evidence |
|---|---|
| Idle Claude | test E live, plus later wakes |
| Idle Codex | tests B and F live; Astra #1224/#1225 live |
| Archived Codex | test D live: 3 attempts, then ledger and bounce |
| Approval-waiting (mode mismatch) | observed live, diagnosed from the operator log |
| Active session | observed live (#1235 stale wake), mitigated by the isRunning check |
| Restarted session | not tested |
| Concurrent claims | transaction-atomic; **no two-connection claim test yet** |
| Crash before/after dispatch | lease expiry → retry (tested); crash after dispatch → duplicate wake (harmless, not tested) |
| >20 backlog, arrivals during dispatch, opt-out/DND races, wrong-host identity | unit-tested |
| Multi-peer loops | not tested |

## Adopted from Astra's #1244 (live batch feedback)
- Bounce wording changed. It now reads "Could not ring X for your message #N … The message is NOT lost: it remains queued …" instead of "has not been delivered".
- Repeats: suppressed durably (`problem_reported`), and re-reported only when the reason changes. **Done.**
- Group notices per recipient and reason: **Deferred.** Next change to `supervise.ts`.

## Open items (ordered, R2)
0. Age window on `claimWakes`, so mail from before a peer joined is not rung.
1. Per-attempt wake table with explicit dispatch-uncertain state.
2. Classify "archived" as permanent: bounce at once and stop ringing.
3. Group bounces by recipient and reason.
4. Two-connection concurrent-claim test.
5. Causal-chain loop budgets.
6. Dashboard v1 (read-only).
7. Watcher self-reload on code change, so re-arming needs no manual step.

## Review record (R1.4, 2026-09-25 5:20 PM)
Astra **APPROVED** the claim corrections through **527ec2984e78e59f5a267b95ab13e0af7d2725e2**. Astra ran the exact extracted focused suites (68/68, 177 expects) and independent in-memory repros. Covered:
- failed completion: no refund;
- A-expire/B-claim: A's recheck and stale completion are rejected;
- B's completion works;
- duplicate completion is a no-op;
- exact claim expiry cannot dispatch or refund.

The failed-offer recovery fix (6032ce6) was approved earlier. Astra's review: `/Users/kielay/Delta-Analytical-Corp/delta-data-platform/docs/research/2026-09-25-astra-operator-disposition-review.md` (R1.4).

Scope of the approval (Astra's wording, kept): **bounded approval, not integrated design closure or production certification.** Deferred acceptance cases are untested, and so is migration of in-flight legacy state (claims made under the retired `wake_lease_until`). The watcher's 3-second re-arm is recorded as Opus's observation, not Astra's.

Open items remaining: 3 (group notices), 4 (two-watcher claim test), 5 (causal-chain budgets), 6 (dashboard), plus the claimWakes age window.
