---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# claude-peers (v0.3)

Peer discovery and messaging MCP channel for Claude Code instances. v0.3 introduces group isolation (TOFU), resumable identity, WebSocket push, and a dual `instance_token` / `peer_id` model.

## Architecture

Three entrypoints. Two deployment modes (local-only vs remote broker over SSH).

- `client.ts` -- Local stdio shim (PC client side). Detects local context (cwd, git_root, branch, recent files, hostname, pid, project_key from `git remote get-url origin` normalized) and resolves the group locally via `resolveGroup` from `shared/config.ts`. Spawns `ssh user@broker-host bun <remote_server_path>`, forwards stdio between Claude Code and ssh. Sends a JSON handshake `{"client_meta": {...}}` on stdin's first line, including `group_id` (`sha256(secret).slice(0,32)`), `group_secret_hash` (full sha256 hex), and `groups_map` (name -> group_id, no secrets). The plaintext secret never leaves the PC. Required only for remote-broker mode. After registration, intercepts the `[claude-peers] Registered as peer '...'` log line from server stderr and writes the `peer_id` to `~/.claude/peers/peer-id-<cwd-key>.txt` (where `cwd-key` is the last 40 chars of `cwd` sanitized to `[a-zA-Z0-9-_]`). This file is read by `status-line.sh` to display the active peer identity in the Claude Code status bar.
- `server.ts` -- MCP stdio server (one per session). Reads the handshake via a custom stdin stream (PassThrough) before connecting `StdioServerTransport`. Falls back to local context detection (and local group resolution) after a 2s timeout if no handshake arrives. Registers with the broker, opens a loopback WebSocket on `/ws` for push delivery, falls back to polling every 30s when WS is up and 5s when WS is down. SIGINT/SIGTERM transitions the peer to dormant via `/disconnect` (resume-able), not `/unregister` (DELETE). Holds eight MCP tools: `list_peers`, `send_message`, `set_summary`, `check_messages`, `whoami`, `list_groups`, `switch_group`, `set_id`.
- `broker.ts` -- Singleton HTTP + WebSocket daemon on `127.0.0.1:<port>` + SQLite. v0.3 schema: tables `groups` (TOFU registry), `peers` (PK = `instance_token` UUID, unique `(peer_id, group_id)`), `messages` (FK to `instance_token`, includes `group_id` for cross-group rejection), `peer_sessions` (resume keyed by `session_key = sha256(host || \0 || cwd || \0 || group_id)`). Cleanup is two-phase: dead `pid` (via `process.kill(pid, 0)`) -> dormant; dormant past `CLAUDE_PEERS_DORMANT_TTL_HOURS` (default 24) -> DELETE cascade. Endpoints: `/register`, `/heartbeat`, `/set-summary`, `/disconnect`, `/unregister`, `/set-id`, `/list-peers`, `/send-message`, `/poll-messages`, `/group-stats`, `/admin/peers[?include_dormant=1]`, plus the `/ws` upgrade. WebSocket auth happens in the first frame (`{"type":"auth","instance_token":"..."}`); on success the broker pushes pending messages immediately. Idle timeout 600s.
- `shared/config.ts` -- Centralized configuration loader. Settings: env var > settings file > default. Group resolution (v0.3) is hierarchical: `.claude-peers.local.json` > `.claude-peers.json` (walking up to git_root) > user config `default_group` > env `CLAUDE_PEERS_GROUP` > sentinel `'default'`. Helpers: `resolveGroup`, `resolveGroupName`, `resolveGroupSecret`, `computeGroupId`, `computeGroupSecretHash`. Settings file at `$XDG_CONFIG_HOME/claude-peers/config.json` (Linux/macOS) or `%APPDATA%\claude-peers\config.json` (Windows). The `groups` field maps logical names to secrets; `default_group` picks one.
- `shared/types.ts` -- Shared types. v0.3 entities: `InstanceToken` (UUID v4 routing), `PeerId` (display, mutable), `GroupId` (32-hex or 'default'), `Peer` (full row with `status: 'active' | 'dormant'`), `Message` (with `from_token`/`to_token` and `group_id`), `ClientMeta` (handshake with `group_id`, `group_secret_hash`, `groups_map`), `WsAuthFrame`, `WsMessageFrame`.
- `shared/summarize.ts` -- Auto-summary generation. Multi-provider: Anthropic (`api.anthropic.com/v1/messages`) or any OpenAI-compatible `/chat/completions` endpoint (LiteLLM, Ollama via `/v1`, vLLM, OpenAI, OpenRouter). Provider selection via `CLAUDE_PEERS_SUMMARY_PROVIDER` (default `auto` resolves at runtime). Heuristic fallback always returns a non-empty string on any failure. Also hosts `computeProjectKey` and `normalizeRemoteUrl`.
- `cli.ts` -- CLI utility for inspecting broker state. Talks to the broker on loopback, so run it on the broker host. Subcommands: `status`, `peers [--include-dormant]`, `groups`, `kill-broker`. The legacy `send` subcommand was removed in v0.3 since the broker requires a valid `instance_token` for routing.

