# Workspace Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** peers テーブルに workspace カラムを追加し、起動設定でワークスペースに参加、broadcast ツールでグループメッセージを送信できるようにする。

**Architecture:** 既存の peers テーブルに `workspace TEXT` カラムを追加。server.ts は起動時に CLI 引数または環境変数から workspace 名を読み取り、register 時に broker に送信する。broker は `/broadcast` エンドポイントで同一 workspace の全メンバーにメッセージを配信する。

**Tech Stack:** Bun, bun:sqlite, @modelcontextprotocol/sdk, bun test

---

## File Structure

| File | Role | Action |
|------|------|--------|
| `shared/types.ts` | 型定義 | Modify: workspace フィールド追加、BroadcastRequest/Response 追加 |
| `broker.ts` | broker daemon | Modify: workspace カラム追加、list-peers workspace スコープ、/broadcast エンドポイント |
| `server.ts` | MCP server | Modify: workspace 設定の読み取り、register に渡す、broadcast ツール追加、list_peers scope 拡張 |
| `cli.ts` | CLI ユーティリティ | Modify: workspace 表示追加 |
| `broker.test.ts` | broker テスト | Create: broker API のテスト |

---

### Task 1: 型定義の更新 (shared/types.ts)

**Files:**
- Modify: `shared/types.ts`

- [ ] **Step 1: Peer に workspace フィールドを追加**

`shared/types.ts` の `Peer` interface に追加:

```typescript
export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  workspace: string | null;  // <-- 追加
  registered_at: string;
  last_seen: string;
}
```

- [ ] **Step 2: RegisterRequest に workspace フィールドを追加**

```typescript
export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  workspace: string | null;  // <-- 追加
}
```

- [ ] **Step 3: ListPeersRequest の scope に "workspace" を追加**

```typescript
export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo" | "workspace";  // <-- "workspace" 追加
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
  workspace?: string | null;  // <-- 追加: workspace スコープ時のフィルタ値
}
```

- [ ] **Step 4: BroadcastRequest / BroadcastResponse を追加**

ファイル末尾に追加:

```typescript
export interface BroadcastRequest {
  from_id: PeerId;
  workspace: string;
  text: string;
}

export interface BroadcastResponse {
  ok: boolean;
  sent_to: number;
  error?: string;
}
```

- [ ] **Step 5: Commit**

```bash
git add shared/types.ts
git commit -m "feat: add workspace types to shared/types.ts"
```

---

### Task 2: broker のスキーマとハンドラ更新 (broker.ts)

**Files:**
- Modify: `broker.ts`
- Test: `broker.test.ts`

- [ ] **Step 1: テストファイルを作成し、broker の import 構造を確認**

`broker.test.ts` を作成。broker を直接 import するのではなく、テスト用に broker プロセスを起動してHTTP API をテストする統合テストとする:

```typescript
import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Peer, BroadcastResponse } from "./shared/types.ts";
import { Subprocess } from "bun";

const TEST_PORT = 17899;
const TEST_DB = `/tmp/claude-peers-test-${Date.now()}.db`;
const BROKER_URL = `http://127.0.0.1:${TEST_PORT}`;

let brokerProc: Subprocess;

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, opts);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

beforeAll(async () => {
  brokerProc = Bun.spawn(["bun", "broker.ts"], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(TEST_PORT),
      CLAUDE_PEERS_DB: TEST_DB,
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  // Wait for broker to come up
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Broker did not start");
});

afterAll(async () => {
  brokerProc.kill();
  await brokerProc.exited;
  try { await Bun.file(TEST_DB).exists() && (await Bun.$`rm -f ${TEST_DB} ${TEST_DB}-wal ${TEST_DB}-shm`); } catch {}
});

test("register peer without workspace", async () => {
  const res = await brokerFetch<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp",
    git_root: null,
    tty: null,
    summary: "test peer",
    workspace: null,
  });
  expect(res.id).toBeDefined();
  expect(typeof res.id).toBe("string");
});

test("register peer with workspace", async () => {
  const res = await brokerFetch<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp",
    git_root: null,
    tty: null,
    summary: "workspace peer",
    workspace: "test-ws",
  });
  expect(res.id).toBeDefined();
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `bun test broker.test.ts`
Expected: "register peer with workspace" は pass する(broker は未知フィールドを無視する)が、workspace は保存されない。

- [ ] **Step 3: peers テーブルに workspace カラムを追加**

`broker.ts` の CREATE TABLE 文を変更:

```typescript
db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    workspace TEXT DEFAULT NULL,
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);
```

既存 DB への対応として、テーブル作成直後に ALTER TABLE を追加:

