---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# claude-peers

Peer discovery and messaging MCP channel for Claude Code instances.

## Architecture

- `broker.ts` — Singleton HTTP daemon on a Unix socket + SQLite, managed by launchd. Acknowledged delivery, wake dispatch, peer retirement that preserves unread mail.
- `wake.ts` — Native wake transports (Claude inbox socket, `codex queue`) and the fixed nudge text.
- `server.ts` — MCP stdio server, one per agent session. Registers its agent PID and inbox socket, exposes tools; channel push only for Claude sessions without an inbox.
- `hooks/peers-hook.ts` — Claude Code / Codex turn-boundary hook: Stop block, git-staging reminder, Codex thread registration.
- `tests/` — `bun test`: broker spawned against a temp DB/socket with a fake inbox and fake `codex`; hook unit + end-to-end.
- `shared/types.ts` — Shared TypeScript types for broker API.
- `shared/summarize.ts` — Auto-summary generation via gpt-5.4-nano.
- `cli.ts` — CLI utility for inspecting broker state.

## Native wake transports (probed 2026-09-27, `scripts/probes/`)

- **Claude Code inbox** (v2.1.283): every Claude-spawned `server.ts` inherits
  `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`. Writing
  `{"type":"auth","token":T}\n{"type":"user","message":{"role":"user","content":TEXT}}\n`
  from a detached process (ppid 1) delivered mid-turn to a busy prompting session and started a turn
  in an idle one. Bypass-mode sessions were not probed; talking-stick reports that token-authenticated
  messages are delivered to them.
- **Codex queue** (codex-cli 0.157.1): `codex queue --thread <session_id> --message TEXT` started a turn
  in an idle loaded thread. Codex's `server.ts` gets no thread ID in its environment. The ID comes from
  the `SessionStart` hook payload (`session_id`), which fires on the first prompt, not at launch.
  Walking up from the hook's shell reaches the same `codex` PID that is the parent of `server.ts`,
  so the broker links thread to peer by `agent_pid`.

## Running

```bash
# Claude Code v2.1.224+: register the MCP server and run plain `claude`; the broker wakes it via
# the inbox socket. Install hooks/peers-hook.ts for Codex wakes and the Stop safety net.
# { "claude-peers": { "command": "bun", "args": ["./server.ts"] } }

# Fallback for older Claude Code only (channel push):
claude --dangerously-load-development-channels server:claude-peers

# Tests:
bun test

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
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
