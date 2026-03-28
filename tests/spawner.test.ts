import { test, expect } from "bun:test";
import { buildClaudeCommand, generateAppleScript } from "../shared/spawner.ts";
import type { SpawnConfig } from "../shared/spawner.ts";

test("buildClaudeCommand with role only", () => {
  const cmd = buildClaudeCommand("frontend-dev");
  expect(cmd).toContain('CLAUDE_PEERS_ROLE="frontend-dev"');
  expect(cmd).toContain("--dangerously-skip-permissions");
  expect(cmd).toContain("--dangerously-load-development-channels server:claude-peers");
  expect(cmd).not.toContain("--prompt");
});

test("buildClaudeCommand with prompt", () => {
  const cmd = buildClaudeCommand("backend-dev", "Koordinatöre bağlan");
  expect(cmd).toContain('CLAUDE_PEERS_ROLE="backend-dev"');
  expect(cmd).toContain('--prompt "Koordinatöre bağlan"');
});

test("buildClaudeCommand escapes quotes in prompt", () => {
  const cmd = buildClaudeCommand("dev", 'say "hello"');
  expect(cmd).toContain('--prompt "say \\"hello\\""');
});

test("generateAppleScript for 1 peer", () => {
  const config: SpawnConfig = { roles: ["frontend-dev"], cwd: "/tmp/project" };
  const script = generateAppleScript(config);

  expect(script).toContain('tell application "Ghostty"');
  expect(script).toContain("activate");
  expect(script).toContain('cd \\"/tmp/project\\"');
  expect(script).toContain("new tab in front window");
  expect(script).toContain("focused terminal of newTab");
  expect(script).toContain("frontend-dev");
  expect(script).not.toContain("split");
  expect(script).toContain("end tell");
});

test("generateAppleScript for 2 peers creates right split", () => {
  const config: SpawnConfig = {
    roles: ["frontend-dev", "backend-dev"],
    cwd: "/tmp/project",
  };
  const script = generateAppleScript(config);

  expect(script).toContain("focused terminal of newTab");
  expect(script).toContain("split t1 direction right");
  expect(script).toContain("frontend-dev");
  expect(script).toContain("backend-dev");
  // Should have exactly 1 split
  expect(script.match(/split/g)?.length).toBe(1);
});

test("generateAppleScript for 3 peers creates right + down splits", () => {
  const config: SpawnConfig = {
    roles: ["frontend-dev", "backend-dev", "test-dev"],
    cwd: "/tmp/project",
  };
  const script = generateAppleScript(config);

  expect(script).toContain("split t1 direction right");
  expect(script).toContain("split t1 direction down");
  expect(script.match(/split/g)?.length).toBe(2);
  expect(script).toContain("frontend-dev");
  expect(script).toContain("backend-dev");
  expect(script).toContain("test-dev");
});

test("generateAppleScript for 4 peers creates 2x2 grid", () => {
  const config: SpawnConfig = {
    roles: ["frontend-dev", "backend-dev", "test-dev", "devops"],
    cwd: "/tmp/project",
  };
  const script = generateAppleScript(config);

  expect(script).toContain("split t1 direction right");
  expect(script).toContain("split t1 direction down");
  expect(script).toContain("split t2 direction down");
  expect(script.match(/split/g)?.length).toBe(3);
});

test("generateAppleScript with prompt includes --prompt flag", () => {
  const config: SpawnConfig = {
    roles: ["frontend-dev"],
    cwd: "/tmp/project",
    prompt: "Görevini al",
  };
  const script = generateAppleScript(config);

  expect(script).toContain("--prompt");
  expect(script).toContain("Görevini al");
});

test("generateAppleScript escapes CWD with spaces", () => {
  const config: SpawnConfig = {
    roles: ["dev"],
    cwd: "/Users/me/My Projects/app",
  };
  const script = generateAppleScript(config);

  expect(script).toContain("/Users/me/My Projects/app");
});
