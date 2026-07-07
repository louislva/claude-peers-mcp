/**
 * #11 — PID-based name fallback (observer-${PID}).
 *
 * Tests the resolvePeerName() pure function extracted from server.ts main()
 * as part of the spec §1.5 follow-up #2 implementation. Closes the historic
 * "no env, no tmux → name=null" gap so peerName is always a non-empty string.
 *
 * Pre-#11: a bare-claude session with no CLAUDE_PEER_NAME env var and no tmux
 * registered with name=null and was unfindable by name (only by id).
 * Post-#11: such sessions get observer-${pid} as the final fallback.
 *
 * Mirror pattern matches tests/phase-a2-broker.test.ts and
 * tests/phase-b-r5b-ttl-reaper.test.ts. Unlike broker.ts, server.ts does NOT
 * have top-level Bun.serve side effects (it's an MCP stdio server, not an
 * HTTP listener), so resolvePeerName is imported as the real symbol — no
 * mirror copy needed.
 */

import { describe, test, expect } from "bun:test";
import {
  __testBrokerFetchForTest,
  __testSetBrokerAuthStateForTest,
  listPeersRoutingHint,
  normalizeTmuxTargetSelector,
  publishBrokerIdentityToTmux,
  planTmuxMirrorTransition,
  rewriteAuthBodyForPeer,
  shouldDisableBackgroundPolling,
  tmuxOnlyPeerHintFromList,
  chooseOperatorLabel,
  isHumanOperatorLabel,
  resolvePeerName,
  stripResolvedNameSuffix,
} from "../server";
import { findClientPidFromProcessChain, isClientProcess, isCodexAppServerProcess, type ProcessInfo } from "../shared/client";

// The heartbeat's tmux-identity maintenance delegates its branch selection to
// this pure function so the decision is RED-when-broken without a live tmux.
// Each case is a regression the seat-identity reviewers flagged.
describe("planTmuxMirrorTransition", () => {
  test("moved to a different pane WE still own → clear old + mirror new", () => {
    expect(planTmuxMirrorTransition("%10", "%20", "me", "me")).toEqual({ clearOld: true, mirrorNew: true });
  });

  test("moved, but a DIFFERENT live session reclaimed the old pane → do NOT clear", () => {
    // The orphaned-resume-stamped-over-the-live-seat case: dropping the
    // stampedPeerId===myId check would clear the real occupant's stamp.
    expect(planTmuxMirrorTransition("%10", "%20", "someoneElse", "me")).toEqual({ clearOld: false, mirrorNew: true });
  });

  test("transient no-pane tick (newTarget null) → never clear our own live stamp", () => {
    // detectTmuxPane hiccup while we still own %10: clearing here would wipe our
    // own live @peer_* on a tmux blip. mirrorNew false because there is no pane.
    expect(planTmuxMirrorTransition("%10", null, "me", "me")).toEqual({ clearOld: false, mirrorNew: false });
  });

  test("steady state, same pane → no clear, re-mirror (keep the stamp current)", () => {
    expect(planTmuxMirrorTransition("%10", "%10", "me", "me")).toEqual({ clearOld: false, mirrorNew: true });
  });

  test("first-ever resolve (no old pane) → no clear, mirror the new pane", () => {
    expect(planTmuxMirrorTransition(null, "%20", null, "me")).toEqual({ clearOld: false, mirrorNew: true });
  });

  test("null myId never clears (defensive)", () => {
    expect(planTmuxMirrorTransition("%10", "%20", null, null)).toEqual({ clearOld: false, mirrorNew: true });
  });
});

