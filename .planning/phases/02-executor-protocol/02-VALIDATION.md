---
phase: 02
slug: executor-protocol
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-25
---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | bun:test |
| **Config file** | none — uses bun built-in test runner |
| **Quick run command** | `bun test` |
| **Full suite command** | `bun test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `bun test`
- **After every plan wave:** Run `bun test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | EXEC-01 | unit | `bun test` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 1 | EXEC-02 | unit | `bun test` | ❌ W0 | ⬜ pending |
| 02-01-03 | 01 | 1 | EXEC-03 | unit | `bun test` | ❌ W0 | ⬜ pending |
| 02-02-01 | 02 | 2 | EXEC-04, EXEC-05 | unit | `bun test` | ❌ W0 | ⬜ pending |
| 02-02-02 | 02 | 2 | EXEC-06 | unit | `bun test` | ❌ W0 | ⬜ pending |
| 02-02-03 | 02 | 2 | EXEC-07, EXEC-08 | unit | `bun test` | ❌ W0 | ⬜ pending |
| 02-02-04 | 02 | 2 | EXEC-09 | unit | `bun test` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `executor.test.ts` — stubs for executor lifecycle tests (ACK, pre-validation, progress, completion, blocked, status, reclaim)
- [ ] Test helpers for simulating message receipt and broker endpoint responses

*Existing broker.test.ts infrastructure covers broker-side endpoints. Executor-specific tests need new file.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Push jitter timing | EXEC-08 | Random delay cannot be deterministically tested | Verify delay variable exists in code, check git push calls include jitter |

*Most behaviors have automated verification via unit tests and type-checking.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
