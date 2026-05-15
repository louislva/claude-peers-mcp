import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { findMcpPidFromTable } from "../hooks/codex-drain-peer-inbox.ts";
import { detectClientFromProcessChain, initialReceiverMode, type ProcessInfo } from "../shared/client.ts";

function table(rows: ProcessInfo[]): Map<number, ProcessInfo> {
  return new Map(rows.map((row) => [row.pid, row]));
}

describe("client detection", () => {
  test("explicit override wins", () => {
    const processes = table([{ pid: 10, ppid: 1, comm: "bash", args: "bash" }]);
    expect(detectClientFromProcessChain(10, processes, { CLAUDE_PEERS_CLIENT_TYPE: "codex" })).toBe("codex");
  });

  test("detects Codex ancestor through wrappers", () => {
    const processes = table([
      { pid: 30, ppid: 20, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" },
      { pid: 20, ppid: 10, comm: "node", args: "node helper" },
      { pid: 10, ppid: 1, comm: "codex", args: "codex" },
    ]);
    expect(detectClientFromProcessChain(30, processes, {})).toBe("codex");
  });

  test("detects Claude parent", () => {
    const processes = table([
      { pid: 20, ppid: 10, comm: "claude", args: "claude --dangerously-load-development-channels" },
      { pid: 10, ppid: 1, comm: "bash", args: "bash" },
    ]);
    expect(detectClientFromProcessChain(20, processes, {})).toBe("claude");
  });

  test("unknown fallback maps to unknown receiver mode", () => {
    const processes = table([{ pid: 20, ppid: 1, comm: "bash", args: "bash" }]);
    expect(detectClientFromProcessChain(20, processes, {})).toBe("unknown");
    expect(initialReceiverMode("unknown")).toBe("unknown");
  });

  test("Codex starts as manual drain until hook heartbeat proves capability", () => {
    expect(initialReceiverMode("codex")).toBe("manual-drain");
  });

  test("Codex disables the Claude background poll buffer", () => {
    const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    expect(src).toContain('if (myClientType === "codex")');
    expect(src).toContain("background channel poll disabled");
  });

  test("Codex hook discovers the MCP server from process ancestry without env PID", () => {
    const processes = new Map([
      [10, { pid: 10, ppid: 1, comm: "codex", args: "codex" }],
      [20, { pid: 20, ppid: 10, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" }],
      [30, { pid: 30, ppid: 10, comm: "bun", args: "bun hooks/codex-drain-peer-inbox.ts" }],
    ]);
    const pid = findMcpPidFromTable(processes, 10, "/repo", (candidate) => candidate === 20 ? "/repo" : "/other");
    expect(pid).toBe(20);
  });
});
