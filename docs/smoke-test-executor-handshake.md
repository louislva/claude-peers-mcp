# Two-Session Executor Handshake Smoke Test

Verifies the end-to-end executor protocol: `execute_phase` -> `status_response` (acknowledged) -> `phase_complete`.

## Prerequisites

- Broker running: `bun broker.ts` (or it auto-starts via MCP server)
- Two terminal windows open in the same git repository
- Bun and curl installed

## Setup

Start the broker if not already running:

```bash
CLAUDE_PEERS_PORT=7899 bun broker.ts &
```

Verify broker is alive:

```bash
curl -s http://127.0.0.1:7899/health | jq .
# Expected: {"status":"ok","peers":N}
```

---

## Session A: Orchestrator (sender)

### Step 1: Register as orchestrator peer

```bash
ORCH_ID=$(curl -s -X POST http://127.0.0.1:7899/register \
  -H 'Content-Type: application/json' \
  -d '{"pid":'$$',"cwd":"'$(pwd)'","git_root":"'$(git rev-parse --show-toplevel)'","tty":null,"summary":"orchestrator smoke test"}' \
  | jq -r '.id')
echo "Orchestrator ID: $ORCH_ID"
```

### Step 2: Note the orchestrator ID for Session B

Copy the value printed by the `echo` command above. You will paste it into Session B in Step 1.

---

## Session B: Executor (receiver)

### Step 1: Register as executor peer

```bash
EXEC_ID=$(curl -s -X POST http://127.0.0.1:7899/register \
  -H 'Content-Type: application/json' \
  -d '{"pid":'$$',"cwd":"'$(pwd)'","git_root":"'$(git rev-parse --show-toplevel)'","tty":null,"summary":"executor smoke test"}' \
  | jq -r '.id')
echo "Executor ID: $EXEC_ID"
```

Copy the printed executor ID for use in Session A.

---

## Verification Checkpoint: Both peers visible

Run in either session (substitute the actual IDs):

```bash
bun cli.ts peers
# Expected: 2 peers listed, both in same repo
```

---

## Session A: Send execute_phase

### Step 3: Send execute_phase message

Replace `$EXEC_ID` with the executor ID printed in Session B Step 1:

```bash
MSG_ID=$(curl -s -X POST http://127.0.0.1:7899/send-message \
  -H 'Content-Type: application/json' \
  -d '{"from_id":"'$ORCH_ID'","to_id":"'$EXEC_ID'","text":"Execute phase","msg_type":"execute_phase","payload":{"phase_number":1,"phase_name":"test-phase","plan_path":".planning/phases/01-test/01-01-PLAN.md","wave_id":1,"task_id":1,"flags":"","orchestrator_id":"'$ORCH_ID'"}}' \
  | jq -r '.id')
echo "Sent execute_phase message ID: $MSG_ID"
```

---

## Session B: Receive and acknowledge

### Step 4: Poll for messages

```bash
curl -s -X POST http://127.0.0.1:7899/poll-messages \
  -H 'Content-Type: application/json' \
  -d '{"id":"'$EXEC_ID'"}' | jq '.messages[] | {id, msg_type, payload}'
# Expected: execute_phase message with task details
```

### Step 5: ACK the message

Replace `$MSG_ID` with the message ID from Session A Step 3:

```bash
curl -s -X POST http://127.0.0.1:7899/ack-message \
  -H 'Content-Type: application/json' \
  -d '{"message_ids":['$MSG_ID']}'
# Expected: {"ok":true}
```

### Step 6: Send status_response (acknowledged)

```bash
curl -s -X POST http://127.0.0.1:7899/send-message \
  -H 'Content-Type: application/json' \
  -d '{"from_id":"'$EXEC_ID'","to_id":"'$ORCH_ID'","text":"Acknowledged","msg_type":"status_response","payload":{"task_id":1,"status":"acknowledged","tasks_completed":0,"tasks_total":1,"current_task":"setup","last_activity":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}}' \
  | jq .
# Expected: {"id":<number>}
```

### Step 7: Send phase_complete

After completing the phase work (or simulating it), send the completion message:

```bash
curl -s -X POST http://127.0.0.1:7899/send-message \
  -H 'Content-Type: application/json' \
  -d '{"from_id":"'$EXEC_ID'","to_id":"'$ORCH_ID'","text":"Phase complete","msg_type":"phase_complete","payload":{"task_id":1,"wave_id":1,"phase_number":1,"verification":{"passed":true,"criteria_met":2,"criteria_total":2,"gaps":[]},"commits":["abc1234"],"files_modified":["src/test.ts"]}}' \
  | jq .
# Expected: {"id":<number>}
```

---

## Session A: Verify completion

### Step 8: Poll for phase_complete

```bash
curl -s -X POST http://127.0.0.1:7899/poll-messages \
  -H 'Content-Type: application/json' \
  -d '{"id":"'$ORCH_ID'"}' | jq '.messages[] | {id, msg_type, payload}'
# Expected: status_response (acknowledged) AND phase_complete messages
# The phase_complete payload should show verification.passed: true
```

---

## Cleanup

Run in both sessions (or one session with both IDs set):

```bash
curl -s -X POST http://127.0.0.1:7899/unregister \
  -H 'Content-Type: application/json' \
  -d '{"id":"'$ORCH_ID'"}'

curl -s -X POST http://127.0.0.1:7899/unregister \
  -H 'Content-Type: application/json' \
  -d '{"id":"'$EXEC_ID'"}'
```

Optionally stop the background broker:

```bash
bun cli.ts kill-broker
```

---

## Expected Result

The orchestrator (Session A) receives two messages in its poll queue:
1. A `status_response` from the executor with `status: "acknowledged"`
2. A `phase_complete` message from the executor with `verification.passed: true`

This confirms the full handshake cycle: `execute_phase` -> `acknowledged` -> `phase_complete`.

## Message Type Reference

| Type | Direction | Purpose |
|---|---|---|
| `execute_phase` | Orchestrator -> Executor | Dispatch a phase plan for execution |
| `status_response` | Executor -> Orchestrator | ACK and ongoing status updates |
| `phase_complete` | Executor -> Orchestrator | Phase finished, verification results |
| `phase_blocked` | Executor -> Orchestrator | Phase failed, blocked reason |
