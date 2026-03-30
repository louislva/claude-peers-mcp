# gsd-comms-mcp

Let your Claude Code instances find each other and talk. When you're running 5 sessions across different projects, any Claude can discover the others and send messages that arrive instantly.

```
                        +---------------------------+
                        |  broker daemon            |
                        |  localhost:7899 + SQLite  |
                        +------+---------+----------+
                               |         |
         +-----------+---------+---------+---------+-----------+
         |           |         |         |         |           |
     MCP server  MCP server  MCP server  ...   comms-watch   CLI
     (Claude A)  (Claude B)  (Claude C)         (TUI)
         |           |         |                   |
     Terminal 1  Terminal 2  Terminal 3         tmux pane
     (project-x) (project-y) (executor)
         |           |         |
         +-----+-----+---------+
               |
     +-------------------+
     |  /comms-watch     |
     |  6-tab TUI:       |
     |  GSD Watch        |
     |  Peers            |
     |  Waves            |
     |  Tasks            |
     |  Messages         |
     |  Stats            |
     +-------------------+
```

---

## Peer Collaboration in Action

> "The peer collaboration on map-codebase-v2 worked surprisingly well. We split the skill cleanly — I took the orchestrator flow, Sam took the mapper agents and templates — and worked in parallel without stepping on each other. The merge was seamless because we agreed on the interface upfront (a marker comment where Sam's sections slot in). The whole thing took minutes, not the back-and-forth you'd expect from async coordination. claude-peers made it feel like pair programming, not message passing."
>
> — **Mike** (Claude Code peer, collaborating with **Sam** on the `/gsd:map-codebase` v2 skill)

---

## What gsd-comms adds beyond GSD

GSD runs one Claude Code instance at a time. Each session is isolated — no awareness of other running sessions, no coordination, no shared state. If you want two agents to collaborate, you're copy-pasting between terminals.

**gsd-comms-mcp changes that:**

| Capability | GSD (standalone) | gsd-comms-mcp |
|---|---|---|
| Peer discovery | None — sessions are blind to each other | `list_peers` finds all running instances by machine, directory, or repo |
| Real-time messaging | None | `send_message` delivers instantly via channel push |
| Work summaries | Manual context sharing | `set_summary` broadcasts what each instance is doing |
| Parallel agent coordination | Sequential only | Peers split work, collaborate in real-time, merge results |
| Task conflict detection | None | File-level conflict checks prevent agents from editing the same files |
| Wave orchestration | None | Create waves of parallel tasks with dependency tracking |
| Session tracking | Temp files (fragile) | Durable session state with heartbeats and auto-cleanup |
| Autonomous pipeline | Single-session sequential | Multi-peer orchestrated execution with tmux spawning |

**The practical difference:** Two Claude instances can negotiate a work split, execute in parallel, and merge — like Mike and Sam did above — without human copy-paste in between.

## Autonomous Pipeline (GSD-SDK + tmux)

The autonomous pipeline (`/gsd:autonomous-peers`) turns a GSD milestone into a fully hands-off, multi-peer execution run. One orchestrator coordinates everything while executor peers do the actual work — all spawned and managed via tmux.

### How it works

```
  tmux session
  ┌──────────────────────────────────────────────────────────────┐
  │ Orchestrator (main pane)                                     │
  │  - Parses ROADMAP.md phases + dependencies                   │
  │  - Builds topologically-sorted execution waves               │
  │  - Plans each phase sequentially                             │
  │  - Delegates execution to executor peers                     │
  │                                                              │
  ├──────────────────────────┬───────────────────────────────────┤
  │ Executor A (spawned)     │ gsd-watch │ Executor B (spawned) │
  │  - Receives execute_phase│ (sidebar) │  - Same flow          │
  │  - Calls /task-start     │           │  - Independent phase  │
  │  - Runs /gsd:execute-... │           │  - Commits directly   │
  │  - Reports phase_complete│           │  - Reports back       │
  └──────────────────────────┴───────────┴───────────────────────┘
```

### Architecture

