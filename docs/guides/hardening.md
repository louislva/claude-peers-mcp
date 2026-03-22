# Hardening Recommendations

Concrete improvements to make claude-peers production-ready for multi-machine,
multi-team deployments. Organized by area, with current state, gap, and
proposed fix for each item.

---

## 1. Broker Resilience

### 1a. Crash recovery and data durability

**Current state:** The broker runs as a detached Bun process. If it crashes,
all peer registrations are lost. The SQLite database survives on disk, but
stale peer rows (with no heartbeat) are cleaned up on next start, effectively
losing all state. Messages marked `delivered=0` survive but recipients may
have new peer IDs after re-registering.

**Gap:** No automatic restart. No WAL checkpoint on shutdown. No backup of the
SQLite database.

**Proposed fixes:**
- Add a `SIGTERM`/`SIGINT` handler to the broker that checkpoints WAL and
  closes the database cleanly before exiting.
- Add a systemd unit file (and/or Docker healthcheck + restart policy) so the
  broker restarts automatically on crash.
- For Kubernetes, the deployment already has restart semantics, but add a
  `preStop` lifecycle hook that sends SIGTERM and waits for graceful shutdown.
- Consider periodic WAL checkpoints (`PRAGMA wal_checkpoint(TRUNCATE)`) on a
  timer (e.g., every 5 minutes) to bound WAL file growth.
- Document a backup strategy: periodic `sqlite3 .backup` to a second file, or
  use Litestream for continuous replication.

### 1b. Broker startup race condition

**Current state:** `ensureBroker()` in `server.ts` launches the broker and
polls `/health` every 200ms for up to 6 seconds. If two MCP servers start
simultaneously, both may try to launch the broker. The second spawn's
port-bind error is visible on stderr (inherited), but the parent process
has no coordination or lock to prevent the race.

**Gap:** No lock file or leader election. Both spawns proceed independently.

**Proposed fixes:**
- Use a lock file (`~/.claude-peers.lock`) with `flock` semantics. The first
  process acquires the lock and spawns the broker. Others wait for the health
  check to pass.
- Alternatively, accept the current behavior (it works in practice since the
  port binding is the de facto lock), but log a clear message when the spawned
  broker exits due to port conflict.

---

## 2. Message Reliability

### 2a. Delivery guarantees

**Current state:** Messages are at-most-once. `pollMessages` marks them as
`delivered=1` immediately on read, before the MCP channel push succeeds.
If the channel push fails (no `--dangerously-load-development-channels`),
the message is buffered in `pendingMessages` but also marked delivered in
the database. If the MCP server crashes before `check_messages` drains the
buffer, the message is lost.

**Gap:** No redelivery. No acknowledgment protocol.

**Proposed fixes:**
- Change to at-least-once delivery: don't mark `delivered=1` until the client
  explicitly acknowledges. Add an `/ack-messages` endpoint that takes a list
  of message IDs.
- In `pollMessages`, return undelivered messages but don't mark them. The
  client calls `/ack-messages` after successful channel push or buffer drain.
- Add a `delivery_attempts` counter and a maximum retry limit (e.g., 5) to
  prevent infinite redelivery of messages to dead peers.
- For the MCP server, acknowledge after successful channel notification or
  after `check_messages` returns messages to Claude.

### 2b. Message ordering

**Current state:** Messages are ordered by `sent_at` (ISO timestamp) within a
single recipient. Cross-peer ordering is undefined.

**Gap:** No sequence numbers. Clock skew between machines can reorder messages.

**Proposed fixes:**
- Add a broker-assigned monotonic sequence number (`seq INTEGER`) to the
  messages table. Use this instead of `sent_at` for ordering.
- Return the sequence number in poll responses so clients can detect gaps.
- For cross-peer total ordering (needed for group-chat-style coordination),
  add a global sequence or vector clock. Lower priority — per-recipient
  ordering is sufficient for most use cases.

### 2c. Message size limits

**Current state:** No limit on message text size. A client can send arbitrarily
large messages, which bloats the SQLite database and could cause memory issues
on the recipient.

**Gap:** No validation on message size.

**Proposed fix:**
- Add a configurable `MAX_MESSAGE_SIZE` (default: 64KB). Reject messages over
  the limit with HTTP 413.
