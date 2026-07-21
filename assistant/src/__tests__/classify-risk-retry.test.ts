/**
 * Tests for the classify_risk transient-failure retry in
 * `ipcClassifyRisk` (src/ipc/gateway-client.ts).
 *
 * A gateway blip used to fail every in-flight tool call with a raw
 * "gateway is unreachable" error. The IPC layer now retries exactly once
 * (short backoff, fresh connection) on connection-level failures, does
 * NOT retry invalid responses, and still fails closed (returns
 * `undefined` → the checker throws and the tool call is denied) when the
 * gateway stays unreachable.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence logger output during tests.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  clearIpcMocks,
  installIpcMock,
  mockIpcResponse,
} from "./helpers/gateway-classify-mock.js";

installIpcMock();

import {
  ipcClassifyRisk,
  resetPersistentClient,
} from "../ipc/gateway-client.js";

const PARAMS = { tool: "bash", command: "ls" };
const GOOD_RESPONSE = {
  risk: "low",
  reason: "read-only listing",
  matchType: "shell",
  scopeOptions: [],
};

beforeEach(() => {
  clearIpcMocks();
  resetPersistentClient();
});

describe("ipcClassifyRisk retry", () => {
  test("succeeds without retry when the gateway responds", async () => {
    let calls = 0;
    mockIpcResponse("classify_risk", () => {
      calls++;
      return GOOD_RESPONSE;
    });

    const result = await ipcClassifyRisk(PARAMS, { retryDelayMs: 1 });
    expect(result?.risk).toBe("low");
    expect(calls).toBe(1);
  });

  test("retries once on a connection-level failure and recovers", async () => {
    let calls = 0;
    mockIpcResponse("classify_risk", () => {
      calls++;
      if (calls === 1) {
        throw new Error("ECONNREFUSED: gateway socket gone");
      }
      return GOOD_RESPONSE;
    });

    const result = await ipcClassifyRisk(PARAMS, { retryDelayMs: 1 });
    expect(result?.risk).toBe("low");
    expect(calls).toBe(2);
  });

  test("returns undefined (fail closed) when both attempts fail", async () => {
    let calls = 0;
    mockIpcResponse("classify_risk", () => {
      calls++;
      throw new Error("IPC call timed out");
    });

    const result = await ipcClassifyRisk(PARAMS, { retryDelayMs: 1 });
    expect(result).toBeUndefined();
    expect(calls).toBe(2);
  });

  test("does not retry an invalid (non-object) response", async () => {
    let calls = 0;
    mockIpcResponse("classify_risk", () => {
      calls++;
      return "not-an-object";
    });

    const result = await ipcClassifyRisk(PARAMS, { retryDelayMs: 1 });
    expect(result).toBeUndefined();
    expect(calls).toBe(1);
  });

  test("does not retry a response missing the risk field", async () => {
    let calls = 0;
    mockIpcResponse("classify_risk", () => {
      calls++;
      return { reason: "shaped wrong" };
    });

    const result = await ipcClassifyRisk(PARAMS, { retryDelayMs: 1 });
    expect(result).toBeUndefined();
    expect(calls).toBe(1);
  });
});