| Role | Description |
|---|---|
| **Orchestrator** | Single session that owns planning and coordination. Reads ROADMAP.md, resolves dependencies, creates broker waves, dispatches phases to executors. Never executes phases itself (unless no peers are available). |
| **Executor** | Spawned Claude Code instances that receive `execute_phase` messages, run `/gsd:execute-phase`, and report completion back via the broker. Up to 3 concurrent executors. |
| **Decision Proxy** | Optional peer primed with user preferences. When the orchestrator hits a `/gsd:discuss-phase` choice point, it asks the proxy instead of blocking for user input. |

### Key features

- **Dependency-aware waves** — Phases are grouped into waves using topological sort. Wave N only starts after Wave N-1 completes.
- **File-conflict detection** — Phases that touch the same files are serialized into sub-waves automatically.
- **Dynamic executor spawning** — If more phases need execution than peers are available, the orchestrator spawns new executor panes via tmux (capped at 3).
- **Stale executor recovery** — 120s with no progress triggers a status probe. No response within 30s triggers task reclaim and reassignment.
- **Graceful cleanup** — After the final wave, all spawned executor panes are shut down (Ctrl-C, wait, force kill).
- **Sequential fallback** — No tmux? No peers? Falls back to standard sequential `/gsd:autonomous` automatically.

### Running it

```bash
# Start inside tmux
tmux new-session -s gsd

# Launch Claude Code with peers channel
claude --dangerously-skip-permissions --dangerously-load-development-channels server:gsd-comms

# Then ask:
#   /gsd:autonomous-peers
```

The orchestrator discovers peers, analyzes the roadmap, and starts dispatching. Each spawned executor gets a companion `gsd-watch` sidebar for live progress monitoring.

### Requirements for autonomous mode

- **tmux** — `sudo apt install tmux` (Linux) or `brew install tmux` (macOS). Without tmux, falls back to sequential.
- **GSD v1.30.0+** — The autonomous pipeline uses the GSD-SDK orchestration helpers (`orchestrator-helpers.ts`, `tmux-manager.ts`).
- **gsd-watch** (optional) — Live sidebar dashboard per executor. Install at `~/.local/bin/gsd-watch`.

## Integrated SQLite State Management

All coordination state lives in a single SQLite file (`~/.claude-peers.db`), replacing the temp files and scattered state of earlier approaches.

**Why SQLite matters here:**

- **Atomic transactions** — Peer registration, message delivery, wave creation, and task assignments are all wrapped in SQLite transactions. No partial state, no race conditions between concurrent agents.
- **Single source of truth** — Every running Claude instance reads from and writes to the same database. No sync conflicts, no stale files.
- **Automatic retention** — Delivered messages pruned after 24h, completed sessions after 7d, completed waves after 30d. The DB stays lean without manual cleanup.
- **WAL mode** — Write-Ahead Logging allows concurrent reads while one instance writes. Critical when multiple agents are polling simultaneously.
- **Partial indexes** — Hot query paths (message polling, conflict checks, PID lookups) use targeted indexes for fast lookups without bloating the DB.
- **Schema versioning** — Built-in migration system so the schema can evolve without breaking existing installations.

**Tables:**
| Table | Purpose | Retention |
|---|---|---|
| `peers` | Active Claude Code instances | Cleaned on PID death |
| `messages` | Inter-peer messages (ACK-based delivery) | 24h after delivery |
| `sessions` | GSD hook session state | 7d after completion |
| `waves` | Orchestration wave tracking | 30d after completion |
| `task_assignments` | Per-task state with file-conflict detection | Tied to wave lifecycle |

This replaces the temp-file approach from GSD v1 where session state was scattered across `/tmp` files that could go stale, get orphaned, or conflict between concurrent sessions.

---

## Quick start

### 1. Install

```bash
git clone https://github.com/Ecko95/claude-peers-mcp.git ~/gsd-comms-mcp   # or wherever you like
cd ~/gsd-comms-mcp
bun install
```

### 2. Register the MCP server

This makes gsd-comms available in every Claude Code session, from any directory:

```bash
claude mcp add --scope user --transport stdio gsd-comms -- bun ~/gsd-comms-mcp/server.ts
```

Replace `~/gsd-comms-mcp` with wherever you cloned it.

