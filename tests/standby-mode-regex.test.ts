/**
 * Unit tests for the standby watcher's auto-mode regex.
 *
 * The regex is load-bearing: a false positive triggers AUTONOMOUS wake
 * (Claude proceeds without asking), a false negative forces ASK-FIRST.
 * Errors here are safety-relevant — autonomous execution of peer
 * instructions without user confirmation is the dangerous failure mode.
 *
 * We extract the regex from claude-peers-standby-watcher.sh and re-run it
 * against a table of realistic summaries via a bash subprocess.
 */
import { describe, test, expect } from "bun:test";

// Mirror the auto-mode pattern from the shell script EXACTLY. If the shell
// script's pattern changes, this test must be updated in lockstep.
const STANDBY_PHRASE = "(standby|stand[[:space:]]+by|standing[[:space:]]+by|awaiting|waiting[[:space:]]+for|ready[[:space:]]+for|holding[[:space:]]+for|listening[[:space:]]+for)";
const AUTO_MODE_BASH = `
  if [[ "\$1" =~ ${STANDBY_PHRASE}[[:space:]]+auto[[:space:]] ]] \\
    || [[ "\$1" =~ (^|[[:space:]])auto[[:space:]]+${STANDBY_PHRASE} ]]; then
    echo auto
  else
    echo ask
  fi
`;

async function modeFor(summary: string): Promise<string> {
  // Append a trailing space so the "[[:space:]]" boundary matches at end.
  const lc = (summary + " ").toLowerCase();
  const proc = Bun.spawn(["bash", "-c", AUTO_MODE_BASH, "_", lc], {
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

describe("standby watcher — auto-mode regex", () => {
  test("'standby auto' → auto", async () => {
    expect(await modeFor("standby auto — reply ack")).toBe("auto");
  });

  test("'auto standby' → auto (reverse order)", async () => {
    expect(await modeFor("auto standby for phase 3")).toBe("auto");
  });

  test("'standby' alone (no auto) → ask", async () => {
    expect(await modeFor("standby — waiting for handoff")).toBe("ask");
  });

  test("'awaiting auto X' → auto (auto adjacent to waiting phrase)", async () => {
    expect(await modeFor("awaiting auto approval from executor")).toBe("auto");
  });

  test("'waiting for auto-merge' → ask (hyphenated, not adjacent token)", async () => {
    expect(await modeFor("waiting for auto-merge CI run")).toBe("ask");
  });

  test("'automation standby' → ask (auto is a substring, not token)", async () => {
    expect(await modeFor("automation standby mode")).toBe("ask");
  });

  test("'standby auto-detect' → ask (auto-detect is not 'auto' token)", async () => {
    expect(await modeFor("standby auto-detect verification")).toBe("ask");
  });

  test("'autonomous standby' → ask (autonomous is not 'auto' token)", async () => {
    expect(await modeFor("autonomous standby daemon")).toBe("ask");
  });

  test("empty summary → ask", async () => {
    expect(await modeFor("")).toBe("ask");
  });

  test("'editing CLAUDE.md' (typical work summary) → ask", async () => {
    expect(await modeFor("[tmux rag:claude] Clause5 — editing CLAUDE.md +9")).toBe("ask");
  });

  test("'standby-auto' (dash-joined, not token-separated) → ask", async () => {
    // Dashes are NOT [[:space:]] in bash regex — so 'standby-auto' has
    // no whitespace between tokens and does NOT match.
    expect(await modeFor("standby-auto mode")).toBe("ask");
  });

  test("'Standing By Auto' → auto (case-insensitive)", async () => {
    expect(await modeFor("Standing By Auto — launch pad green")).toBe("auto");
  });
});
