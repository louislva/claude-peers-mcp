import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";

export const CLAUDE_CHANNEL_CAPABILITY = "claude/channel";

export function supportsClaudeChannel(capabilities?: ClientCapabilities): boolean {
  return Boolean(capabilities?.experimental?.[CLAUDE_CHANNEL_CAPABILITY]);
}

export function formatClientCapabilities(capabilities?: ClientCapabilities): string {
  if (!capabilities) {
    return "(uninitialized)";
  }

  try {
    return JSON.stringify(capabilities);
  } catch {
    return "(unserializable client capabilities)";
  }
}
