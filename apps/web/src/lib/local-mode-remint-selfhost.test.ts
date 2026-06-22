/**
 * Self-host (Cue) coverage for `remintGatewayTokenOnce`.
 *
 * On a runtime/SSE 401 the daemon interceptor calls `remintGatewayTokenOnce`.
 * In self-host mode there is no local `/auth/token` mint to re-prime from, so
 * the function must NOT clear-and-no-op (which strands every later request
 * unauthorized → a hard sign-out). It must re-stamp the gateway slot from the
 * durable actor token, and only give up when that token is itself expired.
 *
 * Isolated in its own file because the cue-self-host mock must be toggleable,
 * and bun's `mock.module` is process-global (see scripts/run-tests.ts).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockIsSelfHost = true;
let mockActorValid = true;
let mockRehydrateResult = true;
const clearGatewayTokenMock = mock(() => {});
const rehydrateMock = mock(() => mockRehydrateResult);
const primeWithRepairMock = mock(async () => {});

mock.module("@/lib/auth/gateway-session", () => ({
  clearGatewayToken: clearGatewayTokenMock,
  ensureGatewayToken: async () => {},
  getGatewayToken: () => "gateway-tok",
  getLocalTokenUrl: () => undefined,
  isGatewayAuthEnabled: () => true,
}));

mock.module("@/lib/self-hosted/cue-self-host", () => ({
  isSelfHostMode: () => mockIsSelfHost,
  isStoredActorTokenValid: () => mockActorValid,
  rehydrateGatewayTokenFromActor: rehydrateMock,
}));

mock.module("@/lib/self-hosted/connection", () => ({
  setSelfHostedConnection: () => {},
}));

// The repair prime must never run on the self-host branch.
const host = await import("@/runtime/local-mode-host");
mock.module("@/runtime/local-mode-host", () => ({
  ...host,
  fetchGuardianTokenHost: async () => "tok",
  wakeLocalAssistantHost: async () => ({ ok: true }),
}));

const { remintGatewayTokenOnce, __resetRemintStateForTesting } = await import(
  "@/lib/local-mode"
);

beforeEach(() => {
  mockIsSelfHost = true;
  mockActorValid = true;
  mockRehydrateResult = true;
  clearGatewayTokenMock.mockClear();
  rehydrateMock.mockClear();
  primeWithRepairMock.mockClear();
  __resetRemintStateForTesting();
});

describe("remintGatewayTokenOnce — self-host", () => {
  test("re-stamps the gateway slot from the durable actor token (no local re-prime)", async () => {
    const ok = await remintGatewayTokenOnce();

    expect(ok).toBe(true);
    expect(rehydrateMock).toHaveBeenCalled();
    expect(clearGatewayTokenMock).toHaveBeenCalled();
  });

  test("returns false without resurrecting when the actor token is expired", async () => {
    mockActorValid = false;

    const ok = await remintGatewayTokenOnce();

    expect(ok).toBe(false);
    // Did not clear the slot or attempt a re-stamp on an expired credential.
    expect(rehydrateMock).not.toHaveBeenCalled();
    expect(clearGatewayTokenMock).not.toHaveBeenCalled();
  });

  test("is rate-limited: back-to-back calls re-stamp only once within the cooldown", async () => {
    __resetRemintStateForTesting();
    await remintGatewayTokenOnce();
    await remintGatewayTokenOnce();
    await remintGatewayTokenOnce();
    // The cooldown caps churn: only the first call inside the window re-stamps.
    expect(rehydrateMock).toHaveBeenCalledTimes(1);
  });
});
