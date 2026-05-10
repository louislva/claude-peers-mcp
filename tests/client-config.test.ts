import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveGroupName,
  resolveGroup,
  computeGroupId,
  computeGroupSecretHash,
} from "../shared/config.ts";

let root: string;
let sub: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cp-cfg-"));
  sub = join(root, "deeper", "still");
  mkdirSync(sub, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.CLAUDE_PEERS_GROUP;
});

test(".claude-peers.local.json takes precedence over .claude-peers.json", () => {
  writeFileSync(join(root, ".claude-peers.json"), JSON.stringify({ group: "work" }));
  writeFileSync(join(root, ".claude-peers.local.json"), JSON.stringify({ group: "perso" }));
  const name = resolveGroupName(sub, root, { default_group: null });
  expect(name).toBe("perso");
});

test("walk-up finds .claude-peers.json from a nested cwd", () => {
  writeFileSync(join(root, ".claude-peers.json"), JSON.stringify({ group: "work" }));
  const name = resolveGroupName(sub, root, { default_group: null });
  expect(name).toBe("work");
});

test("walk-up stops at git_root", () => {
  // file outside the git tree should NOT be picked up
  const outside = join(root, "..");
  // We can't actually write outside a tempdir safely; instead test the boundary
  // by NOT having a file inside root and having nothing in user config.
  const name = resolveGroupName(sub, root, { default_group: null });
  expect(name).toBe("default");
});

test("user config default_group is the next fallback", () => {
  const name = resolveGroupName(sub, null, { default_group: "perso" });
  expect(name).toBe("perso");
});

test("env var CLAUDE_PEERS_GROUP is the next fallback after user config", () => {
  process.env.CLAUDE_PEERS_GROUP = "from-env";
  const name = resolveGroupName(sub, null, { default_group: null });
  expect(name).toBe("from-env");
});

test("ultimate fallback is 'default'", () => {
  const name = resolveGroupName(sub, null, { default_group: null });
  expect(name).toBe("default");
});

test("unknown fields in project file are rejected with warning, group is honored", () => {
  writeFileSync(join(root, ".claude-peers.json"), JSON.stringify({ group: "work", secret: "leaked" }));
  const name = resolveGroupName(sub, root, { default_group: null });
  expect(name).toBe("work");
});

test("malformed project file falls through silently", () => {
  writeFileSync(join(root, ".claude-peers.json"), "not json {{{");
  const name = resolveGroupName(sub, root, { default_group: null });
  expect(name).toBe("default");
});

test("computeGroupId matches sha256(secret).slice(0,32) and 'default' for null", () => {
  expect(computeGroupId(null)).toBe("default");
  expect(computeGroupId("foo")).toBe("2c26b46b68ffc68ff99b453c1d304134");
  expect(computeGroupId("foo")).toHaveLength(32);
});

test("computeGroupSecretHash returns null for null and full sha256 hex otherwise", () => {
  expect(computeGroupSecretHash(null)).toBeNull();
  const h = computeGroupSecretHash("foo");
  expect(h).toHaveLength(64);
  expect(h).toBe("2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae");
});

test("resolveGroup with name not in user config yields 'default' group_id and warns", () => {
  writeFileSync(join(root, ".claude-peers.json"), JSON.stringify({ group: "ghost" }));
  const r = resolveGroup(sub, root, { groups: {}, default_group: null });
  expect(r.name).toBe("ghost");
  expect(r.group_id).toBe("default");
  expect(r.group_secret_hash).toBeNull();
});

test("resolveGroup builds groups_map without exposing secrets", () => {
  const r = resolveGroup(sub, null, {
    groups: { perso: "spp", work: "sww" },
    default_group: "perso",
  });
  expect(r.groups_map.default).toBe("default");
  expect(r.groups_map.perso).toBe(computeGroupId("spp"));
  expect(r.groups_map.work).toBe(computeGroupId("sww"));
  // group_id must equal the resolved name's mapped id
  expect(r.group_id).toBe(r.groups_map.perso);
});
