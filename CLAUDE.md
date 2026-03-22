---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# claude-peers

Peer discovery and messaging MCP channel for Claude Code instances, wired into OpenClaw.

## Architecture

- `broker.ts` — Singleton HTTP daemon on localhost:7899 + SQLite. Auto-launched by the MCP server.
- `server.ts` — MCP stdio server, one per Claude Code instance. Connects to broker, exposes tools, pushes channel notifications. Sends events to OpenClaw.
- `shared/types.ts` — Shared TypeScript types for broker API.
- `shared/summarize.ts` — Local auto-summary from git branch + recent files (no LLM).
- `cli.ts` — CLI utility for inspecting broker state.

## OpenClaw Integration

Peer registration and summary updates fire `openclaw system event` (fire-and-forget, `next-heartbeat` mode) so OpenClaw can track all active Claude Code sessions.

## Running

```bash
# MCP server (configured in ~/.claude.json, auto-starts broker):
# { "claude-peers": { "command": "bun", "args": ["/Users/knox/Documents/Dev/claude-peers/server.ts"] } }

# CLI:
bun cli.ts status
bun cli.ts peers
bun cli.ts send <peer-id> <message>
bun cli.ts kill-broker
```

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install`
- Use `bun run <script>` instead of `npm run <script>`
- Bun automatically loads .env, so don't use dotenv.
- `Bun.serve()` for HTTP, `bun:sqlite` for SQLite, `Bun.file` over `node:fs`.
