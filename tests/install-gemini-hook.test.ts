import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installer = new URL("../bin/install-gemini-hook.ts", import.meta.url).pathname;
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const expectedDrainCommand = `/usr/bin/env bash ${shellQuote(new URL("../hooks/gemini-drain-peer-inbox.sh", import.meta.url).pathname)}`;
const expectedRegisterCommand = `/usr/bin/env bash ${shellQuote(new URL("../hooks/gemini-register-peer-session.sh", import.meta.url).pathname)}`;

describe("Gemini hook installer", () => {
  test("merges into existing settings and remains idempotent", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claude-peers-gemini-install-"));
    try {
      const settingsPath = join(repo, ".gemini", "settings.json");
      mkdirSync(join(repo, ".gemini"), { recursive: true });
      await Bun.write(settingsPath, JSON.stringify({
        mcpServers: {
          "claude-peers": {
            command: "bun",
            args: ["/home/manzo/claude-peers-mcp/server.ts"],
          },
        },
        hooks: {
          BeforeAgent: [
            {
              matcher: "*",
              hooks: [
                {
                  name: "existing-context",
                  type: "command",
                  command: "/usr/bin/env bash existing-gemini-context.sh",
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

      const doc = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        mcpServers: Record<string, unknown>;
        hooks: {
          SessionStart: Array<{ matcher?: string; hooks: Array<{ command: string; name?: string; timeout?: number }> }>;
          BeforeAgent: Array<{ hooks: Array<{ command: string; timeout?: number }> }>;
        };
      };
      expect(doc.mcpServers["claude-peers"]).toBeDefined();
      const hooks = doc.hooks.BeforeAgent.flatMap((bucket) => bucket.hooks);
      const commands = hooks.map((hook) => hook.command);
      expect(commands).toContain("/usr/bin/env bash existing-gemini-context.sh");
      expect(commands.filter((command) => command === expectedDrainCommand).length).toBe(1);
      expect(hooks.find((hook) => hook.command === expectedDrainCommand)?.timeout).toBe(10000);

      const startupHooks = doc.hooks.SessionStart.flatMap((bucket) => bucket.hooks);
      expect(doc.hooks.SessionStart[0]?.matcher).toBe("startup|resume");
      expect(startupHooks.filter((hook) => hook.command === expectedRegisterCommand)).toHaveLength(1);
      expect(startupHooks.find((hook) => hook.command === expectedRegisterCommand)?.name).toBe("claude-peers-gemini-register");
      expect(startupHooks.find((hook) => hook.command === expectedRegisterCommand)?.timeout).toBe(10000);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("rejects invalid existing JSON instead of overwriting it", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claude-peers-gemini-install-bad-"));
    try {
      const settingsPath = join(repo, ".gemini", "settings.json");
      mkdirSync(join(repo, ".gemini"), { recursive: true });
      writeFileSync(settingsPath, "{not-json");
      const proc = Bun.spawn(["bun", installer, repo], { stdout: "ignore", stderr: "pipe" });
      await new Response(proc.stderr).text();
      expect(await proc.exited).not.toBe(0);
      expect(readFileSync(settingsPath, "utf8")).toBe("{not-json");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("replaces stale named claude-peers hook instead of appending a duplicate", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claude-peers-gemini-install-stale-"));
    try {
      const settingsPath = join(repo, ".gemini", "settings.json");
      mkdirSync(join(repo, ".gemini"), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          BeforeAgent: [
            {
              matcher: "*",
              hooks: [
                {
                  name: "claude-peers-gemini-inbox",
                  type: "command",
                  command: "/usr/bin/env bash /old/hooks/gemini-drain-peer-inbox.sh",
                  timeout: 5000,
                },
              ],
            },
          ],
        },
      }, null, 2));

      const proc = Bun.spawn(["bun", installer, repo], { stdout: "ignore", stderr: "pipe" });
      await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(0);

      const doc = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        hooks: { BeforeAgent: Array<{ hooks: Array<{ name?: string; command: string; timeout?: number }> }> };
      };
      const peerHooks = doc.hooks.BeforeAgent
        .flatMap((bucket) => bucket.hooks)
        .filter((hook) => hook.name === "claude-peers-gemini-inbox");
      expect(peerHooks).toHaveLength(1);
      expect(peerHooks[0]!.command).toBe(expectedDrainCommand);
      expect(peerHooks[0]!.timeout).toBe(10000);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("normalizes an existing startup-only register bucket to startup and resume", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claude-peers-gemini-install-register-"));
    try {
      const settingsPath = join(repo, ".gemini", "settings.json");
      mkdirSync(join(repo, ".gemini"), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "startup",
              hooks: [
                {
                  name: "claude-peers-gemini-register",
                  type: "command",
                  command: "/usr/bin/env bash /old/hooks/gemini-register-peer-session.sh",
                  timeout: 10000,
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

      const doc = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        hooks: { SessionStart: Array<{ matcher?: string; hooks: Array<{ command: string }> }> };
      };
      expect(doc.hooks.SessionStart).toHaveLength(1);
      expect(doc.hooks.SessionStart[0]?.matcher).toBe("startup|resume");
      expect(doc.hooks.SessionStart[0]?.hooks.map((hook) => hook.command)).toEqual([expectedRegisterCommand]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