```typescript
// Migrate: add workspace column if missing (existing DBs)
try {
  db.run("ALTER TABLE peers ADD COLUMN workspace TEXT DEFAULT NULL");
} catch {
  // Column already exists, ignore
}
```

- [ ] **Step 4: handleRegister で workspace を受け取り保存**

`insertPeer` prepared statement を更新:

```typescript
const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, workspace, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
```

`handleRegister` を更新:

```typescript
function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();

  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, body.workspace ?? null, now, now);
  return { id };
}
```

import に `BroadcastRequest` と `BroadcastResponse` を追加:

```typescript
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  BroadcastRequest,
  BroadcastResponse,
  Peer,
  Message,
} from "./shared/types.ts";
```

- [ ] **Step 5: list-peers に workspace スコープを追加**

workspace スコープ用の prepared statement を追加:

```typescript
const selectPeersByWorkspace = db.prepare(`
  SELECT * FROM peers WHERE workspace = ?
`);
```

`handleListPeers` の switch に workspace case を追加:

```typescript
case "workspace":
  if (body.workspace) {
    peers = selectPeersByWorkspace.all(body.workspace) as Peer[];
  } else {
    peers = [];
  }
  break;
```

- [ ] **Step 6: /broadcast エンドポイントを追加**

ハンドラ関数を追加:

```typescript
function handleBroadcast(body: BroadcastRequest): BroadcastResponse {
  // Find all peers in the same workspace, excluding sender
  const targets = (selectPeersByWorkspace.all(body.workspace) as Peer[])
    .filter((p) => p.id !== body.from_id);

  if (targets.length === 0) {
    return { ok: false, sent_to: 0, error: "No other peers in workspace" };
  }

  const now = new Date().toISOString();
  for (const target of targets) {
    insertMessage.run(body.from_id, target.id, body.text, now);
  }

  return { ok: true, sent_to: targets.length };
}
```

HTTP サーバーの switch に case を追加:

```typescript
case "/broadcast":
  return Response.json(handleBroadcast(body as BroadcastRequest));
```

- [ ] **Step 7: テストに workspace スコープと broadcast のテストを追加**

`broker.test.ts` に追加:

```typescript
test("list-peers with workspace scope", async () => {
  // Register two peers in same workspace
  const peer1 = await brokerFetch<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp/a",
    git_root: null,
    tty: null,
    summary: "peer1",
    workspace: "ws-scope-test",
  });
  const peer2 = await brokerFetch<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp/b",
    git_root: null,
    tty: null,
    summary: "peer2",
    workspace: "ws-scope-test",
  });

  // Register a peer in a different workspace
  await brokerFetch<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp/c",
    git_root: null,
    tty: null,
    summary: "peer3",
    workspace: "other-ws",
  });

  const peers = await brokerFetch<Peer[]>("/list-peers", {
    scope: "workspace",
    cwd: "/tmp",
    git_root: null,
    workspace: "ws-scope-test",
  });

  // Should only find peers in ws-scope-test
  const ids = peers.map((p) => p.id);
  expect(ids).toContain(peer1.id);
  expect(ids).toContain(peer2.id);
  // peer3 should not be included
  expect(peers.every((p) => p.workspace === "ws-scope-test")).toBe(true);
});

test("broadcast sends to all workspace members", async () => {
  // Register sender in workspace
  const sender = await brokerFetch<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp/sender",
    git_root: null,
    tty: null,
    summary: "sender",
    workspace: "broadcast-test",
  });

  // Register two receivers in same workspace
  const recv1 = await brokerFetch<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp/recv1",
    git_root: null,
    tty: null,
    summary: "receiver1",
    workspace: "broadcast-test",
  });
  const recv2 = await brokerFetch<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp/recv2",
    git_root: null,
    tty: null,
    summary: "receiver2",
    workspace: "broadcast-test",
  });

  // Broadcast
  const result = await brokerFetch<BroadcastResponse>("/broadcast", {
    from_id: sender.id,
    workspace: "broadcast-test",
    text: "hello workspace!",
  });

  expect(result.ok).toBe(true);
  expect(result.sent_to).toBe(2);

  // Verify messages were delivered
  const msgs1 = await brokerFetch<{ messages: Array<{ text: string; from_id: string }> }>("/poll-messages", { id: recv1.id });
  expect(msgs1.messages.some((m) => m.text === "hello workspace!" && m.from_id === sender.id)).toBe(true);

  const msgs2 = await brokerFetch<{ messages: Array<{ text: string; from_id: string }> }>("/poll-messages", { id: recv2.id });
  expect(msgs2.messages.some((m) => m.text === "hello workspace!" && m.from_id === sender.id)).toBe(true);
});

test("broadcast to empty workspace returns error", async () => {
  const sender = await brokerFetch<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/tmp/alone",
    git_root: null,
    tty: null,
    summary: "alone",
    workspace: "empty-ws",
  });

  const result = await brokerFetch<BroadcastResponse>("/broadcast", {
    from_id: sender.id,
    workspace: "empty-ws",
    text: "echo?",
  });

  expect(result.ok).toBe(false);
  expect(result.error).toBe("No other peers in workspace");
});
```

