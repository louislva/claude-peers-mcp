# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — Peer-Aware Autonomous Execution

**Shipped:** 2026-03-25
**Phases:** 5 | **Plans:** 13 | **Sessions:** 1

### What Was Built
- Shared type contracts: 13 message types, 9 payload interfaces, discriminated union map for type-safe payload access
- Executor peer protocol: 14 helper functions, agent instruction document, 27 integration tests
- Decision proxy protocol: 8 helper functions, agent instruction document, 12 integration tests
- Orchestrator workflow: Kahn's topological sort, wave dispatch, monitoring, death recovery, delegation logic, sequential fallback — 29 integration tests
- Standalone runtime module with extracted core algorithms, mixed-state peer-availability test, two-session smoke test runbook
- 99 total integration tests across 4 test files, all passing

### What Worked
- Wave-based parallel execution of plans within each phase cut execution time significantly
- The "one helpers module + one agent doc + tests" pattern from Phase 2 scaled perfectly to Phases 3-4
- Infrastructure phase detection in autonomous mode skipped interactive discuss for all phases — massive token savings
- Plan checker caught real issues in Phase 4 (missing test coverage for 5 requirements, Nyquist gaps) and the revision loop fixed them in one pass
- Dynamic import pattern for tests (setting env vars before import) worked reliably across all test files

### What Was Inefficient
- VALIDATION.md was created for each phase but never formally signed off — the Nyquist workflow added overhead without full follow-through
- Plan 04-02 was initially scoped as a single mega-task (9+ functions) — caught by plan checker but could have been caught earlier
- `brokerFetch` duplication across 4 modules (executor, proxy, orchestrator, runtime) — correct per project policy but adds maintenance surface

### Patterns Established
- Per-module self-contained brokerFetch: each helper module duplicates the HTTP helper rather than sharing imports
- Integration tests on isolated broker ports: 17899 (broker), 17901 (executor), 17902 (proxy), 17903 (orchestrator)
- Agent docs follow strict structure: state machine, message dispatch, step-by-step protocol, security rules, helper reference table, constraints
- Test files use dynamic imports (`await import()`) inside `beforeAll` to allow env var overrides for broker port

### Key Lessons
1. Plan checkers earn their keep on complex phases — Phase 4's initial plans had 4 blockers that would have caused execution failures
2. Infrastructure phase detection is safe and saves significant tokens — all 5 phases were correctly identified as infrastructure
3. The executor/proxy/orchestrator trio pattern (helpers + agent doc + tests) is a reusable blueprint for any multi-role peer protocol
4. One field name mismatch (`error` vs `reason` in `reclaimExecutorTask`) slipped through all verification layers — integration checkers should add field-name contract verification

### Cost Observations
- Model mix: ~30% opus (planning), ~65% sonnet (research, execution, verification), ~5% orchestration overhead
- Sessions: 1 continuous autonomous session
- Notable: Autonomous mode with infrastructure phase skip kept the entire 5-phase milestone in a single session

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Key Change |
|-----------|----------|--------|------------|
| v1.0 | 1 | 5 | First autonomous run — established wave-based execution + plan checker revision loop |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-Dep Additions |
|-----------|-------|----------|-------------------|
| v1.0 | 99 | All pass | 0 (Bun built-ins only) |

### Top Lessons (Verified Across Milestones)

1. Plan checker revision loops catch real issues and pay for themselves on phases with 3+ plans
2. Infrastructure phase detection correctly skips interactive discuss when all success criteria are technical
