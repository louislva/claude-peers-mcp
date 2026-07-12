import { describe, expect, test } from "bun:test";
import { formatPeerMessage, PEER_INSTRUCTIONS } from "./instructions.ts";

describe("peer reply guidance", () => {
  test("server instructions disambiguate the MCP tool", () => {
    expect(PEER_INSTRUCTIONS).toContain("mcp__claude-peers__send_message");
    expect(PEER_INSTRUCTIONS).toContain('Do NOT use the built-in "SendMessage"');
  });

  test("channel messages preserve content and append the tool hint", () => {
    const content = formatPeerMessage("Can you review this change?");

    expect(content).toStartWith("Can you review this change?");
    expect(content).toContain("mcp__claude-peers__send_message");
    expect(content).toContain("NOT the built-in SendMessage");
  });
});