- [ ] **Step 8: テストを実行して pass を確認**

Run: `bun test broker.test.ts`
Expected: 全テスト PASS

- [ ] **Step 9: Commit**

```bash
git add broker.ts broker.test.ts
git commit -m "feat: add workspace column, workspace scope, and /broadcast endpoint to broker"
```

---

### Task 3: MCP server のワークスペース対応 (server.ts)

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: workspace 設定の読み取りを追加**

`server.ts` の Configuration セクション(BROKER_SCRIPT の後)に追加:

```typescript
// Parse workspace from CLI args or environment variable
function resolveWorkspace(): string | null {
  const wsArgIndex = process.argv.indexOf("--workspace");
  if (wsArgIndex !== -1 && process.argv[wsArgIndex + 1]) {
    return process.argv[wsArgIndex + 1];
  }
  return process.env.CLAUDE_PEERS_WORKSPACE ?? null;
}

const MY_WORKSPACE = resolveWorkspace();
```

- [ ] **Step 2: State セクションに myWorkspace を追加**

```typescript
let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;
const myWorkspace: string | null = MY_WORKSPACE;  // <-- 追加
```

- [ ] **Step 3: register 呼び出しに workspace を追加**

`main()` 関数内の register 呼び出し(491行目付近)を更新:

```typescript
const reg = await brokerFetch<RegisterResponse>("/register", {
  pid: process.pid,
  cwd: myCwd,
  git_root: myGitRoot,
  tty,
  summary: initialSummary,
  workspace: myWorkspace,  // <-- 追加
});
```

log にも追加:

```typescript
log(`Registered as peer ${myId}`);
if (myWorkspace) log(`Workspace: ${myWorkspace}`);
```

- [ ] **Step 4: list_peers ツールの scope enum に "workspace" を追加**

TOOLS 配列の `list_peers` を更新:

```typescript
{
  name: "list_peers",
  description:
    "List other Claude Code instances running on this machine. Returns their ID, working directory, git repo, and summary.",
  inputSchema: {
    type: "object" as const,
    properties: {
      scope: {
        type: "string" as const,
        enum: ["machine", "directory", "repo", "workspace"],
        description:
          'Scope of peer discovery. "machine" = all instances on this computer. "directory" = same working directory. "repo" = same git repository. "workspace" = same named workspace group.',
      },
    },
    required: ["scope"],
  },
},
```

- [ ] **Step 5: list_peers ハンドラで workspace を broker に送信**

`case "list_peers"` 内の brokerFetch 呼び出しを更新:

```typescript
const peers = await brokerFetch<Peer[]>("/list-peers", {
  scope,
  cwd: myCwd,
  git_root: myGitRoot,
  exclude_id: myId,
  workspace: myWorkspace,  // <-- 追加
});
```

list_peers の出力フォーマットに workspace 表示を追加:

```typescript
const lines = peers.map((p) => {
  const parts = [
    `ID: ${p.id}`,
    `PID: ${p.pid}`,
    `CWD: ${p.cwd}`,
  ];
  if (p.git_root) parts.push(`Repo: ${p.git_root}`);
  if (p.workspace) parts.push(`Workspace: ${p.workspace}`);  // <-- 追加
  if (p.tty) parts.push(`TTY: ${p.tty}`);
  if (p.summary) parts.push(`Summary: ${p.summary}`);
  parts.push(`Last seen: ${p.last_seen}`);
  return parts.join("\n  ");
});
```

- [ ] **Step 6: broadcast ツールを TOOLS 配列に追加**

TOOLS 配列に追加:

```typescript
{
  name: "broadcast",
  description:
    "Send a message to all members of your workspace. Only works if you are in a workspace (configured via --workspace flag or CLAUDE_PEERS_WORKSPACE env var).",
  inputSchema: {
    type: "object" as const,
    properties: {
      message: {
        type: "string" as const,
        description: "The message to broadcast to all workspace members",
      },
    },
    required: ["message"],
  },
},
```

- [ ] **Step 7: broadcast ツールのハンドラを追加**

