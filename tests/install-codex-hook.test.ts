import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installer = new URL("../bin/install-codex-hook.ts", import.meta.url).pathname;
const expectedCommand = `/usr/bin/env bash ${new URL("../hooks/codex-drain-peer-inbox.sh", import.meta.url).pathname}`;

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
        hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> };
      };
      const commands = doc.hooks.UserPromptSubmit.flatMap((bucket) => bucket.hooks.map((hook) => hook.command));
      expect(commands).toContain("/usr/bin/env bash existing-rule-router.sh");
      expect(commands.filter((command) => command === expectedCommand).length).toBe(1);
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
});
