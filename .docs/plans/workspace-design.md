# Workspace Feature Design

## Overview

claude-peers にワークスペース(名前付きグループ)機能を追加する。
複数の Claude Code インスタンスをワークスペースにまとめ、グループ内へのブロードキャストメッセージを可能にする。

## Design Decisions

- **1 peer = 1 workspace** の制約を採用。peers テーブルに `workspace` カラムを追加するだけで実現する。
- ワークスペースのライフサイクルは暗黙的。専用テーブルは持たず、メンバーがいる間だけ存在する。
- 新規ツールは `broadcast` のみ。join/leave/create/delete は起動設定とプロセスライフサイクルで代替する。

## Data Model

`peers` テーブルにカラム追加:

```sql
ALTER TABLE peers ADD COLUMN workspace TEXT DEFAULT NULL;
```

- `NULL`: ワークスペース未参加(従来互換)
- 値あり: そのワークスペースに所属
- 存在するワークスペース一覧は `SELECT DISTINCT workspace FROM peers WHERE workspace IS NOT NULL` で導出

## Configuration (server.ts)

起動時に以下の優先順位で workspace 名を決定:

1. CLI 引数: `--workspace <name>`
2. 環境変数: `CLAUDE_PEERS_WORKSPACE`
3. なし -> `null`(従来通りの動作)

設定例:

```jsonc
// .mcp.json (CLI 引数)
{
  "claude-peers": {
    "command": "bun",
    "args": ["./server.ts", "--workspace", "frontend-refactor"]
  }
}

// .mcp.json (環境変数)
{
  "claude-peers": {
    "command": "bun",
    "args": ["./server.ts"],
    "env": {
      "CLAUDE_PEERS_WORKSPACE": "frontend-refactor"
    }
  }
}
```

## Broker API Changes (broker.ts)

### 変更: POST /register

`RegisterRequest` に `workspace: string | null` フィールドを追加。peers テーブルに保存する。

### 変更: POST /list-peers

`ListPeersRequest` の `scope` に `"workspace"` を追加。
`scope: "workspace"` の場合、リクエスト元と同じ workspace を持つ peer を返す。

### 新規: POST /broadcast

リクエスト:
```typescript
{
  from_id: string;
  workspace: string;
  text: string;
}
```

同一 workspace の全メンバー(送信者除く)に対して messages テーブルに INSERT する。
workspace に誰もいない、または workspace が一致しない場合はエラーを返す。

## MCP Tool Changes (server.ts)

### 変更: list_peers

`scope` の enum に `"workspace"` を追加。

### 新規: broadcast

```typescript
{
  name: "broadcast",
  description: "Send a message to all members of your workspace.",
  inputSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "The message to broadcast"
      }
    },
    required: ["message"]
  }
}
```

- workspace 未参加の場合はエラーを返す
- 内部的に broker の `/broadcast` を呼ぶ

## Type Changes (shared/types.ts)

- `Peer`: `workspace: string | null` を追加
- `RegisterRequest`: `workspace: string | null` を追加
- `ListPeersRequest.scope`: `"workspace"` を追加
- `BroadcastRequest`: 新規型 `{ from_id: PeerId; workspace: string; text: string }`
- `BroadcastResponse`: 新規型 `{ ok: boolean; sent_to: number; error?: string }`

## CLI Changes (cli.ts)

- `status` / `peers` コマンドの出力に `Workspace: <name>` を追加(設定されている場合のみ)

## Backward Compatibility

- workspace はオプショナル(デフォルト `NULL`)なので、既存の設定で動作は変わらない
- 既存の MCP ツール(`send_message`, `set_summary`, `check_messages`)は変更なし
- `list_peers` の既存スコープ(`machine`, `directory`, `repo`)の動作は変わらない