describe("visible tmux pane selectors", () => {
  test("normalizes visible colon and spoken-space pane addresses", () => {
    expect(normalizeTmuxTargetSelector("infra:1.2")).toBe("infra:1.2");
    expect(normalizeTmuxTargetSelector(" infra 1.2 ")).toBe("infra:1.2");
    expect(normalizeTmuxTargetSelector("pr_review:3.12")).toBe("pr_review:3.12");
  });

  test("rejects ambiguous or non-pane tmux targets", () => {
    expect(normalizeTmuxTargetSelector("infra")).toBeNull();
    expect(normalizeTmuxTargetSelector("infra.2")).toBeNull();
    expect(normalizeTmuxTargetSelector("infra:%64")).toBeNull();
    expect(normalizeTmuxTargetSelector("")).toBeNull();
  });

  test("send_to_peer tool exposes tmux_target as the human-visible selector", async () => {
    const source = await Bun.file(`${import.meta.dir}/../server.ts`).text();
    expect(source).toContain("tmux_target");
    expect(source).toContain("resolveTmuxTargetSelector(selector.tmux_target)");
    expect(source).toContain("tmux_session: resolved.tmux_session");
    expect(source).toContain("tmux_pane_id: resolved.tmux_pane_id");
  });

  test("tmux-only hint explains labeled panes that lack broker rows", () => {
    const panes = [
      "pr\t2\t1\t%207\tpr.2\tnode\t/home/manzo/Clause5",
      "Ops_a\t1\t1\t%121\tOps_a.1\tnode\t/home/manzo/Clause5",
    ].join("\n");
    const hint = tmuxOnlyPeerHintFromList({ name: "pr.2" }, panes);
    expect(hint).toContain("Tmux-only peer hint");
    expect(hint).toContain("pr:2.1 label=pr.2");
    expect(hint).not.toContain("cmd=");
    expect(hint).not.toContain("cwd=");
    expect(hint).toContain("no live broker peer row matched");
    expect(hint).toContain("closed MCP transport");
  });

  test("tmux-only hint can match a resolved stable pane id", () => {
    const panes = "pr\t2\t1\t%207\tpr.2\tnode\t/home/manzo/Clause5";
    const hint = tmuxOnlyPeerHintFromList({ tmux_session: "pr", tmux_pane_id: "%207" }, panes);
    expect(hint).toContain("pr:2.1 label=pr.2");
  });

  test("tmux-only hint matches a session-only selector", () => {
    const panes = [
      "pr\t1\t2\t%148\tpr.2\tbash\t/home/manzo/Clause5",
      "ops\t1\t1\t%121\tops.1\tnode\t/home/manzo/Clause5",
    ].join("\n");
    const hint = tmuxOnlyPeerHintFromList({ tmux_session: "pr" }, panes);
    expect(hint).toContain("pr:1.2 label=pr.2");
    expect(hint).not.toContain("ops:1.1");
  });

  test("tmux-only hint redacts control characters from operator labels", () => {
    const panes = "pr\t2\t1\t%207\tpr.2\u001b[31m injected\tnode\t/home/manzo/Clause5";
    const hint = tmuxOnlyPeerHintFromList({ name: "pr.2\u001b[31m injected" }, panes);
    expect(hint).toContain("label=pr.2 [31m injected");
    expect(hint).not.toContain("\u001b");
    expect(hint).not.toContain("cmd=");
    expect(hint).not.toContain("cwd=");
  });

  test("tmux-only hint matches name_like against operator labels", () => {
    const panes = [
      "pr\t2\t1\t%207\tpr.2\tnode\t/home/manzo/Clause5",
      "ops\t1\t1\t%121\tops.1\tnode\t/home/manzo/Clause5",
    ].join("\n");
    const hint = tmuxOnlyPeerHintFromList({ name_like: "pr.2" }, panes);
    expect(hint).toContain("pr:2.1 label=pr.2");
    expect(hint).not.toContain("ops:1.1");
  });
});

describe("#11 — resolvePeerName fallback chain", () => {
  const PID = 12345;

  test("env wins when present (highest priority)", () => {
    expect(resolvePeerName("custom-name", "tmux-fallback", false, PID)).toBe("custom-name");
  });

  test("tmux fallback wins when env is null", () => {
    expect(resolvePeerName(null, "session.2", false, PID)).toBe("session.2");
  });

  test("observer-${pid} fires when env AND tmux are both null (CLOSES THE GAP)", () => {
    expect(resolvePeerName(null, null, false, PID)).toBe("observer-12345");
  });

  test("env wins even when tmux is also present (env > tmux precedence)", () => {
    expect(resolvePeerName("env-name", "tmux.5", false, PID)).toBe("env-name");
  });
});

