#!/usr/bin/env bun
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const repo = resolve(process.argv[2] ?? process.cwd());
const hooksPath = `${repo}/.codex/hooks.json`;
const hookScript = resolve(import.meta.dir, "../hooks/codex-drain-peer-inbox.sh");
const command = `/usr/bin/env bash ${hookScript}`;
const entry = {
  type: "command",
  command,
  timeout: 5,
  statusMessage: "Checking peer inbox",
};

type HookFile = {
  hooks?: Record<string, Array<{ hooks?: Array<Record<string, unknown>>; [key: string]: unknown }>>;
};

function readExisting(): HookFile {
  if (!existsSync(hooksPath)) return { hooks: {} };
  return JSON.parse(readFileSync(hooksPath, "utf8")) as HookFile;
}

const doc = readExisting();
doc.hooks ??= {};
doc.hooks.UserPromptSubmit ??= [];
let bucket = doc.hooks.UserPromptSubmit.find((item) => Array.isArray(item.hooks) && item.hooks.some((h) => h.command === command));
if (!bucket) {
  bucket = { hooks: [] };
  doc.hooks.UserPromptSubmit.push(bucket);
}
bucket.hooks ??= [];
if (!bucket.hooks.some((h) => h.command === command)) {
  bucket.hooks.push(entry);
}

mkdirSync(dirname(hooksPath), { recursive: true });
if (existsSync(hooksPath)) {
  const backup = `${hooksPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  writeFileSync(backup, readFileSync(hooksPath));
  console.log(`backup: ${backup}`);
}
const tmp = `${hooksPath}.tmp`;
writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
renameSync(tmp, hooksPath);
console.log(`installed Codex peer inbox hook: ${hooksPath}`);
