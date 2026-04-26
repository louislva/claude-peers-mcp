# spawn_peers Tool Design Spec

## Goal

Add a `spawn_peers` MCP tool to claude-peers that opens new Ghostty terminal tabs with split panes and starts Claude Code instances with assigned roles. This eliminates the need to manually open terminals and start workers.

## Requirements

- New MCP tool `spawn_peers` accessible by any peer
- Uses Ghostty's AppleScript API (macOS, Ghostty 1.3+)
- Opens a new tab, splits it based on peer count
- Starts Claude Code with `CLAUDE_PEERS_ROLE` env var in each pane
- Supports 2-4 peers per spawn call
- Optional startup prompt sent via `--prompt` flag
- Default working directory: caller's CWD

## Tool Schema

```ts
{
  name: "spawn_peers",
  description: "Spawn Claude Code instances in Ghostty terminal splits with assigned roles",
  inputSchema: {
    type: "object",
    properties: {
      roles: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 4,
        description: "Roles to assign (e.g. ['frontend-dev', 'backend-dev'])"
      },
      prompt: {
        type: "string",
        description: "Optional startup prompt for each Claude instance"
      },
      working_directory: {
        type: "string",
        description: "Working directory for spawned instances. Defaults to caller's CWD."
      }
    },
    required: ["roles"]
  }
}
```

## Architecture

### File Structure

| File | Responsibility |
|------|---------------|
| `shared/spawner.ts` | Ghostty AppleScript generation and execution |
| `server.ts` | `spawn_peers` tool definition and handler |

### shared/spawner.ts

Exports `spawnPeersInGhostty(config)` function:

```ts
interface SpawnConfig {
  roles: string[];
  cwd: string;
  prompt?: string;
}

function spawnPeersInGhostty(config: SpawnConfig): Promise<{ ok: boolean; error?: string }>
```

Generates and executes AppleScript via `osascript` that:
1. Creates a new tab in front Ghostty window with CWD
2. Runs the first Claude command in the initial pane
3. Splits and runs remaining Claude commands

### Split Layout Strategy

- **1 peer:** Single pane, no split
- **2 peers:** Right split (side by side)
- **3 peers:** Right split, then down split on left pane
- **4 peers:** Right split, then down split on both panes

### Claude Command Construction

Each pane runs:
```bash
CLAUDE_PEERS_ROLE="<role>" claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers [--prompt "<prompt>"]
```

### AppleScript Template

```applescript
tell application "Ghostty"
  set cfg to make new surface configuration
  set initial working directory of cfg to "<cwd>"

  -- New tab with first role
  set t1 to new tab in front window with configuration cfg

  -- Split right for second role
  set t2 to split t1 direction right with configuration cfg

  -- Send commands
  input text "CLAUDE_PEERS_ROLE=\"frontend-dev\" claude ..." to t1
  send key "enter" to t1
  input text "CLAUDE_PEERS_ROLE=\"backend-dev\" claude ..." to t2
  send key "enter" to t2
end tell
```

## Error Handling

- If Ghostty is not running: return error "Ghostty is not running"
- If not on macOS: return error "spawn_peers requires macOS with Ghostty"
- If osascript fails: return the stderr output

## Constraints

- macOS only (AppleScript)
- Ghostty 1.3+ required (AppleScript API)
- No fallback to other terminals (by design choice)
