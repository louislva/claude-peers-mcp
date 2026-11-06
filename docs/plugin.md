# Plugin packaging — can GUI sessions get true channel push?

Status: **packaged and installed; channel push in the GUI is BLOCKED by
Anthropic's remote channel allowlist** (investigated 2026-08-10, Claude Code
2.1.221).

This repo now doubles as a local directory-source marketplace so the MCP
server can be mounted as a *plugin* rather than a raw `~/.claude.json` MCP
entry. That was the last packaging lever available for making GUI (desktop
app) sessions eligible for `notifications/claude/channel` push. It is
necessary but not sufficient — see [Verdict](#verdict).

## Layout

```
.claude-plugin/marketplace.json          marketplace "claude-peers-local"
plugin/.claude-plugin/plugin.json        plugin "claude-peers" (+ channels decl)
plugin/.mcp.json                         mcpServers entry -> bun server.ts
```

`plugin/.mcp.json` launches the *same* server this repo already ships, by
absolute path:

```json
{
  "mcpServers": {
    "claude-peers": {
      "command": "/Users/kielay/.bun/bin/bun",
      "args": ["/Users/kielay/MCP/servers/claude-peers-mcp/server.ts"]
    }
  }
}
```

Absolute paths on purpose. Marketplace installs *copy* the plugin directory
into `~/.claude/plugins/cache/`, so `${CLAUDE_PLUGIN_ROOT}/../server.ts` would
not resolve. The cost is that the plugin is machine-specific; anyone else
cloning this repo must edit both paths.

`plugin.json` declares the channel binding, which is what tells Claude Code
the plugin's MCP server is meant to be a channel source:

```json
"channels": [{ "server": "claude-peers", "displayName": "Claude Peers" }]
```

`server.ts` is unchanged. It already declares
`capabilities.experimental["claude/channel"]`, which is the only server-side
requirement in the channel contract.

## Install

Both steps are already done on this machine. To reproduce:

```bash
claude plugin marketplace add /Users/kielay/MCP/servers/claude-peers-mcp
claude plugin install claude-peers@claude-peers-local
```

The marketplace is declared in `~/.claude/settings.json`, so it survives
`known_marketplaces.json` being rebuilt:

```json
"extraKnownMarketplaces": {
  "claude-peers-local": {
    "source": { "source": "directory", "path": "/Users/kielay/MCP/servers/claude-peers-mcp" }
  }
},
"enabledPlugins": { "claude-peers@claude-peers-local": true }
```

Verify with `claude plugin list` (expect `claude-peers@claude-peers-local ·
enabled`) and `claude plugin marketplace list`.

## Double registration — read this before leaving it installed

The raw user-scope entry in `~/.claude.json` (`"claude-peers"`: bun +
server.ts) and the plugin **both** load. Every session now spawns two server
processes and registers **two peers** with the broker under different ids.
Confirmed in a debug session:

```
MCP server "claude-peers":                    Registered as peer vfmi20j3
MCP server "plugin:claude-peers:claude-peers": Registered as peer drg6r5qw
```

Two ids per session means `list_peers` shows phantom duplicates and a
`send_message` may land in the mailbox the session's hook doesn't drain. Pick
one mount. To drop the raw entry and keep the plugin:

```bash
claude mcp remove claude-peers -s user
```

(That rewrites `~/.claude.json`. Re-add with
`claude mcp add claude-peers -s user -- /Users/kielay/.bun/bin/bun /Users/kielay/MCP/servers/claude-peers-mcp/server.ts`.)

Note the plugin mount also renames the tools: `mcp__claude-peers__send_message`
becomes `mcp__plugin_claude-peers_claude-peers__send_message`. Anything with a
hard-coded tool name — permission allowlists, agent `tools:` frontmatter —
needs updating if you switch.

## Verdict

**Channel push from this plugin will not reach GUI sessions.** The blocker is
Anthropic's channel allowlist, and it is enforced client-side in the Claude
Code binary. Three separate gates, all verified against the 2.1.221 bundle:

1. **GUI channel enable requires a plugin.** The `channel_enable` control
   request rejects any server without a marketplace-backed `pluginSource`:
   *"server X is not plugin-sourced; channel_enable requires a marketplace
   plugin"*. This is why the raw `~/.claude.json` entry could never work in
   the GUI, and why this packaging was worth doing.

2. **The GUI never sees the capability unless the plugin is allowlisted.**
   When Claude Code reports MCP server status to the desktop app, it strips
   `claude/channel` from the reported capabilities unless
   `isChannelAllowlisted(pluginSource)` passes. The SDK's own schema says it
   outright: *"`claude/channel`] is only present if the server's plugin is on
   the approved channels allowlist — use its presence to decide whether to
   show an Enable-channel prompt."* No capability reported, no Enable-channel
   prompt, no way for the user to trigger `channel_enable`.

3. **The allowlist is a remote feature flag, not a local file.** The default
   list comes from the `tengu_harbor_ledger` gate — server-controlled config
   fetched at runtime. The docs match: *"A channel published to your own
   marketplace still needs `--dangerously-load-development-channels` to run,
   since it isn't on the approved allowlist. The default allowlist is the
   channel plugins in `claude-plugins-official`, which Anthropic curates at
   its discretion."*

`allowedChannelPlugins` does not help here. It is read only from
`policySettings`, i.e. `/Library/Application Support/ClaudeCode/managed-settings.json`
— an org policy file that does not exist on this machine and needs root to
create. Worse, it only overrides gate 3's *enforcement* path; the GUI's
display gate (2) consults the Anthropic ledger directly and ignores
`allowedChannelPlugins` entirely. So even a managed-settings entry would not
make the Enable-channel prompt appear in the desktop app.

`channelsEnabled` is **not** the blocker. With no managed settings present the
policy check passes for a personal account, matching the docs: *"Pro and Max
users without an organization skip these checks entirely."*

### What still works

Terminal only, via the development bypass — now available in plugin form as
well as raw-server form:

```bash
claude --dangerously-load-development-channels plugin:claude-peers@claude-peers-local
claude --dangerously-load-development-channels server:claude-peers   # raw entry
```

The dev flag sets `dev: true` on the session's channel entry, which is the one
branch that skips the allowlist check.

### The other blocker: this server's own client-capability gate

Independent of the allowlist, `startInboundMessagePolling()` (commit
`d1413d7`) refuses to start the poller unless the *client* advertises
`experimental["claude/channel"]`. **Claude Code never advertises that.** Its
client-capabilities builder returns `{roots, elicitation}` and nothing else.
Driven with exactly those capabilities, this server logs:

```
Client capabilities: {"elicitation":{"form":{}},"roots":{"listChanged":true}}
Client does not advertise experimental claude/channel; skipping background polling
```

That is the real reason push "did not fire in practice" (see
`docs/codex-integration.md`) — it was never the harness. The official channel
plugins (telegram, fakechat) gate on nothing; they push unconditionally and
let Claude Code drop the notification when the session hasn't enabled the
channel, which is exactly what the reference says happens: *"If the session
hasn't loaded your server as a channel ... Claude Code drops the events
silently and returns no error to your server."*

So even under the dev flag, push stays dead until that gate changes. The
minimal change is to drop the `supportsClaudeChannel` early-return in
`startInboundMessagePolling()`. Left unchanged here deliberately — this is a
behavioural change to `server.ts`, not packaging.

## Test procedure

Terminal, to confirm the dev-flag path once the poller gate above is
addressed:

```bash
claude --dangerously-load-development-channels plugin:claude-peers@claude-peers-local
```

Accept the full-screen development-channels warning. The startup banner should
read *"Channels (experimental) messages from plugin:claude-peers@claude-peers-local
inject directly in this session"*. From a second session, `send_message` to the
first session's peer id; it should appear mid-turn as
`← claude-peers: ...` without anyone calling `check_messages`.

GUI, to confirm the verdict above: restart the desktop app and ask the session
whether a `<channel source="plugin:claude-peers:claude-peers">` turn ever
arrives without polling. Expected answer: no, and no Enable-channel affordance
appears for the plugin.

## Rollback

```bash
claude plugin uninstall claude-peers@claude-peers-local
claude plugin marketplace remove claude-peers-local
```

Then remove `"claude-peers@claude-peers-local": true` from `enabledPlugins` and
the `claude-peers-local` block from `extraKnownMarketplaces` in
`~/.claude/settings.json` if the commands leave them behind. The raw
`~/.claude.json` entry is untouched by all of this and keeps working.

To roll back only the packaging in this repo, delete `.claude-plugin/` and
`plugin/`. Nothing else in the repo references them.