- Consider a separate `MAX_PENDING_MESSAGES` per recipient (default: 1000) to
  prevent mailbox flooding.

---

## 3. Authentication and Identity

### 3a. Per-peer identity

**Current state:** The bearer token is shared across all clients. Any client
with the token can impersonate any hostname and read messages addressed to any
peer ID it can guess (since `poll-messages` only requires the peer ID, not
proof of ownership).

**Gap:** No per-peer authentication. Peer IDs are 8-char random strings — not
cryptographically strong and vulnerable to enumeration.

**Proposed fixes:**
- **Short term:** Extend peer IDs to 32 characters (128 bits of entropy) to
  make enumeration infeasible. Return a `secret` alongside the `id` on
  registration. Require the secret on `/poll-messages`, `/set-summary`,
  `/heartbeat`, and `/unregister`.
- **Medium term:** Issue per-peer JWTs on registration. The JWT contains the
  peer ID as a claim. All peer-specific endpoints validate the JWT. This
  prevents a compromised peer from accessing other peers' messages.
- **Long term:** Support mutual TLS or OIDC for peer authentication, allowing
  integration with existing identity providers.

### 3b. Peer ID collision

**Current state:** `generateId()` produces 8-character alphanumeric strings
(36^8 = ~2.8 trillion combinations). No collision check on registration.

**Gap:** With enough peers over time, collisions become possible. A collision
causes the new registration to fail (SQLite `PRIMARY KEY` constraint).

**Proposed fix:**
- Check for ID existence before inserting. Retry with a new ID on collision.
- Increase ID length to 16+ characters.
- Use `crypto.randomUUID()` for guaranteed uniqueness.

---

## 4. Rate Limiting

### 4a. Broker endpoint rate limiting

**Current state:** No rate limiting on any broker endpoint. A misbehaving
client can flood the broker with requests, consuming CPU and filling the
database.

**Gap:** Denial of service risk, especially with network-exposed brokers.

**Proposed fixes:**
- Add per-IP rate limiting on all POST endpoints. Suggested defaults:
  - `/register`: 10/min per IP (prevent registration spam)
  - `/send-message`: 60/min per peer (prevent message flooding)
  - `/poll-messages`: 120/min per peer (1 poll/sec is normal)
  - `/heartbeat`: 10/min per peer (1 every 15s is normal)
  - `/list-peers`: 30/min per peer
- Implement with a simple in-memory sliding window (no external dependency).
- Return HTTP 429 with `Retry-After` header when rate exceeded.
- For Kubernetes/Docker deployments, also consider ingress-level rate limiting
  as a defense-in-depth measure.

### 4b. Registration spam

**Current state:** Any authenticated client can register unlimited peers.
Each registration creates a new row. There's no limit on peers per IP or
per hostname.

**Gap:** An attacker with a valid token can create millions of peer entries.

**Proposed fix:**
- Add a configurable `MAX_PEERS_PER_HOSTNAME` (default: 50). Reject new
  registrations from a hostname that has reached the limit.
- Add a global `MAX_TOTAL_PEERS` (default: 10,000) as a safety cap.

---

## 5. Message TTL and Cleanup

### 5a. Old message cleanup

**Current state:** Delivered messages (`delivered=1`) stay in the database
forever. Undelivered messages for dead peers are deleted when the peer is
cleaned up, but delivered messages accumulate without bound.

**Gap:** Unbounded database growth. Over weeks/months, the messages table
grows indefinitely.

**Proposed fixes:**
- Add a `CLAUDE_PEERS_MESSAGE_TTL` env var (default: 24 hours). Run a
  periodic cleanup (e.g., every 10 minutes) that deletes messages older
  than the TTL.
- For delivered messages, a shorter TTL is fine (e.g., 1 hour).
- For undelivered messages, keep them longer (up to the TTL) in case the
  recipient restarts and re-registers.
- Add a `VACUUM` after bulk deletes to reclaim disk space, or use
  `auto_vacuum=INCREMENTAL` mode.

### 5b. Database size monitoring

**Current state:** No visibility into database size or row counts.

**Gap:** Operators can't tell when the database is growing too large.

**Proposed fix:**
- Extend the `/health` endpoint to include `db_size_bytes`,
  `total_messages`, `undelivered_messages`, and `total_peers`.
