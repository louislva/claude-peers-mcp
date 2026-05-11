import { describe, expect, test } from "bun:test";
import {
  detectChannelLoaded,
  matchesChannelFlag,
  readParentArgs,
} from "./shared/channel-detection.ts";

describe("matchesChannelFlag", () => {
  test("returns false for null input", () => {
    expect(matchesChannelFlag(null)).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(matchesChannelFlag("")).toBe(false);
  });

  test("returns false when flag is absent", () => {
    expect(matchesChannelFlag("claude --continue --permission-mode auto")).toBe(false);
  });

  test("returns true when flag and server name match (mc-daemon-style argv)", () => {
    const args =
      "claude --name mc-daemon --continue --permission-mode auto --dangerously-load-development-channels server:claude-peers";
    expect(matchesChannelFlag(args)).toBe(true);
  });

  test("returns true when one-shot mode is used", () => {
    const args =
      "claude --dangerously-load-development-channels server:claude-peers -p please call list_peers";
    expect(matchesChannelFlag(args)).toBe(true);
  });

  test("returns true when claude-peers is one of several comma-separated servers", () => {
    const args =
      "claude --dangerously-load-development-channels server:other,server:claude-peers,server:third";
    expect(matchesChannelFlag(args)).toBe(true);
  });

  test("returns false for similarly-named server (word boundary)", () => {
    // Guards against matching `claude-peers-fork` when the user only flagged a fork.
    const args = "claude --dangerously-load-development-channels server:claude-peers-fork";
    expect(matchesChannelFlag(args)).toBe(false);
  });

  test("returns false when flag is present but only for a different server", () => {
    const args = "claude --dangerously-load-development-channels server:other-server";
    expect(matchesChannelFlag(args)).toBe(false);
  });

  test("returns false when only one of (flag, server) is present", () => {
    // Mentioning the server name without the flag (e.g. in another arg) shouldn't trigger.
    expect(matchesChannelFlag("claude -p talk about server:claude-peers please")).toBe(false);
  });

  test("returns true for --flag=value form", () => {
    // Equals-separator variant — supported by the [ =] character class in the regex.
    expect(
      matchesChannelFlag(
        "claude --dangerously-load-development-channels=server:claude-peers -p exit"
      )
    ).toBe(true);
  });
});

describe("readParentArgs", () => {
  test("returns this test process's own argv when given own pid (Linux /proc path)", async () => {
    const args = await readParentArgs(process.pid);
    expect(args).not.toBeNull();
    expect(args!.length).toBeGreaterThan(0);
    expect(args!.toLowerCase()).toContain("bun");
  });

  test("returns null for a pid that cannot exist", async () => {
    const args = await readParentArgs(99999999);
    expect(args).toBeNull();
  });
});

describe("detectChannelLoaded (composition)", () => {
  // The original PR-#53 bug shape was "components work in isolation but the wiring
  // between them silently returns false." These tests exercise the full pipeline —
  // /proc read, null-byte split, matcher — against a real running process with a
  // controlled argv, so a regression in the composition layer is caught.
  const sleepScript = "await new Promise((r) => setTimeout(r, 30000))";

  test("returns true when target process's argv has the flag", async () => {
    const proc = Bun.spawn(
      ["bun", "-e", sleepScript, "--dangerously-load-development-channels", "server:claude-peers"],
      { stdio: ["ignore", "ignore", "ignore"] }
    );
    try {
      // Brief wait so /proc/<pid>/cmdline is populated.
      await new Promise((r) => setTimeout(r, 100));
      expect(await detectChannelLoaded(proc.pid)).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("returns false when target process's argv lacks the flag", async () => {
    const proc = Bun.spawn(["bun", "-e", sleepScript], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    try {
      await new Promise((r) => setTimeout(r, 100));
      expect(await detectChannelLoaded(proc.pid)).toBe(false);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("returns false when target pid does not exist", async () => {
    expect(await detectChannelLoaded(99999999)).toBe(false);
  });
});
