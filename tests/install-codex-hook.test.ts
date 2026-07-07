import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installer = new URL("../bin/install-codex-hook.ts", import.meta.url).pathname;
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const expectedDrainCommand = `/usr/bin/env bash ${shellQuote(new URL("../hooks/codex-drain-peer-inbox.sh", import.meta.url).pathname)}`;
const expectedRegisterCommand = `/usr/bin/env bash ${shellQuote(new URL("../hooks/codex-register-peer-session.sh", import.meta.url).pathname)}`;

describe("Codex hook installer", () => {
  test("merges into existing hooks and remains idempotent", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claude-peers-install-"));
    try {
      const hooksPath = join(repo, ".codex", "hooks.json");
      mkdirSync(join(repo, ".codex"), { recursive: true });
      await Bun.write(hooksPath, JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: "/usr/bin/env bash existing-rule-router.sh",
                  timeout: 5,
                },
              ],
            },
          ],
        },
      }, null, 2));

      for (let i = 0; i < 2; i++) {
        const proc = Bun.spawn(["bun", installer, repo], { stdout: "ignore", stderr: "pipe" });
        const stderr = await new Response(proc.stderr).text();
        expect(await proc.exited).toBe(0);
        expect(stderr).toBe("");
      }

      const doc = JSON.parse(readFileSync(hooksPath, "utf8")) as {
        hooks: {
          SessionStart: Array<{ matcher?: string; hooks: Array<{ command: string; name?: string; timeout?: number }> }>;
          UserPromptSubmit: Array<{ hooks: Array<{ command: string; name?: string; timeout?: number }> }>;
        };
      };
      const hooks = doc.hooks.UserPromptSubmit.flatMap((bucket) => bucket.hooks);
      const commands = hooks.map((hook) => hook.command);
      expect(commands).toContain("/usr/bin/env bash existing-rule-router.sh");
      expect(commands.filter((command) => command === expectedDrainCommand).length).toBe(1);
      expect(hooks.find((hook) => hook.command === expectedDrainCommand)?.name).toBe("claude-peers-codex-inbox");
      expect(hooks.find((hook) => hook.command === expectedDrainCommand)?.timeout).toBe(10);

      const startupHooks = doc.hooks.SessionStart.flatMap((bucket) => bucket.hooks);
      expect(doc.hooks.SessionStart[0]?.matcher).toBe("startup|resume");
      expect(startupHooks.filter((hook) => hook.command === expectedRegisterCommand)).toHaveLength(1);
      expect(startupHooks.find((hook) => hook.command === expectedRegisterCommand)?.name).toBe("claude-peers-codex-register");
      expect(startupHooks.find((hook) => hook.command === expectedRegisterCommand)?.timeout).toBe(10);

      // Session-start drain + Stop drain are installed exactly once each (the
      // double-run above is the idempotence guard).
      const expectedSessionDrain = `CLAUDE_PEERS_HOOK_EVENT_NAME=SessionStart ${expectedDrainCommand}`;
      const expectedStopDrain = `CLAUDE_PEERS_HOOK_EVENT_NAME=Stop ${expectedDrainCommand}`;
      expect(startupHooks.filter((hook) => hook.command === expectedSessionDrain)).toHaveLength(1);
      expect(startupHooks.find((hook) => hook.command === expectedSessionDrain)?.name).toBe("claude-peers-codex-session-drain");
      const stopBuckets = (doc.hooks as unknown as { Stop?: Array<{ hooks: Array<{ command: string; name?: string }> }> }).Stop ?? [];
      const stopHooks = stopBuckets.flatMap((bucket) => bucket.hooks);
      expect(stopHooks.filter((hook) => hook.command === expectedStopDrain)).toHaveLength(1);
      expect(stopHooks.find((hook) => hook.command === expectedStopDrain)?.name).toBe("claude-peers-codex-stop-drain");
      // The plain UserPromptSubmit drain must not have been duplicated or
      // captured by the new env-prefixed predicates.
      expect(commands.filter((command) => command.includes("CLAUDE_PEERS_HOOK_EVENT_NAME="))).toHaveLength(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("rejects invalid existing JSON instead of overwriting it", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claude-peers-install-bad-"));
    try {
      const hooksPath = join(repo, ".codex", "hooks.json");
      mkdirSync(join(repo, ".codex"), { recursive: true });
      writeFileSync(hooksPath, "{not-json");
      const proc = Bun.spawn(["bun", installer, repo], { stdout: "ignore", stderr: "pipe" });
      await new Response(proc.stderr).text();
      expect(await proc.exited).not.toBe(0);
      expect(readFileSync(hooksPath, "utf8")).toBe("{not-json");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("replaces stale legacy hook command instead of appending a duplicate", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claude-peers-install-stale-"));
    try {
      const hooksPath = join(repo, ".codex", "hooks.json");
      mkdirSync(join(repo, ".codex"), { recursive: true });
      await Bun.write(hooksPath, JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: "/usr/bin/env bash /old/hooks/codex-drain-peer-inbox.sh",
                  timeout: 5,
                },
              ],
            },
            {
              hooks: [
                {
                  name: "claude-peers-codex-inbox",
                  type: "command",
                  command: expectedDrainCommand,
                  timeout: 10,
                },
              ],
            },
          ],
        },
      }, null, 2));

      const proc = Bun.spawn(["bun", installer, repo], { stdout: "ignore", stderr: "pipe" });
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(0);
      expect(stderr).toBe("");

      const doc = JSON.parse(readFileSync(hooksPath, "utf8")) as {
        hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string; name?: string; timeout?: number }> }> };
      };
      const hooks = doc.hooks.UserPromptSubmit.flatMap((bucket) => bucket.hooks);
      const peerHooks = hooks.filter((hook) => hook.command.includes("codex-drain-peer-inbox.sh"));
      expect(peerHooks).toHaveLength(1);
      expect(peerHooks[0]?.command).toBe(expectedDrainCommand);
      expect(peerHooks[0]?.name).toBe("claude-peers-codex-inbox");
      expect(peerHooks[0]?.timeout).toBe(10);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("treats local safe wrapper as the same peer inbox hook", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claude-peers-install-safe-"));
    try {
      const hooksPath = join(repo, ".codex", "hooks.json");
      mkdirSync(join(repo, ".codex"), { recursive: true });
      await Bun.write(hooksPath, JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: "/usr/bin/env bash \"$(git rev-parse --show-toplevel)/.codex/hooks/codex-drain-peer-inbox-safe.sh\"",
                  timeout: 10,
                },
              ],
            },
            {
              hooks: [
                {
                  name: "claude-peers-codex-inbox",
                  type: "command",
                  command: expectedDrainCommand,
                  timeout: 10,
                },
              ],
            },
          ],
        },
      }, null, 2));

      const proc = Bun.spawn(["bun", installer, repo], { stdout: "ignore", stderr: "pipe" });
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(0);
      expect(stderr).toBe("");

      const doc = JSON.parse(readFileSync(hooksPath, "utf8")) as {
        hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string; name?: string }> }> };
      };
      const peerHooks = doc.hooks.UserPromptSubmit
        .flatMap((bucket) => bucket.hooks)
        .filter((hook) => hook.command.includes("codex-drain-peer-inbox"));
      expect(peerHooks).toHaveLength(1);
      expect(peerHooks[0]?.command).toBe(expectedDrainCommand);
      expect(peerHooks[0]?.name).toBe("claude-peers-codex-inbox");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("normalizes an existing startup-only register bucket to startup and resume", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claude-peers-install-register-"));
    try {
      const hooksPath = join(repo, ".codex", "hooks.json");
      mkdirSync(join(repo, ".codex"), { recursive: true });
      await Bun.write(hooksPath, JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "startup",
              hooks: [
                {
                  name: "claude-peers-codex-register",
                  type: "command",
                  command: "/usr/bin/env bash /old/hooks/codex-register-peer-session.sh",
                  timeout: 10,
                },
              ],
            },
          ],
        },
      }, null, 2));

      const proc = Bun.spawn(["bun", installer, repo], { stdout: "ignore", stderr: "pipe" });
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(0);
      expect(stderr).toBe("");

      const doc = JSON.parse(readFileSync(hooksPath, "utf8")) as {
        hooks: { SessionStart: Array<{ matcher?: string; hooks: Array<{ command: string }> }> };
      };
      expect(doc.hooks.SessionStart).toHaveLength(1);
      expect(doc.hooks.SessionStart[0]?.matcher).toBe("startup|resume");
      expect(doc.hooks.SessionStart[0]?.hooks.map((hook) => hook.command)).toEqual([
        expectedRegisterCommand,
        `CLAUDE_PEERS_HOOK_EVENT_NAME=SessionStart ${expectedDrainCommand}`,
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
