import { describe, expect, test } from "bun:test";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import {
  CLAUDE_CHANNEL_CAPABILITY,
  formatClientCapabilities,
  supportsClaudeChannel,
} from "./channel.ts";

describe("supportsClaudeChannel", () => {
  test("returns false before client initialization", () => {
    expect(supportsClaudeChannel()).toBe(false);
  });

  test("returns false when the capability is absent", () => {
    const capabilities: ClientCapabilities = {
      roots: { listChanged: true },
    };

    expect(supportsClaudeChannel(capabilities)).toBe(false);
  });

  test("returns true when the client advertises claude/channel", () => {
    const capabilities: ClientCapabilities = {
      experimental: {
        [CLAUDE_CHANNEL_CAPABILITY]: {},
      },
    };

    expect(supportsClaudeChannel(capabilities)).toBe(true);
  });
});

describe("formatClientCapabilities", () => {
  test("returns a readable placeholder before initialization", () => {
    expect(formatClientCapabilities()).toBe("(uninitialized)");
  });

  test("serializes initialized capabilities", () => {
    const capabilities: ClientCapabilities = {
      experimental: {
        [CLAUDE_CHANNEL_CAPABILITY]: {},
      },
      roots: {
        listChanged: true,
      },
    };

    expect(formatClientCapabilities(capabilities)).toBe(
      JSON.stringify(capabilities)
    );
  });
});
