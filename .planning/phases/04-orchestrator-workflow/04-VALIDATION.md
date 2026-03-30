---
phase: 04
slug: orchestrator-workflow
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-25
---

# Phase 04 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | bun:test |
| **Config file** | none — uses bun built-in test runner |
| **Quick run command** | `bun test` |
| **Full suite command** | `bun test` |
| **Estimated runtime** | ~8 seconds |

---

## Sampling Rate

- **After every task commit:** Run `bun test`
- **After every plan wave:** Run `bun test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 8 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | ORCH-01, ORCH-02, ORCH-03, ORCH-04, ORCH-11, ORCH-12, ORCH-13 | unit | `bun test` | ❌ W0 | ⬜ pending |
| 04-02-01 | 02 | 1 | ORCH-05, ORCH-06, ORCH-07, ORCH-08, ORCH-09, ORCH-10 | doc | `wc -l` | ❌ W0 | ⬜ pending |
| 04-03-01 | 03 | 2 | ORCH-01 through ORCH-13 | integration | `bun test` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `gsd-plugin/orchestrator/orchestrator-helpers.test.ts` — stubs for orchestrator tests
- [ ] Test helpers for simulating multi-peer scenarios with broker

*Existing broker.test.ts, executor-helpers.test.ts, and proxy-helpers.test.ts infrastructure provide patterns.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Multi-peer wave dispatch | ORCH-03 | Requires multiple concurrent Claude sessions | Run 2+ sessions, verify wave dispatch via broker logs |
| Executor death recovery | ORCH-09 | Requires killing a process mid-execution | Kill executor PID during task, verify reclaim and reassign |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 8s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
