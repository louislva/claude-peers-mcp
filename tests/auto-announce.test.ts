import { test, expect } from "bun:test";
import type { Peer } from "../shared/types.ts";
import { findCoordinators, buildAnnounceMessage } from "../server.ts";

test("findCoordinators returns peers with coordinator role", () => {
  const peers: Peer[] = [
    {
      id: "coord1", pid: 100, cwd: "/project", git_root: "/project",
      tty: null, summary: "Koordinatör", role: "koordinator",
      registered_at: new Date().toISOString(), last_seen: new Date().toISOString(),
    },
    {
      id: "worker1", pid: 200, cwd: "/project", git_root: "/project",
      tty: null, summary: "Frontend dev", role: "frontend-dev",
      registered_at: new Date().toISOString(), last_seen: new Date().toISOString(),
    },
  ];

  const coordinators = findCoordinators(peers);
  expect(coordinators).toHaveLength(1);
  expect(coordinators[0].id).toBe("coord1");
});

test("findCoordinators matches coordinator and koordinator roles", () => {
  const peers: Peer[] = [
    { id: "c1", pid: 100, cwd: "/p", git_root: "/p", tty: null, summary: "", role: "coordinator", registered_at: "", last_seen: "" },
    { id: "c2", pid: 101, cwd: "/p", git_root: "/p", tty: null, summary: "", role: "koordinator", registered_at: "", last_seen: "" },
    { id: "w1", pid: 200, cwd: "/p", git_root: "/p", tty: null, summary: "", role: "backend-dev", registered_at: "", last_seen: "" },
  ];

  const coordinators = findCoordinators(peers);
  expect(coordinators).toHaveLength(2);
});

test("findCoordinators returns empty when no coordinator exists", () => {
  const peers: Peer[] = [
    { id: "w1", pid: 200, cwd: "/p", git_root: "/p", tty: null, summary: "", role: "frontend-dev", registered_at: "", last_seen: "" },
  ];

  const coordinators = findCoordinators(peers);
  expect(coordinators).toHaveLength(0);
});

test("buildAnnounceMessage includes role and cwd", () => {
  const msg = buildAnnounceMessage("frontend-dev", "/Users/me/project-x");
  expect(msg).toContain("frontend-dev");
  expect(msg).toContain("/Users/me/project-x");
  expect(msg).toContain("online");
});

test("buildAnnounceMessage with empty role", () => {
  const msg = buildAnnounceMessage("", "/Users/me/project-x");
  expect(msg).toContain("/Users/me/project-x");
  expect(msg).toContain("online");
  expect(msg).not.toContain("Rol:");
});
