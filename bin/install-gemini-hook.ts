#!/usr/bin/env bun
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const repo = resolve(process.argv[2] ?? process.cwd());
const settingsPath = `${repo}/.gemini/settings.json`;
const drainHookScript = resolve(import.meta.dir, "../hooks/gemini-drain-peer-inbox.sh");
const registerHookScript = resolve(import.meta.dir, "../hooks/gemini-register-peer-session.sh");
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const drainCommand = `/usr/bin/env bash ${shellQuote(drainHookScript)}`;
const registerCommand = `/usr/bin/env bash ${shellQuote(registerHookScript)}`;
const drainEntry = {
  name: "claude-peers-gemini-inbox",
  type: "command",
  command: drainCommand,
  timeout: 10000,
  description: "Drain pending claude-peers messages before each Gemini agent turn.",
};
const registerEntry = {
  name: "claude-peers-gemini-register",
  type: "command",
  command: registerCommand,
  timeout: 10000,
  description: "Register this Gemini session with claude-peers at session start.",
};

type SettingsFile = {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<Record<string, unknown>>; [key: string]: unknown }>>;
  [key: string]: unknown;
};

function readExisting(): SettingsFile {
  if (!existsSync(settingsPath)) return {};
  return JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
}

const doc = readExisting();
doc.hooks ??= {};

function upsertHook(
  eventName: string,
  entry: Record<string, unknown>,
  predicate: (hook: Record<string, unknown>) => boolean,
  bucketDefaults: Record<string, unknown> = {},
): void {
  doc.hooks![eventName] ??= [];
  let replaced = false;
  for (const bucket of doc.hooks![eventName]!) {
    if (!Array.isArray(bucket.hooks)) continue;
    const nextHooks: Array<Record<string, unknown>> = [];
    for (const hook of bucket.hooks) {
      if (predicate(hook)) {
        if (!replaced) {
          Object.assign(bucket, bucketDefaults);
          nextHooks.push(entry);
          replaced = true;
        }
        continue;
      }
      nextHooks.push(hook);
    }
    bucket.hooks = nextHooks;
  }

  if (!replaced) {
    let bucket = doc.hooks![eventName]!.find((item) =>
      item.matcher === (bucketDefaults.matcher ?? "*") && Array.isArray(item.hooks)
    );
    if (!bucket) {
      bucket = { ...bucketDefaults, hooks: [] };
      doc.hooks![eventName]!.push(bucket);
    }
    bucket.hooks ??= [];
    bucket.hooks.push(entry);
  }
}

upsertHook(
  "SessionStart",
  registerEntry,
  (hook) => hook.name === registerEntry.name || hook.command === registerCommand ||
    (typeof hook.command === "string" && hook.command.includes("gemini-register-peer-session.sh")),
  { matcher: "startup|resume" },
);

upsertHook(
  "BeforeAgent",
  drainEntry,
  (hook) => hook.name === drainEntry.name || hook.command === drainCommand ||
    (typeof hook.command === "string" && hook.command.includes("gemini-drain-peer-inbox.sh")),
  { matcher: "*" },
);

mkdirSync(dirname(settingsPath), { recursive: true });
if (existsSync(settingsPath)) {
  const backup = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  writeFileSync(backup, readFileSync(settingsPath));
  console.log(`backup: ${backup}`);
}
const tmp = `${settingsPath}.tmp`;
writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
renameSync(tmp, settingsPath);
console.log(`installed Gemini peer hooks: ${settingsPath}`);