`CallToolRequestSchema` ハンドラの switch に追加:

```typescript
case "broadcast": {
  const { message } = args as { message: string };
  if (!myId) {
    return {
      content: [{ type: "text" as const, text: "Not registered with broker yet" }],
      isError: true,
    };
  }
  if (!myWorkspace) {
    return {
      content: [
        {
          type: "text" as const,
          text: "Not in a workspace. Configure with --workspace flag or CLAUDE_PEERS_WORKSPACE env var.",
        },
      ],
      isError: true,
    };
  }
  try {
    const result = await brokerFetch<BroadcastResponse>("/broadcast", {
      from_id: myId,
      workspace: myWorkspace,
      text: message,
    });
    if (!result.ok) {
      return {
        content: [{ type: "text" as const, text: `Broadcast failed: ${result.error}` }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `Broadcast sent to ${result.sent_to} peer(s) in workspace "${myWorkspace}"`,
        },
      ],
    };
  } catch (e) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error broadcasting: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
      isError: true,
    };
  }
}
```

- [ ] **Step 8: import に BroadcastResponse を追加**

```typescript
import type {
  PeerId,
  Peer,
  RegisterResponse,
  PollMessagesResponse,
  BroadcastResponse,  // <-- 追加
  Message,
} from "./shared/types.ts";
```

- [ ] **Step 9: instructions に workspace と broadcast の説明を追加**

MCP Server の instructions 文字列を更新。`Available tools:` セクションに追加:

```
- broadcast: Send a message to all members of your workspace (requires --workspace config)
```

`list_peers` の説明も更新:

```
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo/workspace)
```

- [ ] **Step 10: Commit**

```bash
git add server.ts
git commit -m "feat: add workspace config, workspace scope, and broadcast tool to MCP server"
```

---

### Task 4: CLI のワークスペース表示更新 (cli.ts)

**Files:**
- Modify: `cli.ts`

- [ ] **Step 1: status コマンドの peer 出力に workspace を追加**

`cli.ts` の status ケース(62行目付近)のピア表示ループ内で、workspace 行を追加:

```typescript
for (const p of peers) {
  console.log(`  ${p.id}  PID:${p.pid}  ${p.cwd}`);
  if (p.summary) console.log(`         ${p.summary}`);
  if (p.workspace) console.log(`         Workspace: ${p.workspace}`);  // <-- 追加
  if (p.tty) console.log(`         TTY: ${p.tty}`);
  console.log(`         Last seen: ${p.last_seen}`);
}
```

- [ ] **Step 2: peers コマンドの出力に workspace を追加**

`cli.ts` の peers ケース(97行目付近)を更新:

```typescript
for (const p of peers) {
  const parts = [`${p.id}  PID:${p.pid}  ${p.cwd}`];
  if (p.summary) parts.push(`  Summary: ${p.summary}`);
  if (p.workspace) parts.push(`  Workspace: ${p.workspace}`);  // <-- 追加
  console.log(parts.join("\n"));
}
```

- [ ] **Step 3: peer 型の型注釈に workspace を追加**

status と peers コマンド内の型注釈(46-56行目付近、77-88行目付近)に `workspace: string | null` を追加:

```typescript
const peers = await brokerFetch<
  Array<{
    id: string;
    pid: number;
    cwd: string;
    git_root: string | null;
    tty: string | null;
    workspace: string | null;  // <-- 追加
    summary: string;
    last_seen: string;
  }>
>("/list-peers", { /* ... */ });
```

- [ ] **Step 4: Commit**

```bash
git add cli.ts
git commit -m "feat: display workspace info in CLI output"
```

---

### Task 5: 統合テストの実行と最終確認

**Files:**
- Test: `broker.test.ts`

- [ ] **Step 1: 全テストを実行**

Run: `bun test`
Expected: 全テスト PASS

- [ ] **Step 2: TypeScript の型チェック**

Run: `bunx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 3: broker を手動起動して動作確認**

```bash
CLAUDE_PEERS_PORT=17899 CLAUDE_PEERS_DB=/tmp/manual-test.db bun broker.ts &
```

workspace 付きで register:
```bash
curl -s -X POST http://127.0.0.1:17899/register \
  -H 'Content-Type: application/json' \
  -d '{"pid":1,"cwd":"/tmp","git_root":null,"tty":null,"summary":"test","workspace":"my-ws"}' | jq .
```

Expected: `{ "id": "<8-char-id>" }`

- [ ] **Step 4: Commit (テスト修正があれば)**

```bash
git add -A
git commit -m "fix: resolve any test/type issues found during integration testing"
```

(修正がなければ skip)
