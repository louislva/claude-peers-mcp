#!/usr/bin/env bun
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const repo = resolve(process.argv[2] ?? process.cwd());
const hooksPath = `${repo}/.codex/hooks.json`;
const drainHookScript = resolve(import.meta.dir, "../hooks/codex-drain-peer-inbox.sh");
const registerHookScript = resolve(import.meta.dir, "../hooks/codex-register-peer-session.sh");
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const drainCommand = `/usr/bin/env bash ${shellQuote(drainHookScript)}`;
const registerCommand = `/usr/bin/env bash ${shellQuote(registerHookScript)}`;
const drainName = "claude-peers-codex-inbox";
const registerName = "claude-peers-codex-register";
const sessionDrainName = "claude-peers-codex-session-drain";
const stopDrainName = "claude-peers-codex-stop-drain";
const sessionDrainCommand = `CLAUDE_PEERS_HOOK_EVENT_NAME=SessionStart ${drainCommand}`;
const stopDrainCommand = `CLAUDE_PEERS_HOOK_EVENT_NAME=Stop ${drainCommand}`;
const drainEntry = {
  name: drainName,
  type: "command",
  command: drainCommand,
  timeout: 10,
  statusMessage: "Checking peer inbox",
};
const registerEntry = {
  name: registerName,
  type: "command",
  command: registerCommand,
  timeout: 10,
  statusMessage: "Registering peer session",
};
// Session-start drain kills the "nudge at startup" gap: queued mail surfaces
// as additionalContext the moment the session opens. Longer timeout because
// the hook retries claim while the register hook / MCP server race it.
const sessionDrainEntry = {
  name: sessionDrainName,
  type: "command",
  command: sessionDrainCommand,
  timeout: 15,
  statusMessage: "Draining peer inbox at session start",
};
// Turn-end drain: Codex has no async/asyncRewake (parsed but skipped per the
// official docs), so a synchronous Stop hook that blocks-with-reason is the
// only turn-end delivery path. stop_hook_active is honored inside the hook.
const stopDrainEntry = {
  name: stopDrainName,
  type: "command",
  command: stopDrainCommand,
  timeout: 10,
  statusMessage: "Checking peer inbox before stop",
};

type HookFile = {
  hooks?: Record<string, Array<{ hooks?: Array<Record<string, unknown>>; [key: string]: unknown }>>;
};

function isPeerInboxHook(hook: Record<string, unknown>): boolean {
  return hook.name === drainName || hook.command === drainCommand ||
    (typeof hook.command === "string" &&
      (hook.command.includes("codex-drain-peer-inbox.sh") || hook.command.includes("codex-drain-peer-inbox-safe.sh")));
}

function isPeerSessionDrainHook(hook: Record<string, unknown>): boolean {
  return hook.name === sessionDrainName || hook.command === sessionDrainCommand ||
    (typeof hook.command === "string" &&
      hook.command.includes("codex-drain-peer-inbox.sh") &&
      hook.command.includes("CLAUDE_PEERS_HOOK_EVENT_NAME=SessionStart"));
}

function isPeerStopDrainHook(hook: Record<string, unknown>): boolean {
  return hook.name === stopDrainName || hook.command === stopDrainCommand ||
    (typeof hook.command === "string" &&
      hook.command.includes("codex-drain-peer-inbox.sh") &&
      hook.command.includes("CLAUDE_PEERS_HOOK_EVENT_NAME=Stop"));
}

function isPeerRegisterHook(hook: Record<string, unknown>): boolean {
  return hook.name === registerName || hook.command === registerCommand ||
    (typeof hook.command === "string" && hook.command.includes("codex-register-peer-session.sh"));
}

function readExisting(): HookFile {
  if (!existsSync(hooksPath)) return { hooks: {} };
  return JSON.parse(readFileSync(hooksPath, "utf8")) as HookFile;
}

const doc = readExisting();
doc.hooks ??= {};

function upsertHook(
  eventName: string,
  entry: Record<string, unknown>,
  predicate: (hook: Record<string, unknown>) => boolean,
  bucketDefaults: Record<string, unknown> = {},
  // Which bucket the entry should live in. Defaults to "wherever a matching
  // entry already exists"; pass a broader predicate to co-locate related
  // hooks (e.g. session drain rides in the register bucket).
  bucketPredicate: (hook: Record<string, unknown>) => boolean = predicate,
): void {
  doc.hooks![eventName] ??= [];
  let bucket = doc.hooks![eventName]!.find((item) => Array.isArray(item.hooks) && item.hooks.some(bucketPredicate));
  if (!bucket) {
    bucket = { ...bucketDefaults, hooks: [] };
    doc.hooks![eventName]!.push(bucket);
  } else {
    Object.assign(bucket, bucketDefaults);
  }
  let replaced = false;
  for (const item of doc.hooks![eventName]!) {
    if (!Array.isArray(item.hooks)) continue;
    item.hooks = item.hooks.flatMap((hook) => {
      if (!predicate(hook)) return [hook];
      if (item === bucket && !replaced) {
        replaced = true;
        return [entry];
      }
      return [];
    });
  }
  if (!replaced) {
    bucket.hooks ??= [];
    bucket.hooks.push(entry);
  }
}

upsertHook("SessionStart", registerEntry, isPeerRegisterHook, { matcher: "startup|resume" });
upsertHook(
  "SessionStart",
  sessionDrainEntry,
  isPeerSessionDrainHook,
  { matcher: "startup|resume" },
  (hook) => isPeerSessionDrainHook(hook) || isPeerRegisterHook(hook),
);
upsertHook("UserPromptSubmit", drainEntry, isPeerInboxHook);
upsertHook("Stop", stopDrainEntry, isPeerStopDrainHook);

mkdirSync(dirname(hooksPath), { recursive: true });
if (existsSync(hooksPath)) {
  const backup = `${hooksPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  writeFileSync(backup, readFileSync(hooksPath));
  console.log(`backup: ${backup}`);
}
const tmp = `${hooksPath}.tmp`;
writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
renameSync(tmp, hooksPath);
console.log(`installed Codex peer hooks: ${hooksPath}`);
