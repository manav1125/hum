/**
 * Unit tests for the managed-mode derivation (deriveManagedMode).
 *
 * The pure derivation encodes the flash policy documented in
 * use-managed-mode.ts: unknown (`undefined`) must only occur while a real
 * healthz fetch is in flight, and vendor UI stays hidden until self-host is
 * *confirmed* (`false`).
 */

import { describe, expect, test } from "bun:test";

import { deriveManagedMode, hideVendorUi } from "./use-managed-mode";
import type { HealthzGetResponse } from "@/generated/daemon/types.gen";

function healthz(managed: boolean | undefined): HealthzGetResponse {
  return {
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: "0.0.0-test",
    disk: null,
    memory: { currentMb: 1, maxMb: 2 },
    cpu: { currentPercent: 0, maxCores: 1 },
    migrations: { dbVersion: 1, lastWorkspaceMigrationId: null },
    ces: { connected: false },
    capabilities: {
      memoryOptOut: true,
      // Cast so we can simulate old daemons that predate the field.
      managed: managed as boolean,
    },
  };
}

describe("deriveManagedMode", () => {
  test("no active assistant → self-host semantics (false)", () => {
    expect(
      deriveManagedMode({ hasAssistant: false, isError: false, data: undefined }),
    ).toBe(false);
  });

  test("healthz says managed → true", () => {
    expect(
      deriveManagedMode({
        hasAssistant: true,
        isError: false,
        data: healthz(true),
      }),
    ).toBe(true);
  });

  test("healthz says not managed → false", () => {
    expect(
      deriveManagedMode({
        hasAssistant: true,
        isError: false,
        data: healthz(false),
      }),
    ).toBe(false);
  });

  test("old daemon without the field → false (self-host by definition)", () => {
    expect(
      deriveManagedMode({
        hasAssistant: true,
        isError: false,
        data: healthz(undefined),
      }),
    ).toBe(false);
  });

  test("fetch in flight → undefined (callers keep vendor UI hidden)", () => {
    expect(
      deriveManagedMode({ hasAssistant: true, isError: false, data: undefined }),
    ).toBeUndefined();
  });

  test("healthz errored (daemon unreachable) → false so self-host UI never soft-locks", () => {
    expect(
      deriveManagedMode({ hasAssistant: true, isError: true, data: undefined }),
    ).toBe(false);
  });

  test("stale data retained across an error still wins (managed stays hidden)", () => {
    expect(
      deriveManagedMode({
        hasAssistant: true,
        isError: true,
        data: healthz(true),
      }),
    ).toBe(true);
  });
});

describe("hideVendorUi", () => {
  test("hides for managed and while unknown; shows only for confirmed self-host", () => {
    expect(hideVendorUi(true)).toBe(true);
    expect(hideVendorUi(undefined)).toBe(true);
    expect(hideVendorUi(false)).toBe(false);
  });
});