describe("Codex Desktop app-server identity guard", () => {
  test("detects app-server as Codex transport but not as a routable session pid", () => {
    const appServer: ProcessInfo = {
      pid: 100,
      ppid: 1,
      comm: "codex",
      args: "/home/user/.local/bin/codex app-server --listen unix://",
    };
    const table = new Map<number, ProcessInfo>([[100, appServer]]);

    expect(isClientProcess(appServer, "codex")).toBe(true);
    expect(isCodexAppServerProcess(appServer)).toBe(true);
    expect(findClientPidFromProcessChain(100, table, "codex")).toBeNull();
  });

  test("keeps interactive Codex processes routable", () => {
    const interactive: ProcessInfo = {
      pid: 200,
      ppid: 99,
      comm: "codex",
      args: "/home/user/.local/bin/codex",
    };
    const table = new Map<number, ProcessInfo>([[200, interactive]]);

    expect(isCodexAppServerProcess(interactive)).toBe(false);
    expect(findClientPidFromProcessChain(200, table, "codex")).toBe(200);
  });
});

describe("#11 — R6.1 Task-subagent suffix overlay (preserved from R6.1)", () => {
  const PID = 67890;

  test("env + no tmux + isTaskSubagent=true → name suffixed with .task.${pid}", () => {
    // Task subagents inherit operator parent's CLAUDE_PEER_NAME but lack tmux
    // ancestry. The .task suffix prevents find_peer({name: envName}) from
    // returning the subagent instead of the operator seat.
    expect(resolvePeerName("rag.2", null, true, PID)).toBe("rag.2.task.67890");
  });

  test("env + tmux + isTaskSubagent=true → NOT suffixed (R6.1 requires no-tmux)", () => {
    // Tmux ancestry indicates this is a real operator seat in tmux, not a
    // Task subagent. Despite isTaskSubagent returning true (false positive
    // from grandparent heuristic), tmux presence wins.
    expect(resolvePeerName("rag.2", "tmux.1", true, PID)).toBe("rag.2");
  });

  test("no env + no tmux + isTaskSubagent=true → observer-${pid} (no R6.1, no env to suffix)", () => {
    // R6.1 requires env to suffix; without env, peerName is observer-${pid}
    // which is already PID-unique. No further suffixing needed.
    expect(resolvePeerName(null, null, true, PID)).toBe("observer-67890");
  });

  test("no env + tmux + isTaskSubagent=true → tmux name (R6.1 requires env)", () => {
    expect(resolvePeerName(null, "tmux.3", true, PID)).toBe("tmux.3");
  });
});

