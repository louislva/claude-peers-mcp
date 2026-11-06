import { describe, expect, test } from "bun:test";
import { mayRing, shouldReportCrash } from "./lifecycle.ts";

const alive = (pid: number) => pid === 100 || pid === 200;

describe("a loop may ring only while its supervisor owns the switchboard", () => {
  test("its live supervisor holds the lock: ring", () => {
    expect(mayRing({ supervisorPid: 100, lockPid: 100, isAlive: alive })).toBe(true);
  });
  test("its supervisor is gone: never ring as an orphan", () => {
    expect(mayRing({ supervisorPid: 999, lockPid: 999, isAlive: alive })).toBe(false);
  });
  test("a newer supervisor took the lock: step aside even though ours lives", () => {
    expect(mayRing({ supervisorPid: 100, lockPid: 200, isAlive: alive })).toBe(false);
  });
  test("no lock on record: not ours to run", () => {
    expect(mayRing({ supervisorPid: 100, lockPid: null, isAlive: alive })).toBe(false);
  });
  test("run by hand without a supervisor (--once, manual): allowed", () => {
    expect(mayRing({ supervisorPid: 0, lockPid: null, isAlive: alive })).toBe(true);
  });
});

describe("crash reports: once per streak, never a push per minute", () => {
  test("first two crashes are silent, the third reports, later ones stay silent", () => {
    expect([1, 2, 3, 4, 5, 50].map(shouldReportCrash)).toEqual([false, false, true, false, false, false]);
  });
});