- Add Prometheus metrics export (optional, via a `/metrics` endpoint) for
  integration with monitoring stacks.

---

## 6. Persistent Peer IDs

### 6a. Stable identity across restarts

**Current state:** Every time a Claude Code session starts, it gets a new
random peer ID. Other peers that had the old ID can no longer reach it.
The heartbeat auto-re-register also assigns a new ID.

**Gap:** No continuity of identity. Other peers' references to a peer ID
become stale every time the session restarts.

**Proposed fixes:**
- **Reconnect token (recommended):** On registration, the broker returns a
  secret reconnect token alongside the peer ID. The MCP server stores both
  in its process memory (not a file — each process gets its own). When
  heartbeat returns `found: false`, the client presents the token to reclaim
  the same ID instead of getting a new one. The token is per-registration,
  so concurrent sessions each have their own.
- **Stored ID (agents only):** Long-running agents (not Claude Code sessions)
  can store their peer ID in a per-process state file. The path must be
  unique per process (e.g., include PID or a random suffix). Not suitable
  for Claude Code sessions where multiple instances share a filesystem.
- **Note:** Avoid deterministic IDs based on hostname+cwd — multiple
  concurrent sessions from the same directory would collapse into one
  identity, breaking the core multi-session use case.

---

## 7. Message Encryption

### 7a. End-to-end encryption between peers

**Current state:** Messages are stored in plaintext in the SQLite database.
The bearer token protects transport (who can connect), but the broker operator
and anyone with database access can read all messages.

**Gap:** No confidentiality at rest. No end-to-end encryption.

**Proposed fixes:**
- **Phase 1 (encrypt at rest):** Encrypt the SQLite database using SQLCipher
  or Bun's built-in SQLite encryption (if available). This protects against
  disk-level access but not a compromised broker process.
- **Phase 2 (end-to-end):** Implement peer-to-peer key exchange:
  1. Each peer generates an X25519 keypair on registration.
  2. The public key is stored in the `peers` table (new column).
  3. Before sending, the sender fetches the recipient's public key via
     `list-peers`, derives a shared secret (ECDH), and encrypts the
     message with AES-256-GCM.
  4. The broker stores ciphertext. Only the recipient can decrypt.
  5. Key rotation happens on re-registration (new keypair each session).
- **Tradeoff:** E2E encryption means the broker can't scan message content
  for DLP or injection (Layer 2 scanning becomes ineffective). The pipelock
  MCP proxy (Layer 1) still scans plaintext before encryption. Document this
  tradeoff explicitly.

---

## 8. Health Monitoring and Alerting

### 8a. Broker health checks

**Current state:** The `/health` endpoint returns `{ status: "ok", peers: N }`.
No deeper health information.

**Gap:** No way to detect degraded state (e.g., database locked, high message
backlog, stale peers not being cleaned).

**Proposed fixes:**
- Extend `/health` to include:
  - `uptime_seconds`: broker process uptime
  - `db_size_bytes`: SQLite file size
  - `total_peers`: current peer count
  - `total_messages`: total messages in database
  - `undelivered_messages`: messages waiting for delivery
  - `oldest_undelivered_age_seconds`: how long the oldest pending message
    has been waiting (indicates stuck/dead peers)
  - `last_cleanup_at`: timestamp of last stale-peer cleanup
- Add a `/metrics` endpoint with Prometheus-format output for integration
  with Grafana, Datadog, etc.

### 8b. Peer liveness visibility

**Current state:** Stale peers are silently cleaned up. No notification to
anyone.

**Gap:** If a critical peer goes offline, other peers only discover it when
they try to send a message and it fails.

**Proposed fixes:**
- Add an optional webhook (`CLAUDE_PEERS_WEBHOOK_URL`) that fires when a
  peer goes offline (cleaned up by heartbeat timeout).
- Include the peer's hostname, cwd, summary, and last_seen in the webhook
  payload.
- This enables external alerting (PagerDuty, Slack, etc.) when important
  peers drop.

---

## 9. Client SDK Improvements

### 9a. Connection pooling and keep-alive

**Current state:** Every `brokerFetch` call in both `client.ts` and
`server.ts` creates a new `fetch()` request. Bun's fetch handles
keep-alive at the HTTP level, but there's no explicit connection pooling
or retry logic.

