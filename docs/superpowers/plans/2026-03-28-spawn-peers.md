# spawn_peers Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans

**Goal:** Ghostty AppleScript ile Claude Code peer'larını otomatik spawn eden MCP tool'u eklemek.

**Architecture:** `shared/spawner.ts` AppleScript oluşturup osascript ile çalıştırır, `server.ts` tool olarak expose eder.

**Tech Stack:** TypeScript, Bun, AppleScript/osascript, Ghostty 1.3+

---

### Task 1: shared/spawner.ts — Ghostty Spawner

**Files:**
- Create: `shared/spawner.ts`
- Create: `tests/spawner.test.ts`

### Task 2: server.ts — spawn_peers Tool

**Files:**
- Modify: `server.ts`

### Task 3: Docs ve CHANGELOG

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `CHANGELOG.md`
