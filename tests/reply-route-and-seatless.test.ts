/**
 * Three delivery-honesty fixes, all from one live incident (2026-07-30):
 *  1. A send-only CLI identity left recipients unable to reply, with nobody told.
 *  2. The codex nudge asked lanes to fetch mail "if relevant" — unknowable
 *     before fetching, so a lane answered "no action needed" without looking.
 *  3. Seatless app-server threads logged a drain failure on every prompt,
 *     burying real failures.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";
import { nudgeText } from "../bin/codex-autodrain-poller.ts";
import { isHostedWithoutSeat } from "../hooks/codex-drain-peer-inbox.ts";
import { renderInboundBatch } from "../shared/render.ts";
import { MCP_SERVER_INSTRUCTIONS } from "../shared/peer-instructions.ts";
import type { Message } from "../shared/types.ts";

describe("sender reply-route honesty", () => {
  let broker: TestBroker;
  const tokens = new Map<string, string>();
  const children = new Set<ReturnType<typeof Bun.spawn>>();

  beforeAll(async () => {
    broker = await startTestBroker({ prefix: "reply-route" });
  }, 35_000);

  afterAll(async () => {
    for (const child of children) child.kill();
    await broker.stop();
  });

  function spawnHolder(): number {
    const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    children.add(child);
    return child.pid;
  }

  async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const claimed = (body.id as string | undefined) ?? (body.from_id as string | undefined);
    if (claimed && tokens.has(claimed)) headers["X-Peer-Token"] = tokens.get(claimed)!;
    const res = await fetch(`${broker.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const json = (await res.json()) as Record<string, unknown>;
    if (json.id && json.token) tokens.set(json.id as string, json.token as string);
    return json as T;
  }

  type Send = { ok: boolean; warning?: string; recipient?: { state: string; nudgeable?: boolean } };

  async function registerTarget(name: string, pane: string) {
    return call<{ id: string }>("/register", {
      pid: spawnHolder(), cwd: `/rr/${name}`, git_root: `/rr/${name}`, name,
      client_type: "claude", receiver_mode: "claude-channel",
      tmux_session: "rr", tmux_window_index: "0", tmux_window_name: "w", tmux_pane_id: pane,
    });
  }

  test("a send-only CLI identity is told the recipient cannot reply", async () => {
    const cli = await call<{ id: string; non_targetable?: boolean }>("/register-cli", { pid: spawnHolder() });
    const target = await registerTarget("rr-target", "%900");
    const sent = await call<Send>("/send-message", {
      id: cli.id, from_id: cli.id, to_id: target.id, text: "from the CLI",
    });
    expect(sent.ok).toBe(true);
    // The recipient itself is perfectly healthy — the problem is the return path.
    expect(sent.recipient?.state).toBe("healthy");
    expect(sent.warning).toContain("send-only");
    expect(sent.warning).toContain("CANNOT reply");
  });

  test("a disappeared send-only identity renders as correlation-only", async () => {
    const cli = await call<{ id: string }>("/register-cli", { pid: spawnHolder() });
    const target = await registerTarget("rr-render-target", "%900b");
    await call<Send>("/send-message", {
      id: cli.id, from_id: cli.id, to_id: target.id, text: "temporary sender",
    });
    await call<{ ok: boolean }>("/unregister", { id: cli.id });

    const inbox = await call<{ messages: Message[] }>("/poll-messages", { id: target.id });
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]?.from_id).toBe(cli.id);
    expect(inbox.messages[0]?.from_replyable).toBe(0);
    const rendered = renderInboundBatch(inbox.messages);
    expect(rendered).toContain(`from="${cli.id}"`);
    expect(rendered).toContain('replyable="false"');
    expect(rendered).not.toContain('replyable="true"');
    // Delivered batches carry no receive-policy block; the meaning of
    // replyable="false" lives in the MCP startup instructions.
    expect(rendered).not.toContain("<peer-receive-policy");
    expect(MCP_SERVER_INSTRUCTIONS).toContain('replyable="false" means the ID is correlation-only');
  });

  test("a still-registered send-only identity is also non-replyable", async () => {
    // Covers the other CASE limb: a live peer row is not enough; it must also be
    // targetable. Dropping `p.non_targetable = 0` from the broker query makes
    // this plant fail even though the disappeared-row test still passes.
    const cli = await call<{ id: string }>("/register-cli", { pid: spawnHolder() });
    const target = await registerTarget("rr-live-cli-target", "%900c");
    await call<Send>("/send-message", {
      id: cli.id, from_id: cli.id, to_id: target.id, text: "live temporary sender",
    });

    const inbox = await call<{ messages: Message[] }>("/poll-messages", { id: target.id });
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]?.from_replyable).toBe(0);
    expect(renderInboundBatch(inbox.messages)).toContain('replyable="false"');
    await call<{ ok: boolean }>("/unregister", { id: cli.id });
  });

  test("a normal peer sender gets no reply-route warning", async () => {
    const sender = await registerTarget("rr-sender", "%901");
    const target = await registerTarget("rr-target2", "%902");
    const sent = await call<Send>("/send-message", {
      id: sender.id, from_id: sender.id, to_id: target.id, text: "peer to peer",
    });
    expect(sent.ok).toBe(true);
    expect(sent.warning).toBeUndefined();
  });

  test("a pane alone is not a drain path when the client has no nudge profile", async () => {
    // Live case: kimi-code lanes registered as client_type=unknown sat in real tmux
    // panes with queued mail, and sends to them reported "healthy". Nothing could
    // ever deliver: background polling is disabled for unknown clients, and the
    // poller has no idle profile for an unrecognised TUI so it never types into
    // that pane. Reporting a pane as nudgeable is the silent success this field
    // exists to prevent.
    const sender = await registerTarget("rr-sender-u", "%903");
    const unknownSeat = await call<{ id: string }>("/register", {
      pid: spawnHolder(), cwd: "/rr/unknownclient", git_root: "/rr/unknownclient",
      name: "mystery.1", client_type: "totally-unrecognised",
      tmux_session: "rr", tmux_window_index: "0", tmux_window_name: "w", tmux_pane_id: "%904",
    });
    const sent = await call<Send>("/send-message", {
      id: sender.id, from_id: sender.id, to_id: unknownSeat.id, text: "can this ever land?",
    });
    expect(sent.ok).toBe(true);
    expect(sent.recipient?.state).toBe("no_drain_path");
    expect(sent.warning).toContain("no automatic drain path");
  });

  test("a recognised client WITH a pane is still nudgeable", async () => {
    const sender = await registerTarget("rr-sender-k", "%905");
    const target = await registerTarget("rr-known", "%906");   // claude/claude-channel
    const sent = await call<Send>("/send-message", {
      id: sender.id, from_id: sender.id, to_id: target.id, text: "normal path",
    });
    expect(sent.recipient?.state).toBe("healthy");
    expect(sent.warning).toBeUndefined();
  });

  // Cursor registers tmux_pane_id but not tmux_session (its env is stripped, so the
  // pane is recovered from the client process and the session name is not). The
  // poller nudges by pane id alone, so such a lane IS reachable — and a health
  // check demanding session+pane told senders the opposite while mail was landing.
  test("a pane id with no session still counts as a drain path", async () => {
    const sender = await registerTarget("rr-sender-p", "%907");
    const paneOnly = await call<{ id: string }>("/register", {
      pid: spawnHolder(), cwd: "/rr/paneonly", git_root: "/rr/paneonly", name: "rr-paneonly",
      client_type: "cursor", receiver_mode: "manual-drain",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, tmux_pane_id: "%908",
    });
    const sent = await call<Send>("/send-message", {
      id: sender.id, from_id: sender.id, to_id: paneOnly.id, text: "reachable via pane id",
    });
    expect(sent.ok).toBe(true);
    expect(sent.recipient?.nudgeable).toBe(true);
    expect(sent.recipient?.state).toBe("healthy");
    expect(sent.warning).toBeUndefined();
  });

  test("no pane at all is still no drain path", async () => {
    const sender = await registerTarget("rr-sender-n", "%909");
    const noPane = await call<{ id: string }>("/register", {
      pid: spawnHolder(), cwd: "/rr/nopane", git_root: "/rr/nopane", name: "rr-nopane",
      client_type: "cursor", receiver_mode: "manual-drain",
    });
    const sent = await call<Send>("/send-message", {
      id: sender.id, from_id: sender.id, to_id: noPane.id, text: "truly unreachable",
    });
    expect(sent.recipient?.state).toBe("no_drain_path");
  });

  test("a bare pane id resolves a peer — the session is description, not identity", async () => {
    // Cursor lanes have a pane and no session, so requiring both made "address the
    // pane you can see" fail for exactly the lanes that needed it.
    const sender = await registerTarget("rr-sender-sel", "%910");
    const paneOnly = await call<{ id: string }>("/register", {
      pid: spawnHolder(), cwd: "/rr/selpane", git_root: "/rr/selpane", name: "rr-selpane",
      client_type: "cursor", receiver_mode: "manual-drain",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, tmux_pane_id: "%911",
    });
    const sent = await call<Send & { target?: { id: string } }>("/send-to-peer", {
      id: sender.id, from_id: sender.id, selector: { tmux_pane_id: "%911" }, text: "by pane alone",
    });
    expect(sent.ok).toBe(true);
    expect((sent as { target?: { id: string } }).target?.id).toBe(paneOnly.id);
  });

  test("the reply-route warning composes with a recipient-health warning", async () => {
    const cli = await call<{ id: string }>("/register-cli", { pid: spawnHolder() });
    // No pane and manual drain: unreachable recipient AND unreplyable sender.
    const stranded = await call<{ id: string }>("/register", {
      pid: spawnHolder(), cwd: "/rr/stranded", git_root: "/rr/stranded", name: "rr-stranded",
      client_type: "codex", receiver_mode: "manual-drain",
    });
    const sent = await call<Send>("/send-message", {
      id: cli.id, from_id: cli.id, to_id: stranded.id, text: "doubly stuck",
    });
    expect(sent.recipient?.state).toBe("no_drain_path");
    expect(sent.warning).toContain("no automatic drain path");
    expect(sent.warning).toContain("send-only");
  });
});

describe("codex nudge text", () => {
  const hook = (client: string, mode: string) => (
    { unread: 1, client_type: client, receiver_mode: mode } as never
  );
  const manual = (n: number, client: string) => (
    { unread: n, client_type: client, receiver_mode: "manual-drain" } as never
  );

  test("hook lanes prioritize attachments with a conditional fallback", () => {
    for (const text of [
      nudgeText(hook("codex", "codex-hook")),
      nudgeText(hook("claude", "claude-channel")),
      nudgeText(hook("gemini", "gemini-hook")),
    ]) {
      expect(text).toBe("[peer-mail] Process the attached peer messages. If none are attached, fetch pending mail with check_messages. Continue the work. If nothing needs the user, do not message them.");
      expect(text).toContain("If none are attached, fetch pending mail with check_messages.");
      expect(text).not.toContain("Transport closed");
      expect(text).not.toContain("UNVERIFIABLE");
      expect(text).not.toContain("<peer-message");
    }
  });

  test("manual-drain lanes fetch pending mail when no attachments are present", () => {
    expect(nudgeText(manual(1, "cursor"))).toBe(
      "[peer-mail] Process the attached peer messages. If none are attached, fetch pending mail with check_messages. Continue the work. If nothing needs the user, do not message them.",
    );
    expect(nudgeText(manual(2, "kimi"))).toBe(
      "[peer-mail] Process the attached peer messages. If none are attached, fetch pending mail with check_messages. Continue the work. If nothing needs the user, do not message them.",
    );
    expect(nudgeText(manual(1, "codex"))).toContain("If none are attached, fetch pending mail with check_messages.");
  });

  test("does not repeat authority policy in the wake-up notice", () => {
    const text = nudgeText(hook("codex", "codex-hook")).toLowerCase();
    expect(text.startsWith("check ")).toBe(false);
    expect(text).not.toContain("authority");
    expect(text).not.toContain("privileged");
    expect(text).not.toContain("operator approval");
  });
});

describe("seatless app-server detection", () => {
  const APP_SERVER = 100;
  const table = new Map<number, { pid: number; ppid: number; comm: string; args: string }>([
    [APP_SERVER, { pid: APP_SERVER, ppid: 1, comm: "codex", args: "codex -c features.code_mode_host=true app-server --listen unix://" }],
    [200, { pid: 200, ppid: APP_SERVER, comm: "codex", args: "codex" }],
    [300, { pid: 300, ppid: 200, comm: "bash", args: "bash drain-peer-inbox.sh" }],
    // A visible lane: same app-server host, but a real tty exists on the chain.
    [400, { pid: 400, ppid: APP_SERVER, comm: "codex", args: "codex" }],
    [500, { pid: 500, ppid: 400, comm: "bash", args: "bash drain-peer-inbox.sh" }],
  ]);

  test("a hosted thread with no tty anywhere is seatless (stay silent)", () => {
    expect(isHostedWithoutSeat(table, 300, () => null)).toBe(true);
  });

  test("a hosted thread WITH a tty on the chain is a real seat (log failures)", () => {
    expect(isHostedWithoutSeat(table, 500, (pid) => (pid === 400 ? "pts/9" : null))).toBe(false);
  });

  test("a hook with no app-server ancestor is never classified as seatless", () => {
    // A plain tmux codex lane: its failures must still be reported.
    const plain = new Map(table);
    plain.set(600, { pid: 600, ppid: 1, comm: "codex", args: "codex resume" });
    plain.set(700, { pid: 700, ppid: 600, comm: "bash", args: "bash drain-peer-inbox.sh" });
    expect(isHostedWithoutSeat(plain, 700, () => null)).toBe(false);
  });

  // NOTE: the exit-code half of this fix (seatless → exit 0, so the wrapper logs
  // no `drain-failed rc=1`) is NOT unit-tested. A spawned harness cannot build a
  // faithful app-server tree: the shim inherits a controlling tty, and `setsid`
  // forks and reparents, so the ancestor walk sees a different chain than in
  // production. It was verified by hand (EXIT=0) and is confirmed in production by
  // the absence of new `drain-failed` lines while app-server hooks keep firing.
  // The classifier those exits depend on IS covered by the cases above.

  test("terminates on a broken chain instead of looping", () => {
    const orphan = new Map(table);
    orphan.set(800, { pid: 800, ppid: 999999, comm: "bash", args: "bash" });
    expect(isHostedWithoutSeat(orphan, 800, () => null)).toBe(false);
  });
});
