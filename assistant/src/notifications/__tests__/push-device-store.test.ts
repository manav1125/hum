/**
 * Tests for the push_devices registry store.
 *
 * Focus: idempotent register-or-refresh semantics (unique tokens, metadata
 * refresh without losing a known device name) and idempotent removal.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { pushDevices } from "../../memory/schema.js";
import {
  listPushDevices,
  registerPushDevice,
  removePushDevice,
} from "../push-device-store.js";

initializeDb();

beforeEach(() => {
  getDb().delete(pushDevices).run();
});

describe("registerPushDevice", () => {
  test("creates a new device row with timestamps", () => {
    const before = Date.now();
    const device = registerPushDevice({
      platform: "ios",
      token: "tok-a",
      deviceName: "Manav's iPhone",
    });

    expect(device.id).toBeTruthy();
    expect(device.platform).toBe("ios");
    expect(device.token).toBe("tok-a");
    expect(device.deviceName).toBe("Manav's iPhone");
    expect(device.createdAt).toBeGreaterThanOrEqual(before);
    expect(device.lastSeenAt).toBeGreaterThanOrEqual(before);
  });

  test("re-registering the same token refreshes instead of duplicating", () => {
    const first = registerPushDevice({
      platform: "ios",
      token: "tok-a",
      deviceName: "Manav's iPhone",
    });
    const second = registerPushDevice({ platform: "ios", token: "tok-a" });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.lastSeenAt).toBeGreaterThanOrEqual(first.lastSeenAt);
    // A refresh without a deviceName must not erase the known name.
    expect(second.deviceName).toBe("Manav's iPhone");
    expect(listPushDevices()).toHaveLength(1);
  });

  test("re-registering with a new deviceName updates it", () => {
    registerPushDevice({
      platform: "ios",
      token: "tok-a",
      deviceName: "Old name",
    });
    const updated = registerPushDevice({
      platform: "ios",
      token: "tok-a",
      deviceName: "New name",
    });
    expect(updated.deviceName).toBe("New name");
  });
});

describe("listPushDevices", () => {
  test("filters by platform", () => {
    registerPushDevice({ platform: "ios", token: "tok-ios" });
    registerPushDevice({ platform: "android", token: "tok-android" });

    expect(listPushDevices()).toHaveLength(2);
    expect(listPushDevices("ios").map((d) => d.token)).toEqual(["tok-ios"]);
    expect(listPushDevices("android").map((d) => d.token)).toEqual([
      "tok-android",
    ]);
  });
});

describe("removePushDevice", () => {
  test("removes a registered token and reports unknown tokens", () => {
    registerPushDevice({ platform: "ios", token: "tok-a" });

    expect(removePushDevice("tok-a")).toBe(true);
    expect(listPushDevices()).toHaveLength(0);
    // Idempotent: deleting again (or an unknown token) is not an error.
    expect(removePushDevice("tok-a")).toBe(false);
    expect(removePushDevice("never-registered")).toBe(false);
  });
});
