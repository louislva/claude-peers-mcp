---
name: comms-watch
description: "Launch comms-watch TUI in a tmux split pane (35% width, right side)"
disable-model-invocation: true
allowed-tools: Bash
---

Open a comms-watch TUI sidebar in a tmux pane. Follow these steps exactly using the Bash tool:

**Step 1 — Check if bun is available:**

Run: `which bun`

If the command exits with a non-zero exit code (bun not found), print exactly:

`bun not found. Install Bun first: https://bun.sh`

Then stop. Do not continue to step 2.

**Step 2 — Check if running inside tmux:**

Run: `echo $TMUX`

If the output is empty (not inside a tmux session), print exactly:

`comms-watch requires tmux. Start a session first: 'tmux new-session', then run /comms-watch again.`

Then stop. Do not continue to step 3.

**Step 3 — Check for duplicate instance:**

Run: `tmux list-panes -s -F '#{pane_title}'` to list the title of all panes in the current session.

If any line from the output starts with `comms-watch:`, print exactly:

`comms-watch is already running in this session. Use Ctrl+C in that pane to stop it first.`

Then stop. Do not continue to step 4.

**Step 4 — Spawn comms-watch in a new right-side pane:**

Run: `tmux split-window -h -p 35 -d "cd \"$PWD\" && printf '\\033]2;comms-watch: %s\\033\\\\' \"$PWD\" && bun $HOME/dev/claude-peers-mcp/tui/main.ts"`

The `-h` flag creates a right-side vertical split. The `-p 35` sets the new pane to 35% of the current pane width. The `-d` flag keeps focus on the original pane. The `cd "$PWD"` ensures the TUI resolves `.planning/` from the current project directory. The `$HOME/dev/claude-peers-mcp/tui/main.ts` absolute path ensures this works from any repo.

Then print: `comms-watch sidebar opened.`
