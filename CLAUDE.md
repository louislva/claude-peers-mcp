---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# gsd-comms-mcp

Peer discovery and messaging MCP channel for Claude Code instances.

## Architecture

- `broker.ts` — Singleton HTTP daemon on localhost:7899 + SQLite. Auto-launched by the MCP server. All state transitions are atomic SQLite transactions.
- `server.ts` — MCP stdio server, one per Claude Code instance. Connects to broker, exposes tools, pushes channel notifications. ACK-based message delivery.
- `shared/types.ts` — Shared TypeScript types for broker API (Peer, Message, Session, Wave, TaskAssignment).
- `shared/summarize.ts` — Auto-summary generation via gpt-5.4-nano.
- `cli.ts` — CLI utility for inspecting broker state, monitoring DB, and maintenance.
- `bridges/` — External bridges. Each registers a stable peer id via `external_id` and shuttles messages between the broker and an external system. `bridges/common.ts` (BrokerClient + BridgeRunner) is the shared base; `bridges/telegram/telegram.ts` is the first concrete bridge.
- `broker.test.ts` — Integration tests covering all endpoints.

## Database

All state lives in a single SQLite file (`~/.gsd-comms.db`), shared across all sessions on the machine. The broker auto-migrates an existing `~/.claude-peers.db` to the new path on first start.

**Tables:**
- `peers` — Active Claude Code instances (cleaned on PID death)
- `messages` — Inter-peer messages (ACK-based delivery, auto-pruned after 24h)
- `sessions` — GSD hook session state (replaces temp files, auto-pruned after 7d)
- `waves` — Orchestration wave tracking (auto-pruned after 30d)
- `task_assignments` — Per-task state with file-conflict detection

**Indexes:** Partial indexes on all hot query paths (poll, prune, conflict-check, PID lookup, session cleanup).

**Retention:** Auto-prune every 5 min. Delivered messages: 24h. Completed sessions: 7d. Completed waves: 30d. WAL checkpoint every 2 min. All configurable via env vars.

## Running

```bash
# Start Claude Code with the channel:
claude --dangerously-load-development-channels server:gsd-comms

# Or just add to .mcp.json and use as regular MCP (no channel push, but tools work):
# { "gsd-comms": { "command": "bun", "args": ["./server.ts"] } }

# CLI:
bun cli.ts status          # Broker status + active peers
bun cli.ts peers           # List all peers
bun cli.ts send <id> <msg> # Send a message to a peer
bun cli.ts stats           # DB size, row counts, retention policy
bun cli.ts prune           # Force cleanup + VACUUM to reclaim disk
bun cli.ts db-path         # Print the database file path
bun cli.ts kill-broker     # Stop the broker daemon
```

## Broker API Endpoints

### Core (peer lifecycle)
| Method | Endpoint | Description |
|---|---|---|
| POST | `/register` | Register a new peer (atomic: cleans old PID) |
| POST | `/heartbeat` | Update peer's last_seen timestamp |
| POST | `/set-summary` | Update peer's summary |
| POST | `/list-peers` | List peers by scope (machine/directory/repo) |
| POST | `/unregister` | Remove peer + all FK references (atomic) |

### Messaging (ACK-based)
| Method | Endpoint | Description |
|---|---|---|
| POST | `/send-message` | Send message with optional `msg_type` + `payload` |
| POST | `/poll-messages` | Get undelivered messages (does NOT mark delivered) |
| POST | `/ack-message` | Mark message IDs as delivered |

### Sessions (GSD hook)
| Method | Endpoint | Description |
|---|---|---|
| POST | `/session-heartbeat` | Atomic: register peer + upsert session + sync summary |
| POST | `/session-status` | Get session state |
| POST | `/session-end` | Mark session completed + clean peer |

### Orchestration (waves + tasks)
| Method | Endpoint | Description |
|---|---|---|
| POST | `/wave-create` | Create wave + task assignments (atomic, idempotent) |
| POST | `/wave-status` | Get wave + all task states |
| POST | `/task-start` | Assign session to task (validates status + file conflicts) |
| POST | `/task-complete` | Complete task (auto-completes wave if all done) |
| POST | `/task-blocked` | Mark task blocked with reason |
| POST | `/conflict-check` | Check file list against running tasks |

### TUI + Monitoring
| Method | Endpoint | Description |
|---|---|---|
| POST | `/list-messages` | Recent N messages regardless of delivery (default 50, max 200) |
| POST | `/list-waves` | All waves with task count aggregates |
| GET | `/health` | Broker status + peer count |
| GET | `/stats` | DB size, row counts, retention config, schema version |
| POST | `/prune` | Trigger retention cleanup, returns pruned counts |
| POST | `/vacuum` | WAL checkpoint + VACUUM to reclaim disk space |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GSD_COMMS_PORT` | `7899` | Broker HTTP port |
| `GSD_COMMS_DB` | `~/.gsd-comms.db` | SQLite database path |
| `GSD_COMMS_RETAIN_MESSAGES_MS` | `86400000` (24h) | Delivered message retention |
| `GSD_COMMS_RETAIN_SESSIONS_MS` | `604800000` (7d) | Completed session retention |
| `GSD_COMMS_RETAIN_WAVES_MS` | `2592000000` (30d) | Completed wave retention |

The legacy `CLAUDE_PEERS_*` variants still work — the broker reads them with a one-line stderr deprecation notice. Set the new `GSD_COMMS_*` names to silence the notice.

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
