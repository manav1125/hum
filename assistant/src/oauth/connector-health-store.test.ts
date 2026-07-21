/**
 * Connector health store: passive signals and probe results survive a
 * reload (restart), failures capture the error, and the store never throws.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";

import {
  getConnectorHealthState,
  recordConnectorFailure,
  recordConnectorProbe,
  recordConnectorSuccess,
  resetConnectorHealthStoreForTest,
} from "./connector-health-store.js";

function healthFilePath(): string {
  const ws = process.env.VELLUM_WORKSPACE_DIR;
  if (!ws) throw new Error("test workspace missing");
  return join(ws, "connector-health.json");
}

afterEach(() => {
  resetConnectorHealthStoreForTest();
  if (existsSync(healthFilePath())) rmSync(healthFilePath());
});

describe("connector-health-store", () => {
  it("records and returns signals", () => {
    recordConnectorSuccess("gmail");
    recordConnectorFailure(
      "slack",
      "Provider rejected the connection (HTTP 401)",
    );
    const { signals } = getConnectorHealthState();
    expect(signals.gmail?.lastSuccessAt).toBeGreaterThan(0);
    expect(signals.slack?.lastError).toContain("401");
    expect(signals.slack?.lastErrorAt).toBeGreaterThan(0);
  });

  it("persists across a reload (daemon restart)", () => {
    recordConnectorFailure("gmail", "boom");
    recordConnectorProbe("slack", {
      checkedAt: Date.now(),
      status: "failed",
      error: "token_revoked",
    });
    // Drop the in-memory state — the next read must come from disk.
    resetConnectorHealthStoreForTest();
    const { signals, probes } = getConnectorHealthState();
    expect(signals.gmail?.lastError).toBe("boom");
    expect(probes.slack?.status).toBe("failed");
  });

  it("a success after a failure clears into the ok-shaped signal", () => {
    recordConnectorFailure("gmail", "bad");
    recordConnectorSuccess("gmail");
    const { signals } = getConnectorHealthState();
    const g = signals.gmail;
    expect(g?.lastSuccessAt).toBeGreaterThanOrEqual(g?.lastErrorAt ?? 0);
  });

  it("clips oversized error strings", () => {
    recordConnectorFailure("gmail", "x".repeat(1000));
    expect(
      getConnectorHealthState().signals.gmail?.lastError?.length,
    ).toBeLessThanOrEqual(200);
  });
});
