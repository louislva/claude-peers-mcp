---
phase: 03
slug: decision-proxy
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-25
---

# Phase 03 — Validation Strategy

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
| 03-01-01 | 01 | 1 | PRXY-01, PRXY-02, PRXY-03, PRXY-04, PRXY-05 | unit | `bun test` | ❌ W0 | ⬜ pending |
| 03-02-01 | 02 | 1 | PRXY-01, PRXY-02, PRXY-03, PRXY-04, PRXY-05 | doc | `wc -l` | ❌ W0 | ⬜ pending |
| 03-03-01 | 03 | 2 | PRXY-01, PRXY-02, PRXY-03, PRXY-04, PRXY-05 | integration | `bun test` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `gsd-plugin/proxy/proxy-helpers.test.ts` — stubs for proxy lifecycle tests
- [ ] Test helpers for simulating discuss_choice/discuss_answer message exchange

*Existing broker.test.ts and executor-helpers.test.ts infrastructure provide patterns to follow.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| 60s timeout behavior under real load | PRXY-05 | Timing-dependent behavior hard to test deterministically | Verify timeout code path exists, test with short timeout override |

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
