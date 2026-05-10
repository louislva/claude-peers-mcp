import { test, expect } from "bun:test";
import type { ClientMeta } from "../shared/types.ts";
import { computeGroupId, computeGroupSecretHash, resolveGroup } from "../shared/config.ts";

/**
 * The full server.ts handshake reader is exercised end-to-end via the live
 * smoke tests in broker-websocket.test.ts (which require a running broker).
 *
 * Here we cover the *contract* of the handshake payload that client.ts
 * produces and server.ts consumes:
 *   - it round-trips through JSON.parse
 *   - the group_id matches sha256(secret).slice(0,32)
 *   - the secret never leaks into the payload
 *   - the absence of a secret yields the 'default' sentinel
 */

function buildHandshakePayload(opts: {
  cwd: string;
  git_root: string | null;
  groups: Record<string, string>;
  default_group: string | null;
}) {
  const { name, group_id, group_secret_hash, groups_map } = resolveGroup(
    opts.cwd,
    opts.git_root,
    { groups: opts.groups, default_group: opts.default_group }
  );
  const meta: ClientMeta = {
    host: "test-host",
    client_pid: 1234,
    cwd: opts.cwd,
    git_root: opts.git_root,
    git_branch: null,
    recent_files: [],
    project_key: null,
    tty: null,
    group_id,
    group_secret_hash,
    groups_map,
  };
  return { line: JSON.stringify({ client_meta: meta }) + "\n", name, meta };
}

test("handshake JSON parses round-trip with all required fields", () => {
  const { line, meta } = buildHandshakePayload({
    cwd: "/tmp/anywhere",
    git_root: null,
    groups: { perso: "secret-perso" },
    default_group: "perso",
  });
  const parsed = JSON.parse(line.trim()) as { client_meta: ClientMeta };
  expect(parsed.client_meta.group_id).toBe(meta.group_id);
  expect(parsed.client_meta.group_secret_hash).toBe(meta.group_secret_hash);
  expect(parsed.client_meta.groups_map).toEqual(meta.groups_map);
  expect(parsed.client_meta.host).toBe("test-host");
});

test("handshake group_id equals sha256(secret).slice(0,32)", () => {
  const { meta } = buildHandshakePayload({
    cwd: "/tmp/x",
    git_root: null,
    groups: { perso: "abc-secret" },
    default_group: "perso",
  });
  expect(meta.group_id).toBe(computeGroupId("abc-secret"));
  expect(meta.group_secret_hash).toBe(computeGroupSecretHash("abc-secret"));
});

test("handshake without a configured secret yields 'default' and null hash", () => {
  const { meta } = buildHandshakePayload({
    cwd: "/tmp/x",
    git_root: null,
    groups: {},
    default_group: null,
  });
  expect(meta.group_id).toBe("default");
  expect(meta.group_secret_hash).toBeNull();
});

test("handshake never embeds the raw secret value", () => {
  const secret = "ULTRA-SECRET-9k3lq";
  const { line } = buildHandshakePayload({
    cwd: "/tmp/x",
    git_root: null,
    groups: { sec: secret },
    default_group: "sec",
  });
  expect(line).not.toContain(secret);
});