## Identity model (v0.3)

- `instance_token` (UUID v4, immutable) -- internal routing key. FK target for `messages`, key of the WebSocket pool, key of `peer_sessions`. Never exposed to Claude.
- `peer_id` (display, mutable via `set_id`) -- what `list_peers`, `whoami`, `send_message` speak. Unique per `(peer_id, group_id)`, all statuses included (renaming over a dormant peer's name is rejected with 409).

The default `peer_id` is derived from `(host, cwd, group_id)` via `deriveDefaultId` with a `MAX_SUFFIX=1000` guardrail. Typical defaults look like `olivier-pc-claude-peers-mcp` or `olivier-pc-foo-2` on collision.

## Resume flow (v0.3)

`session_key = sha256(host || \0 || cwd || \0 || group_id)`. On `/register`:
- session_key exists, peer is dormant -> bascule en active, returns the same `(peer_id, instance_token)`.
- session_key exists, peer is active but recorded `pid` is dead -> treat as dormant -> resurrect.
- session_key exists, peer is genuinely active (live pid) -> session_key collision: mint a fresh `(peer_id, instance_token)` with derived suffix; the original keeps the canonical session.
- session_key exists but the row was purged -> reuse the remembered `instance_token`, mint a fresh display id.
- Else -> fresh registration.

## Running

See `README.md` for full local-mode and remote-mode setup. Quick references:

```bash
# Local mode (broker auto-spawned alongside server.ts):
claude --dangerously-load-development-channels server:claude-peers

# Remote mode (broker on a LXC/server, client.ts forwards via ssh):
#   .mcp.json
#   {
#     "claude-peers": {
#       "command": "bun",
#       "args": ["./client.ts"],
#       "env": { "CLAUDE_PEERS_REMOTE": "user@broker-host" }
#     }
#   }

# CLI (run on the broker host):
bun cli.ts status
bun cli.ts peers [--include-dormant]
bun cli.ts groups
bun cli.ts kill-broker        # Linux/macOS only (uses lsof)
```

## Smoke check

`bun build --target=bun broker.ts server.ts client.ts cli.ts --outdir=/tmp/cp-check` bundles all entrypoints in ~20 ms and surfaces any import or type-resolution error. Use this between refactors instead of running each file. For type-strict checks: `bunx tsc --noEmit --skipLibCheck --module esnext --target es2022 --moduleResolution bundler --allowImportingTsExtensions broker.ts server.ts client.ts cli.ts`.

`bun test` runs the v0.3 suite (7 files, 36 cases): `tests/broker-groups.test.ts` (TOFU + isolation), `broker-resume.test.ts` (identity stability), `broker-set-id.test.ts` (rename + collision), `broker-websocket.test.ts` (auth, push, flush), `broker-status.test.ts` (dormant lifecycle, TTL purge), `client-config.test.ts` (group resolution hierarchy), `server-handshake.test.ts` (handshake contract). Each suite spins up an ephemeral broker on a random port via `tests/_helper.ts` and tears it down in `afterAll`.

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
