import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeFakeInstall(wrapperName: string): { root: string; wrapper: string } {
  const root = mkdtempSync(join(tmpdir(), "claude-peers-wrapper-"));
  const hooksDir = join(root, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const wrapper = join(hooksDir, wrapperName);
  copyFileSync(new URL(`../hooks/${wrapperName}`, import.meta.url), wrapper);
  writeFileSync(join(hooksDir, "codex-drain-peer-inbox.ts"), `
console.log(JSON.stringify({
  cwd: process.cwd(),
  client: process.env.CLAUDE_PEERS_CLIENT_TYPE ?? null,
  event: process.env.CLAUDE_PEERS_HOOK_EVENT_NAME ?? null
}));
`);
  writeFileSync(join(hooksDir, "register-peer-session.ts"), `
console.log(JSON.stringify({
  cwd: process.cwd(),
  client: process.env.CLAUDE_PEERS_CLIENT_TYPE ?? null
}));
`);
  return { root, wrapper };
}

describe("hook shell wrappers", () => {
  test("Codex wrapper resolves the TypeScript hook relative to its own install path", async () => {
    const { root, wrapper } = makeFakeInstall("codex-drain-peer-inbox.sh");
    try {
      const proc = Bun.spawn(["bash", wrapper], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(0);
      expect(stderr).toBe("");
      const payload = JSON.parse(stdout) as { cwd: string; client: string | null; event: string | null };
      expect(payload.cwd).toBe(root);
      expect(payload.client).toBeNull();
      expect(payload.event).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Gemini wrapper resolves the TypeScript hook relative to its own install path", async () => {
    const { root, wrapper } = makeFakeInstall("gemini-drain-peer-inbox.sh");
    try {
      const proc = Bun.spawn(["bash", wrapper], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(0);
      expect(stderr).toBe("");
      const payload = JSON.parse(stdout) as { cwd: string; client: string | null; event: string | null };
      expect(payload.cwd).toBe(root);
      expect(payload.client).toBe("gemini");
      expect(payload.event).toBe("BeforeAgent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Codex register wrapper resolves the startup hook relative to its own install path", async () => {
    const { root, wrapper } = makeFakeInstall("codex-register-peer-session.sh");
    try {
      const proc = Bun.spawn(["bash", wrapper], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(0);
      expect(stderr).toBe("");
      const payload = JSON.parse(stdout) as { cwd: string; client: string | null };
      expect(payload.cwd).toBe(root);
      expect(payload.client).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Gemini register wrapper resolves the startup hook relative to its own install path", async () => {
    const { root, wrapper } = makeFakeInstall("gemini-register-peer-session.sh");
    try {
      const proc = Bun.spawn(["bash", wrapper], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(0);
      expect(stderr).toBe("");
      const payload = JSON.parse(stdout) as { cwd: string; client: string | null };
      expect(payload.cwd).toBe(root);
      expect(payload.client).toBe("gemini");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