describe("#11 — return type invariants", () => {
  test("never returns null (closes the type narrowing — peerName is always string)", () => {
    // Each fallback in the chain either succeeds or hands off; the final
    // observer-${pid} always succeeds because process.pid is always defined.
    const result = resolvePeerName(null, null, false, 1);
    expect(result).toBeTypeOf("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("observer-${pid} format is stable (regression sentinel for spec §1.5)", () => {
    // The spec §1.5 follow-up #2 specifies "observer-${PID}" literal format.
    // If this changes (e.g., to "obs-${pid}" or "claude-${pid}"), shell
    // wrappers + operator scripts that grep for "observer-" patterns break.
    expect(resolvePeerName(null, null, false, 99999)).toBe("observer-99999");
    expect(resolvePeerName(null, null, false, 1)).toBe("observer-1");
  });
});

// Operator-label regression (2026-05-15): operator-facing peer names must
// match the tmux top bar (`session.N`). `pane_id` remains stable metadata and
// the last fallback, but must not displace the human label used by find_peer().
describe("Operator-label fallback — human name first, pane_id metadata last", () => {
  test("server.ts resolves a human tmux operator label before pane_id fallback", async () => {
    const source = await Bun.file(`${import.meta.dir}/../server.ts`).text();

    const labelIdx = source.indexOf("const tmuxOperatorLabel =");
    expect(labelIdx).toBeGreaterThanOrEqual(0);
    const formulaSlice = source.slice(labelIdx, labelIdx + 360);

    expect(formulaSlice).toMatch(/resolveTmuxOperatorLabel\(tmuxInfo\)/);
    expect(formulaSlice).toMatch(/tmuxOperatorLabel\s*\?\?/);
    // pane_id remains only as the last fallback/metadata-derived address,
    // not as the first operator-facing name.
    expect(formulaSlice).toMatch(/\$\{tmuxInfo\.session\}\.\$\{tmuxInfo\.pane_id\}/);
  });

  test("falsy pane_id → null tmuxFallbackName → observer-${pid} (spec test case 3)", () => {
    // Integration scenario: when the env-hint path produces a tmuxInfo
    // with pane_id missing (composeTmuxFromEnv at shared/tmux.ts:108-119
    // — env exports SESSION but not CLAUDE_PEER_TMUX_PANE_ID), the formula
    // assignment in server.ts yields null because the truthy guard
    // `tmuxInfo && tmuxInfo.pane_id` is false. The resulting null then
    // cascades through resolvePeerName to the observer-${pid} fallback.
    //
    // This test exercises the resolvePeerName side of that cascade.
    // The formula side is covered by the source-grep sentinel above.
    expect(resolvePeerName(null, null, false, 7777)).toBe("observer-7777");
    // Same for env-hint paths that supplied SESSION-only — null cascades.
    expect(resolvePeerName(null, null, false, 1)).toBe("observer-1");
  });

  test("resolvePeerName still passes pane_id-shaped final fallback names through unchanged", () => {
    // pane_id names are allowed only as the final no-human-label fallback.
    // resolvePeerName must not strip, escape, or transform the % char there.
    expect(resolvePeerName(null, "claude_agents.%5", false, 12345)).toBe("claude_agents.%5");
    expect(resolvePeerName(null, "infra.%6", false, 12345)).toBe("infra.%6");
    expect(resolvePeerName(null, "session.%999", false, 12345)).toBe("session.%999");
  });

  test("operator labels accept session.N and reject pane-id names", () => {
    expect(isHumanOperatorLabel("infra.2", "infra")).toBe(true);
    expect(isHumanOperatorLabel("infra.2#4", "infra")).toBe(true);
    expect(isHumanOperatorLabel("infra.%24", "infra")).toBe(false);
    expect(isHumanOperatorLabel("marketing.2", "infra")).toBe(false);
  });

  test("operator-label allocation prefers pane_index when it is free", () => {
    expect(chooseOperatorLabel("infra", "2", ["infra.1", "infra.3"])).toBe("infra.2");
  });

  test("operator-label allocation falls back to the lowest free session.N", () => {
    expect(chooseOperatorLabel("infra", "2", ["infra.1", "infra.2", "infra.2#4"])).toBe("infra.3");
  });

  test("operator-label allocation ignores pane-id-shaped broker fallbacks as human seats", () => {
    expect(chooseOperatorLabel("infra", "2", ["infra.%19", "infra.%24"])).toBe("infra.2");
  });

  test("resolved-name suffix stripping is limited to broker numeric suffixes", () => {
    expect(stripResolvedNameSuffix("infra.2#4")).toBe("infra.2");
    expect(stripResolvedNameSuffix("custom#name")).toBe("custom#name");
  });

  test("broker identity mirror preserves operator label and writes peer metadata", async () => {
    const source = await Bun.file(`${import.meta.dir}/../shared/tmux-identity.ts`).text();

    expect(source).toContain("function publishBrokerIdentityToTmux");
    const helperStart = source.indexOf("function publishBrokerIdentityToTmux");
    const helperSlice = source.slice(helperStart, helperStart + 1600);

    expect(helperSlice).toContain('readPaneOption(paneTarget, "@operator_label")');
    expect(helperSlice).toContain("options.updateOperatorLabel || !existingOperatorLabel");
    expect(helperSlice).toContain('setOption("@peer_id", identity.id)');
    expect(helperSlice).toContain('setOption("@peer_label", displayLabel)');
    expect(helperSlice).toContain('setOption("@peer_resolved_name", identity.resolved_name ?? "")');
    expect(helperSlice).toContain('setOption("@peer_client_type", identity.client_type)');
    expect(helperSlice).toContain('setOption("@peer_receiver_mode", identity.receiver_mode)');
  });

  test("broker identity mirror only targets stable pane ids", async () => {
    const source = await Bun.file(`${import.meta.dir}/../shared/tmux-identity.ts`).text();
    const registrationStart = source.indexOf("function registrationTmuxPaneId");
    const registrationSlice = source.slice(registrationStart, registrationStart + 420);
    const helperStart = source.indexOf("function brokerIdentityPaneTarget");
    const helperSlice = source.slice(helperStart, helperStart + 360);

    expect(registrationSlice).toContain("tmuxInfo?.pane_id");
    expect(registrationSlice).toContain("env.TMUX_PANE");
    expect(helperSlice).toContain("return registrationTmuxPaneId(tmuxInfo, env)");
    expect(helperSlice).not.toContain("tmuxInfo.session}:${tmuxInfo.window_index");
  });

  function canCreateTmuxSession(): boolean {
    if (Bun.spawnSync(["tmux", "-V"], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) return false;
    const session = `claude-peers-probe-${process.pid}-${Date.now()}`;
    const created = Bun.spawnSync(["tmux", "new-session", "-d", "-s", session], { stdout: "ignore", stderr: "ignore" });
    if (created.exitCode !== 0) return false;
    Bun.spawnSync(["tmux", "kill-session", "-t", session], { stdout: "ignore", stderr: "ignore" });
    return true;
  }

  const tmuxAvailable = canCreateTmuxSession();

  (tmuxAvailable ? test : test.skip)("broker identity mirror writes tmux pane options without overwriting operator label", () => {

    const session = `claude-peers-test-${process.pid}-${Date.now()}`;
    const created = Bun.spawnSync(["tmux", "new-session", "-d", "-s", session], { stdout: "ignore", stderr: "ignore" });
    expect(created.exitCode).toBe(0);

    try {
      const paneIdResult = Bun.spawnSync(["tmux", "display-message", "-p", "-t", `${session}:0.0`, "#{pane_id}"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const paneId = new TextDecoder().decode(paneIdResult.stdout).trim();
      expect(paneId).toMatch(/^%/);

      Bun.spawnSync(["tmux", "set-option", "-p", "-t", paneId, "@operator_label", "human.7"], {
        stdout: "ignore",
        stderr: "ignore",
      });

      publishBrokerIdentityToTmux({
        id: "peer123",
        name: "broker.7",
        resolved_name: "broker.7#2",
        client_type: "codex",
        receiver_mode: "codex-hook",
      }, {
        session,
        window_index: "0",
        window_name: "0",
        pane_id: paneId,
      });

      const readOption = (name: string): string => {
        const result = Bun.spawnSync(["tmux", "show-options", "-p", "-t", paneId, "-v", name], {
          stdout: "pipe",
          stderr: "ignore",
        });
        return new TextDecoder().decode(result.stdout).trim();
      };

      expect(readOption("@operator_label")).toBe("human.7");
      expect(readOption("@peer_id")).toBe("peer123");
      expect(readOption("@peer_label")).toBe("broker.7");
      expect(readOption("@peer_resolved_name")).toBe("broker.7#2");
      expect(readOption("@peer_client_type")).toBe("codex");
      expect(readOption("@peer_receiver_mode")).toBe("codex-hook");

      publishBrokerIdentityToTmux({
        id: "peer456",
        name: "broker.8",
        resolved_name: "broker.8",
        client_type: "codex",
        receiver_mode: "manual-drain",
      }, {
        session,
        window_index: "0",
        window_name: "0",
        pane_id: paneId,
      }, { updateOperatorLabel: true });

      expect(readOption("@operator_label")).toBe("broker.8");
      expect(readOption("@peer_id")).toBe("peer456");
      expect(readOption("@peer_receiver_mode")).toBe("manual-drain");
    } finally {
      Bun.spawnSync(["tmux", "kill-session", "-t", session], { stdout: "ignore", stderr: "ignore" });
    }
  });

  test("registration, re-registration, and set_name publish through the same tmux mirror helper", async () => {
    const source = await Bun.file(`${import.meta.dir}/../server.ts`).text();
    const calls = source.match(/publishBrokerIdentityToTmux\(/g) ?? [];

    // Function definition plus initial register, auth-reset re-register, and set_name.
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(source).not.toContain("tmuxInfo && process.env.TMUX && tmuxInfo.window_index");
  });

  test("auth recovery rewrites only peer identity fields that match the old self id", () => {
    expect(rewriteAuthBodyForPeer("/list-peers", {
      id: "old-self",
      exclude_id: "old-self",
      scope: "machine",
    }, "old-self", "new-self")).toEqual({
      id: "new-self",
      exclude_id: "new-self",
      scope: "machine",
    });

    expect(rewriteAuthBodyForPeer("/send-message", {
      from_id: "old-self",
      to_id: "old-self",
      text: "self",
    }, "old-self", "new-self")).toEqual({
      from_id: "new-self",
      to_id: "new-self",
      text: "self",
    });

    expect(rewriteAuthBodyForPeer("/send-to-peer", {
      from_id: "old-self",
      selector: { id: "old-self", name: "self" },
      text: "self selector",
    }, "old-self", "new-self")).toEqual({
      from_id: "new-self",
      selector: { id: "new-self", name: "self" },
      text: "self selector",
    });

    expect(rewriteAuthBodyForPeer("/messages-since-id", {
      id: 42,
      since: 10,
    }, "old-self", "new-self")).toEqual({
      id: 42,
      since: 10,
    });
  });

  test("broker auth recovery retries with the attempted peer id rewritten to the fresh id", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ token: string | null; body: Record<string, unknown> }> = [];
    __testSetBrokerAuthStateForTest({
      id: "old-self",
      token: "old-token",
      shuttingDown: false,
      reregisterPeer: async () => {
        __testSetBrokerAuthStateForTest({
          id: "new-self",
          token: "new-token",
          resetInFlight: false,
        });
      },
    });

    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({
        token: headers?.["X-Peer-Token"] ?? null,
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      if (calls.length === 1) return new Response("stale token", { status: 401 });
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      await __testBrokerFetchForTest("/send-to-peer", {
        from_id: "old-self",
        selector: { id: "old-self" },
        to_id: "old-self",
        text: "self",
      });
    } finally {
      globalThis.fetch = originalFetch;
      __testSetBrokerAuthStateForTest({ id: null, token: null, shuttingDown: false });
    }

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      token: "old-token",
      body: {
        from_id: "old-self",
        selector: { id: "old-self" },
        to_id: "old-self",
        text: "self",
      },
    });
    expect(calls[1]).toEqual({
      token: "new-token",
      body: {
        from_id: "new-self",
        selector: { id: "new-self" },
        to_id: "new-self",
        text: "self",
      },
    });
  });

  test("background polling policy follows hook-capable receiver metadata", () => {
    expect(shouldDisableBackgroundPolling("codex", "manual-drain")).toBe(true);
    expect(shouldDisableBackgroundPolling("gemini", "manual-drain")).toBe(true);
    expect(shouldDisableBackgroundPolling("unknown", "codex-hook")).toBe(true);
    expect(shouldDisableBackgroundPolling("claude", "claude-channel")).toBe(false);
    expect(shouldDisableBackgroundPolling("unknown", "manual-drain")).toBe(false);
  });

  test("repo-scope peer lists warn against first-row routing", () => {
    expect(listPeersRoutingHint("repo", 17, false)).toContain("Do not message the first row");
    expect(listPeersRoutingHint("repo", 17, false)).toContain("has_tmux=true");
    expect(listPeersRoutingHint("repo", 17, true)).not.toContain("has_tmux=true");
    expect(listPeersRoutingHint("repo", 1, false)).toBe("");
    expect(listPeersRoutingHint("machine", 17, false)).toBe("");
  });
});
