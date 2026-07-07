import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  BrokerHttpError,
  isMissingClaimEndpointError,
  isMissingPeerClaimError,
  retryClaimAfterSelfRegistration,
  shouldSelfRegisterAfterClaimError,
  waitForRegistrationProcess,
} from "../hooks/codex-drain-peer-inbox.ts";

describe("Codex/Gemini drain hook claim error routing", () => {
  test("missing peer rows are eligible for bounded self-registration", () => {
    const msg = "/claim-by-pid 404: peer not found";
    expect(isMissingPeerClaimError(msg)).toBe(true);
    expect(isMissingClaimEndpointError(msg)).toBe(false);
    expect(shouldSelfRegisterAfterClaimError(msg)).toBe(true);

    const structured = new BrokerHttpError("/claim-by-pid", 404, "peer not found");
    expect(isMissingPeerClaimError(structured)).toBe(true);
    expect(isMissingClaimEndpointError(structured)).toBe(false);
    expect(shouldSelfRegisterAfterClaimError(structured)).toBe(true);
  });

  test("missing claim endpoint is treated as a stale broker, not a peer row miss", () => {
    const msg = "/claim-by-pid 404: Not Found";
    expect(isMissingClaimEndpointError(msg)).toBe(true);
    expect(shouldSelfRegisterAfterClaimError(msg)).toBe(false);

    const structured = new BrokerHttpError("/claim-by-pid", 404, "Not Found");
    expect(isMissingClaimEndpointError(structured)).toBe(true);
    expect(shouldSelfRegisterAfterClaimError(structured)).toBe(false);
  });

  test("generic transport failures do not trigger self-registration loops", () => {
    const msg = "/claim-by-pid 500: database locked";
    expect(isMissingPeerClaimError(msg)).toBe(false);
    expect(isMissingClaimEndpointError(msg)).toBe(false);
    expect(shouldSelfRegisterAfterClaimError(msg)).toBe(false);
  });

  test("self-registration retry claims messages after repairing the missing peer row", async () => {
    const calls: string[] = [];
    const result = await retryClaimAfterSelfRegistration({
      claimPids: [101, 202],
      drainId: "test-drain",
      initialPid: 101,
      lastClaimError: "/claim-by-pid 404: peer not found",
      register: async () => {
        calls.push("register");
        return true;
      },
      sleep: async (ms) => {
        calls.push(`sleep:${ms}`);
      },
      claim: async (pid, drainId) => {
        calls.push(`claim:${pid}:${drainId}`);
        if (pid === 101) throw new BrokerHttpError("/claim-by-pid", 404, "peer not found");
        return { peer_id: "peer-202", drain_id: drainId, messages: [] };
      },
    });

    expect(result.claimed?.peer_id).toBe("peer-202");
    expect(result.pid).toBe(202);
    expect(result.fatalError).toBeUndefined();
    expect(calls).toEqual(["register", "sleep:250", "claim:101:test-drain", "claim:202:test-drain"]);
  });

  test("self-registration retry stops on stale broker endpoint errors", async () => {
    const result = await retryClaimAfterSelfRegistration({
      claimPids: [101],
      drainId: "test-drain",
      initialPid: 101,
      lastClaimError: "/claim-by-pid 404: peer not found",
      register: async () => true,
      sleep: async () => {},
      claim: async () => {
        throw new BrokerHttpError("/claim-by-pid", 404, "Not Found");
      },
    });

    expect(result.claimed).toBeNull();
    expect(result.fatalError).toBe("/claim-by-pid 404: Not Found");
  });

  test("registration process wait kills a stalled helper", async () => {
    let killed = false;
    const proc = {
      exited: new Promise<number>(() => {}),
      kill: () => {
        killed = true;
      },
      stderr: null,
    };

    await expect(waitForRegistrationProcess(proc, 1)).rejects.toThrow("registration timed out");
    expect(killed).toBe(true);
  });

  test("hook emits stdout before acking claimed messages", () => {
    const source = readFileSync(new URL("../hooks/codex-drain-peer-inbox.ts", import.meta.url), "utf8");
    const writeIndex = source.indexOf("await Bun.write(Bun.stdout");
    const ackIndex = source.indexOf('const ack = await post<AckByPidResponse>("/ack-by-pid"', writeIndex);

    expect(writeIndex).toBeGreaterThan(0);
    expect(ackIndex).toBeGreaterThan(writeIndex);
    expect(source).toContain("stdout emit failed before ack");
    expect(source).toContain("ack failed after stdout emit");
  });
});
