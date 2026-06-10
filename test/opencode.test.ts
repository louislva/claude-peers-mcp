import { test, expect } from "bun:test";
import { parsePsOutput, descendantPids, formatChannelMessage } from "../shared/opencode.ts";
import type { Message, Peer } from "../shared/types.ts";

test("parsePsOutput parses pid/ppid/args rows", () => {
  const out = `    1     0 /sbin/init
  200     1 opencode
  300   200 bun /home/x/claude-peers-mcp/server.ts
 trailing garbage line
`;
  expect(parsePsOutput(out)).toEqual([
    { pid: 1, ppid: 0, args: "/sbin/init" },
    { pid: 200, ppid: 1, args: "opencode" },
    { pid: 300, ppid: 200, args: "bun /home/x/claude-peers-mcp/server.ts" },
  ]);
});

test("descendantPids walks the full subtree", () => {
  const rows = parsePsOutput(`1 0 init
2 1 opencode
3 2 bun server.ts
4 3 git
5 1 unrelated`);
  expect(descendantPids(rows, 2)).toEqual(new Set([3, 4]));
  expect(descendantPids(rows, 5)).toEqual(new Set());
});

test("formatChannelMessage mirrors the channel format and escapes attributes", () => {
  const msg = {
    id: 1,
    from_id: "peer-abc",
    to_id: "peer-def",
    text: "hello <world>",
    sent_at: "2026-06-09T12:00:00Z",
    delivered: false,
  } satisfies Message;
  const sender = {
    id: "peer-abc",
    pid: 123,
    cwd: "/home/x",
    git_root: null,
    tty: null,
    summary: 'working on "stuff" & things',
    registered_at: "",
    last_seen: "",
  } satisfies Peer;

  const text = formatChannelMessage(msg, sender);
  expect(text).toContain('<channel source="claude-peers" from_id="peer-abc"');
  expect(text).toContain('from_summary="working on &quot;stuff&quot; &amp; things"');
  expect(text).toContain('from_cwd="/home/x"');
  expect(text).toContain("hello <world>");
  expect(text).toContain("send_message");
});