**Gap:** Under high message volume, the broker gets hammered with new
connections. No retry on transient failures (network blips, broker restart).

**Proposed fixes:**
- Add exponential backoff retry to `post()` in `client.ts` (3 attempts,
  100ms/500ms/2000ms delays). Only retry on 5xx or network errors, not
  4xx.
- Add a circuit breaker: if 5 consecutive requests fail, stop polling for
  30 seconds before retrying. This prevents thundering herd when the broker
  is down.
- Add request timeout to all broker calls (currently only `isAlive` has a
  3-second timeout). Suggested: 5 seconds for all endpoints.

### 9b. Reconnection logic

**Current state:** The heartbeat handler in both `client.ts` and `server.ts`
re-registers when the broker reports `found: false`. But if the broker itself
is unreachable (network error), the heartbeat silently catches and ignores
the error.

**Gap:** Extended broker downtime means the client silently loses registration
with no recovery attempt beyond the next heartbeat interval.

**Proposed fix:**
- Track consecutive heartbeat failures. After N failures (e.g., 3), log a
  warning and increase heartbeat frequency temporarily (backoff then recover).
- On re-registration, re-send the current summary and re-announce to any
  known peers.

### 9c. TypeScript package publishing

**Current state:** The client SDK is imported via relative path
(`./client.ts`). No npm/JSR package.

**Gap:** Non-trivial to use from external projects.

**Proposed fix:**
- Publish to npm as `claude-peers` (or `@claude-peers/client`).
- Export `PeersClient`, types, and the broker launcher as separate entry
  points.

---

## 10. Bridge Improvements

### 10a. Error handling and retry

**Current state:** `PeersClient.startPolling()` in `client.ts` wraps the
handler in a try/catch that silently swallows errors. If the platform API
call fails inside the handler, the message is marked as delivered but lost.

**Gap:** No retry on platform API failures. No dead letter queue.

**Proposed fixes:**
- Add retry logic to platform API calls (3 attempts with exponential
  backoff).
- If all retries fail, write the message to a local dead letter file
  (`~/.claude-peers-dead-letters.jsonl`) with timestamp, destination,
  and error.
- Add a CLI command to replay dead letters: `bun cli.ts replay-dead-letters`.
- For the poll loop itself, distinguish between broker errors (retry) and
  handler errors (log + continue).

### 10b. Bidirectional bridging

**Current state:** The bridge example is one-way: peer messages go to chat
platforms. There's no reverse path (chat platform messages routed back to
peers).

**Gap:** Users in Telegram/Slack can't reply to peer messages.

**Proposed fix:**
- Add a webhook receiver (or long-poll listener) for each chat platform.
- When a user replies in the chat platform, the bridge sends a message
  back to the originating peer via `sendMessage`.
- Use a reply mapping (message ID -> peer ID) to route replies correctly.
- This turns the bridge into a full duplex communication channel.

### 10c. Bridge as a standalone package

**Current state:** The bridge is a code example in a docs guide. No
runnable implementation.

**Gap:** Every user has to implement their own bridge.

**Proposed fix:**
- Create `bridge.ts` in the repo as a reference implementation.
- Support Telegram, Slack, and Discord via environment variables (select
  platform via `CLAUDE_PEERS_BRIDGE_PLATFORM`).
- Include Dockerfile and docker-compose service definition.

---

## Priority Order

Recommended implementation sequence based on impact and effort:

1. **Message TTL / cleanup** (5a) — prevents unbounded growth, low effort
2. **Message size limits** (2c) — prevents abuse, trivial to add
3. **Rate limiting** (4a, 4b) — required for any network-exposed broker
4. **Graceful shutdown** (1a) — WAL checkpoint + signal handler, low effort
5. **Per-peer secrets** (3a short term) — 32-char IDs + registration secret
6. **Delivery acknowledgment** (2a) — at-least-once semantics
7. **Extended health endpoint** (8a) — monitoring visibility
8. **Client retry/circuit breaker** (9a) — resilience under broker failures
9. **Persistent peer IDs** (6a) — stable identity across restarts
10. **Bridge retry + dead letter** (10a) — message durability for bridges
11. **E2E encryption** (7a) — confidentiality, higher effort
12. **Peer offline webhooks** (8b) — alerting integration
