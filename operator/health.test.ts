import { describe, expect, test } from "bun:test";
import { assessHealth } from "./health.ts";

const NOW = 1_000_000_000_000;
const healthyBroker = { status: "ok", wake: true };

describe("operator heartbeat health check", () => {
  test("a fresh watcher pass and a healthy broker is OK", () => {
    expect(assessHealth({ now: NOW, broker: healthyBroker, lastPassAt: NOW - 3_000 })).toEqual([]);
  });

  test("no watcher pass on record means the watcher is down", () => {
    expect(assessHealth({ now: NOW, broker: healthyBroker, lastPassAt: null }))
      .toEqual(["WATCHER-DOWN no watcher pass on record; re-arm Monitor now"]);
  });

  test("a watcher silent for more than a minute is down, with its age", () => {
    expect(assessHealth({ now: NOW, broker: healthyBroker, lastPassAt: NOW - 34 * 60_000 }))
      .toEqual(["WATCHER-DOWN last pass 34 min ago; re-arm Monitor now"]);
  });

  test("an unreachable broker is reported, and so is the watcher it starves", () => {
    expect(assessHealth({ now: NOW, broker: null, lastPassAt: NOW - 5 * 60_000 })).toEqual([
      "BROKER-DOWN broker not answering on /health; push Kiel",
      "WATCHER-DOWN last pass 5 min ago; re-arm Monitor now",
    ]);
  });

  test("a broker without wake support is reported", () => {
    expect(assessHealth({ now: NOW, broker: { status: "ok", wake: false }, lastPassAt: NOW }))
      .toEqual(["BROKER-DOWN broker is running without wake support; push Kiel"]);
  });
});
