export const PEER_INSTRUCTIONS = `You are connected to the claude-peers network. Other Claude Code instances on this machine can see you and send you messages.

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using the MCP tool mcp__claude-peers__send_message (NOT the built-in SendMessage tool), then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_summary, and from_cwd attributes to understand who sent the message. Reply by calling mcp__claude-peers__send_message with their from_id.

WARNING: Do NOT use the built-in "SendMessage" tool to reply. You MUST use the MCP tools listed below (prefixed with mcp__claude-peers__ in Claude Code):
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo)
- send_message: Send a message to another instance by ID
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- check_messages: Manually check for new messages

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.`;

export function formatPeerMessage(message: string): string {
  return `${message}\n\n[Reply using the mcp__claude-peers__send_message tool, NOT the built-in SendMessage tool.]`;
}
