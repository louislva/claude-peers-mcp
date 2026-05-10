# Bug Report: /send-message Returns OK But Messages Silently Disappear

**Date:** 2026-03-31
**Component:** broker.ts — message lifecycle
**Severity:** Low (not a code defect — expected behavior with misleading observability)

---

## Reported Symptom

After registering a peer via curl and sending a message through `/send-message`, the endpoint returns `{"ok":true}` but `/stats` shows `messages_total: 0`. Messages appear to be silently dropped.

```bash
# Register a peer with a fake PID
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"peer_id":"cli-arc","name":"arc-session","pid":12345,...}' \
  http://127.0.0.1:7899/register
# Returns: {"id":"ms7xflq0"}

# Send a message
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"from_id":"ms7xflq0","to_id":"2ves3xzu","text":"Hello"}' \
  http://127.0.0.1:7899/send-message
# Returns: {"ok":true}

# Check stats — message is gone
curl -s http://127.0.0.1:7899/stats
# messages_total: 0
```

## Initial Hypotheses

1. Missing `await` on the DB insert
2. INSERT SQL not matching the current `messages` table schema
3. A try/catch swallowing the error and returning `{"ok":true}` anyway

## Investigation

### Schema vs INSERT — Match Confirmed

The `messages` table schema (line 63) and the `insertMessage` prepared statement (line 171) were compared. All 7 columns align exactly:

| Table Column | INSERT Binding |
|---|---|
| `from_id TEXT NOT NULL` | `?` (param 1) |
| `to_id TEXT NOT NULL` | `?` (param 2) |
| `text TEXT NOT NULL` | `?` (param 3) |
| `msg_type TEXT NOT NULL` | `?` (param 4) |
| `payload TEXT NOT NULL` | `?` (param 5) |
| `sent_at TEXT NOT NULL` | `?` (param 6) |
| `delivered INTEGER` | `0` (hardcoded) |

No schema mismatch.

### Async/Await — Not Applicable

All SQLite operations use `bun:sqlite`, which is synchronous. There are no missing `await` calls. The `sendMessageTxn` (line 507) is a synchronous `db.transaction()` wrapper.

### Error Handling — Correct

The outer `try/catch` at line 958 catches thrown errors and returns `500`. The transaction itself checks that the target peer exists (line 508) and returns `{ ok: false }` if not. No error is being swallowed.

### Reproduction — Message IS Persisted, Then Deleted

Registering a peer with a real PID and sending a message confirmed `messages_total: 1` immediately after. The message **is inserted successfully**.

The disappearance was traced to the **stale-peer cleanup cycle**:

1. `cleanStalePeers()` runs every 30 seconds (line 395)
2. It checks each registered peer's PID via `process.kill(pid, 0)`
3. If the PID is dead (e.g., fake PID 12345), it calls `cleanStalePeerTxn(peer.id)`
4. `cleanPeerRefs()` (line 258) runs: `DELETE FROM messages WHERE from_id = ? OR to_id = ?`
5. **All messages sent by or to that peer are deleted**

### Root Cause

Not a bug. The broker is designed to cascade-delete all FK references when a peer is cleaned up. When testing with fake PIDs, the peer is removed within 30 seconds, taking its messages with it. With real Claude Code instances (live PIDs), messages persist correctly.

The issue is purely an **observability gap** — nothing logged when messages were deleted by cleanup, making the disappearance appear silent.

## Fix Applied

Two logging additions to `broker.ts`:

### 1. `cleanPeerRefs` — Log Message Deletion Count

```typescript
// Before
function cleanPeerRefs(peerId: string) {
  db.run("DELETE FROM messages WHERE from_id = ? OR to_id = ?", [peerId, peerId]);
  ...
}

// After
function cleanPeerRefs(peerId: string, reason?: string) {
  const msgCount = (db.query(
    "SELECT COUNT(*) as cnt FROM messages WHERE from_id = ? OR to_id = ?"
  ).get(peerId, peerId) as { cnt: number }).cnt;
  if (msgCount > 0) {
    console.error(
      `[claude-peers broker] cleaning peer ${peerId}${reason ? ` (${reason})` : ""}: deleting ${msgCount} message(s)`
    );
  }
  db.run("DELETE FROM messages WHERE from_id = ? OR to_id = ?", [peerId, peerId]);
  ...
}
```

### 2. `cleanStalePeers` — Log Dead PID Removal

```typescript
// Before
} catch {
  cleanStalePeerTxn(peer.id);
}

// After
} catch {
  console.error(
    `[claude-peers broker] stale peer ${peer.id} (PID ${peer.pid} dead) — removing`
  );
  cleanStalePeerTxn(peer.id);
}
```

### Reason Strings Added to All Call Sites

| Call Site | Reason |
|---|---|
| `cleanStalePeers` | `"stale PID"` (default) |
| `registerTxn` | `"re-registration"` |
| `sessionHeartbeatTxn` | `"session re-registration"` |

## Verification

All 37 broker integration tests pass after the change.

```
bun test v1.3.11
 37 pass
 0 fail
 112 expect() calls
Ran 37 tests across 1 file. [1095.00ms]
```

## Example Log Output (After Fix)

```
[claude-peers broker] stale peer ms7xflq0 (PID 12345 dead) — removing
[claude-peers broker] cleaning peer ms7xflq0 (stale PID): deleting 3 message(s)
```
