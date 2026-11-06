import { describe, expect, test } from "bun:test";
import { assessHealth } from "./health.ts";

const NOW = 1_000_000_000_000;
const MIN = 60_000;
const healthyBroker = { status: "ok", wake: true };

describe("operator heartbeat health check", () => {
  test("a fresh stamp between passes and a healthy broker is OK", () => {
    expect(assessHealth({ now: NOW, broker: healthyBroker, aliveAt: NOW - 3_000, passStartedAt: null })).toEqual([]);
  });

  test("a long pass that keeps stamping is busy, not down (Codex dispatch can take 60s per recipient)", () => {
    expect(assessHealth({ now: NOW, broker: healthyBroker, aliveAt: NOW - 4_000, passStartedAt: NOW - 4 * MIN })).toEqual([]);
  });

  test("no stamp on record means the watcher is down", () => {
    expect(assessHealth({ now: NOW, broker: healthyBroker, aliveAt: null, passStartedAt: null }))
      .toEqual(["WATCHER-DOWN no watcher pass on record; re-arm Monitor now"]);
  });

  test("a stamp older than a minute means the watcher is down, with its age", () => {
    expect(assessHealth({ now: NOW, broker: healthyBroker, aliveAt: NOW - 34 * MIN, passStartedAt: null }))
      .toEqual(["WATCHER-DOWN last pass 34 min ago; re-arm Monitor now"]);
  });

  test("a live loop stuck in one pass for 15+ min is reported, not re-armed", () => {
    expect(assessHealth({ now: NOW, broker: healthyBroker, aliveAt: NOW - 2_000, passStartedAt: NOW - 16 * MIN }))
      .toEqual(["WATCHER-STUCK one pass has run 16 min; push Kiel"]);
  });

  test("a fresh stamp from a loop whose supervisor no longer owns the switchboard is not health", () => {
    expect(assessHealth({ now: NOW, broker: healthyBroker, aliveAt: NOW - 1_000, passStartedAt: null, stampOwner: 100, lockOwner: 200, ownerAlive: true }))
      .toEqual(["WATCHER-DOWN liveness stamp is from supervisor 100, not the owner 200; re-arm Monitor now"]);
  });

  test("the owning supervisor is gone: down, however fresh the stamp", () => {
    expect(assessHealth({ now: NOW, broker: healthyBroker, aliveAt: NOW - 1_000, passStartedAt: null, stampOwner: 200, lockOwner: 200, ownerAlive: false }))
      .toEqual(["WATCHER-DOWN owning supervisor 200 is not running; re-arm Monitor now"]);
  });

  test("an unreachable broker is reported, and so is the watcher it starves", () => {
    expect(assessHealth({ now: NOW, broker: null, aliveAt: NOW - 5 * MIN, passStartedAt: null })).toEqual([
      "BROKER-DOWN broker not answering on /health; push Kiel",
      "WATCHER-DOWN last pass 5 min ago; re-arm Monitor now",
    ]);
  });

  test("a broker without wake support is reported", () => {
    expect(assessHealth({ now: NOW, broker: { status: "ok", wake: false }, aliveAt: NOW, passStartedAt: null }))
      .toEqual(["BROKER-DOWN broker is running without wake support; push Kiel"]);
  });
});