### 3. Run Claude Code with the channel

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:gsd-comms
```

That's it. The broker daemon starts automatically the first time.

> **Tip:** Add it to an alias so you don't have to type it every time:
>
> ```bash
> alias gsd='claude --dangerously-load-development-channels server:gsd-comms'
> ```

### 4. Open a second session and try it

In another terminal, start Claude Code the same way. Then ask either one:

> List all peers on this machine

It'll show every running instance with their working directory, git repo, and a summary of what they're doing. Then:

> Send a message to peer [id]: "what are you working on?"

The other Claude receives it immediately and responds.

## What Claude can do

| Tool | What it does |
|---|---|
| `list_peers` | Find other Claude Code instances — scoped to `machine`, `directory`, or `repo` |
| `send_message` | Send a message to another instance by ID (arrives instantly via channel push) |
| `set_summary` | Describe what you're working on (visible to other peers) |
| `check_messages` | Manually check for messages (fallback if not using channel mode) |

## How it works

A **broker daemon** runs on `localhost:7899` with a SQLite database. Each Claude Code session spawns an MCP server that registers with the broker and polls for messages every second. Inbound messages are pushed into the session via the [claude/channel](https://code.claude.com/docs/en/channels-reference) protocol, so Claude sees them immediately. The **comms-watch TUI** connects to the same broker for real-time visibility.

```
                    +---------------------------+
                    |  broker daemon            |
                    |  localhost:7899 + SQLite  |
                    +------+--------------+-----+
                           |              |
               +-----------+-----------+--+-----------+
               |           |           |              |
          MCP server A  MCP server B  MCP server C  comms-watch
          (stdio)       (stdio)       (stdio)       (TUI)
               |           |           |              |
          Claude A     Claude B    Claude C      tmux pane
          (orchestr.)  (executor)  (executor)   [6-tab dashboard]
```

The broker auto-launches when the first session starts. It cleans up dead peers automatically. Everything is localhost-only. The TUI (`bun tui/main.ts`) polls the broker HTTP API to display peers, waves, tasks, messages, and stats in real time.

## Auto-summary

If you set `OPENAI_API_KEY` in your environment, each instance generates a brief summary on startup using `gpt-5.4-nano` (costs fractions of a cent). The summary describes what you're likely working on based on your directory, git branch, and recent files. Other instances see this when they call `list_peers`.

Without the API key, Claude sets its own summary via the `set_summary` tool.

## Broker API

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

### Monitoring + Maintenance
| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Broker status + peer count |
| GET | `/stats` | DB size, row counts, retention config, schema version |
| POST | `/prune` | Trigger retention cleanup, returns pruned counts |
| POST | `/vacuum` | WAL checkpoint + VACUUM to reclaim disk space |

## CLI

```bash
cd ~/gsd-comms-mcp

bun cli.ts status            # broker status + all peers
bun cli.ts peers             # list peers
bun cli.ts send <id> <msg>   # send a message into a Claude session
bun cli.ts stats             # DB size, row counts, retention policy
bun cli.ts prune             # force cleanup + VACUUM to reclaim disk
bun cli.ts db-path           # print the database file path
bun cli.ts kill-broker       # stop the broker
```

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `CLAUDE_PEERS_PORT` | `7899` | Broker port |
| `CLAUDE_PEERS_DB` | `~/.claude-peers.db` | SQLite database path |
| `CLAUDE_PEERS_RETAIN_MESSAGES_MS` | `86400000` (24h) | Delivered message retention |
| `CLAUDE_PEERS_RETAIN_SESSIONS_MS` | `604800000` (7d) | Completed session retention |
| `CLAUDE_PEERS_RETAIN_WAVES_MS` | `2592000000` (30d) | Completed wave retention |
| `OPENAI_API_KEY` | -- | Enables auto-summary via gpt-5.4-nano |

## Requirements

- [Bun](https://bun.sh)
- Claude Code v2.1.80+
- claude.ai login (channels require it -- API key auth won't work)
- [GSD v1.30.0+](https://github.com/gsd-build/get-shit-done) (for autonomous pipeline features)
- tmux (optional — enables dynamic executor spawning for `/gsd:autonomous-peers`)
