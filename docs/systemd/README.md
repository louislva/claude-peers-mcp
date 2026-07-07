# systemd unit — codex auto-drain poller

Canonical copy of the user-mode systemd unit for the auto-drain poller
(`bin/codex-autodrain-poller.ts`). The **live** copy lives at
`~/.config/systemd/user/claude-peers-codex-autodrain.service` on the host; this
repo copy is the source of truth so the unit (and its hardening) survives a host
rebuild.

## What the poller does

Optionally nudges idle Codex/Gemini/Claude lanes (via `tmux send-keys`) to read
pending peer mail. **Auto-nudge is OFF by default** — see `NUDGE_CLIENTS` below.

## Auto-nudge default: OFF

The unit pins `Environment=NUDGE_CLIENTS=` (empty = nudge nobody). Rationale:
typing a nudge into an idle session forces a turn. Claude lanes already
piggyback-drain pending mail on their next turn for free; idle Codex/Gemini wakes
burn quota to drain low-value chatter. Mail still flows on each lane's next
natural turn. To re-enable a client, set the comma-separated list
(`codex` / `gemini` / `claude` honored):

```
Environment=NUDGE_CLIENTS=codex,gemini
```

The poller logs its state at startup (`nudge=DISABLED` or `nudge=codex,...`), so
the active posture is always observable in `~/.claude-peers-codex-autodrain.log`.

## Install / update

```sh
cp docs/systemd/claude-peers-codex-autodrain.service \
   ~/.config/systemd/user/claude-peers-codex-autodrain.service
systemctl --user daemon-reload
# enable only if you want systemd (not cron) to own the poller:
# systemctl --user enable --now claude-peers-codex-autodrain.service
```

## Two launchers — pick one

The poller can be supervised by **either**:

- **cron watchdog** (`~/bin/ensure-codex-autodrain`, `*/2 * * * *`) — the current
  live launcher; self-heals a wedged poller every 2 min. Relies on the in-code
  default for the disabled state.
- **this systemd unit** — `disabled`/`inactive` by default. If you enable it,
  disable the cron line first to avoid a double-launch.

Both keep auto-nudge OFF: the systemd unit via its pinned `NUDGE_CLIENTS=`, the
cron/in-code path via the poller's default.
