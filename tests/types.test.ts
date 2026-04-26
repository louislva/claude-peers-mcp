import { test, expect } from "bun:test";
import type { Peer, RegisterRequest } from "../shared/types.ts";

test("Peer interface accepts role field", () => {
  const peer: Peer = {
    id: "abc12345",
    pid: 1234,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "Test peer",
    role: "frontend-dev",
    registered_at: new Date().toISOString(),
    last_seen: new Date().toISOString(),
  };
  expect(peer.role).toBe("frontend-dev");
});

test("Peer interface accepts empty role", () => {
  const peer: Peer = {
    id: "abc12345",
    pid: 1234,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "",
    role: "",
    registered_at: new Date().toISOString(),
    last_seen: new Date().toISOString(),
  };
  expect(peer.role).toBe("");
});

test("RegisterRequest includes role field", () => {
  const req: RegisterRequest = {
    pid: 1234,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "",
    role: "backend-dev",
  };
  expect(req.role).toBe("backend-dev");
});
