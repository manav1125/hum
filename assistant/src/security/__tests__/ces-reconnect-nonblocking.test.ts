import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Mock logger before importing any code that uses it.
// ---------------------------------------------------------------------------

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import { setStorePathForTesting } from "../../__tests__/encrypted-store-test-helpers.js";
import {
  _resetBackend,
  _setReconnectTuningForTesting,
  getSecureKeyAsync,
  setCesReconnect,
} from "../secure-keys.js";

const TEST_DIR = join(
  tmpdir(),
  `vellum-ces-reconnect-${randomBytes(4).toString("hex")}`,
);
const STORE_PATH = join(TEST_DIR, "keys.enc");

/**
 * Regression tests for the CES upgrade-reconnect stall (prod incident,
 * 2026-07-04): on deployments without a CES sidecar the resolved backend is
 * the encrypted file store, and the "upgrade to CES" reconnection attempt —
 * which polls a bootstrap socket for seconds before failing — used to be
 * awaited inside EVERY credential read. Dozens of serialized reads per turn
 * (embedding fallback chains and friends) each paid the poll, stretching one
 * turn's context assembly to ~106 s.
 *
 * The fix: the upgrade attempt is fired in the background (reads return on
 * the current, working backend immediately), and a failure circuit breaker
 * stretches the cooldown after consecutive failures.
 */
describe("CES upgrade reconnection is non-blocking", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    setStorePathForTesting(STORE_PATH);
    _resetBackend();
  });

  afterEach(() => {
    setStorePathForTesting(null);
    _resetBackend();
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("credential reads return promptly while a reconnect attempt hangs", async () => {
    let reconnectCalls = 0;
    // A reconnect that hangs far longer than any acceptable read latency.
    setCesReconnect(() => {
      reconnectCalls++;
      return new Promise(() => {});
    });

    // First read resolves the backend (encrypted store) without a reconnect;
    // the upgrade path only engages once a backend is already resolved.
    await getSecureKeyAsync("some-account");

    const startedAt = performance.now();
    const value = await getSecureKeyAsync("some-account");
    const elapsedMs = performance.now() - startedAt;

    expect(value).toBeUndefined();
    // Pre-fix this read awaited the hanging reconnect (until the 45 s
    // credential-op timeout). Post-fix it returns on the encrypted store
    // immediately while the reconnect runs in the background.
    expect(elapsedMs).toBeLessThan(1_000);
    expect(reconnectCalls).toBe(1);

    // Subsequent reads share the in-flight attempt instead of stacking more.
    await getSecureKeyAsync("some-account");
    await getSecureKeyAsync("some-account");
    expect(reconnectCalls).toBe(1);
  });

  test("circuit breaker stops reconnect attempts after consecutive failures", async () => {
    _setReconnectTuningForTesting({
      cooldownMs: 0,
      failureThreshold: 3,
      failureCooldownMs: 60_000,
    });

    let reconnectCalls = 0;
    setCesReconnect(async () => {
      reconnectCalls++;
      return undefined; // fails every time
    });

    // Resolve the backend first (no reconnect on the initial resolution).
    await getSecureKeyAsync("some-account");
    expect(reconnectCalls).toBe(0);

    // Each read fires a background attempt; give the microtask a beat to
    // complete so the failure is recorded before the next read.
    for (let i = 0; i < 6; i++) {
      await getSecureKeyAsync("some-account");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // With cooldownMs=0 every read would attempt — the breaker must cap it
    // at the failure threshold and then hold for failureCooldownMs.
    expect(reconnectCalls).toBe(3);
  });
});
