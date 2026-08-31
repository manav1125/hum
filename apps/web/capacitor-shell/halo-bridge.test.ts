/**
 * The bridge's one job is to be honest about whether Halo is there.
 *
 * The trap being guarded against is real and cost this project a release once:
 * `Capacitor.Plugins` is permanently `{}` when the shell runs without a
 * bundler, so the object existing proves nothing. Every test here is about
 * refusing to claim a capability that is not actually present.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  configureHalo,
  isHaloAvailable,
  openHalo,
  resolveHalo,
} from "./halo-bridge.js";

type Capacitor = {
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, unknown>;
};

function setCapacitor(value: Capacitor | undefined): void {
  (globalThis as { Capacitor?: Capacitor }).Capacitor = value;
}

afterEach(() => setCapacitor(undefined));

describe("resolveHalo", () => {
  test("is null on the web, so callers never branch on platform", () => {
    setCapacitor(undefined);
    expect(resolveHalo()).toBeNull();
    expect(isHaloAvailable()).toBe(false);
  });

  test("is null when Capacitor exists but the platform is not native", () => {
    setCapacitor({ isNativePlatform: () => false, Plugins: { Halo: {} } });
    expect(resolveHalo()).toBeNull();
  });

  test("is null when Plugins is the empty object the shell can produce", () => {
    // Without a bundler `Capacitor.Plugins` is permanently `{}` — the trap
    // that once swallowed the iOS magic-link hand-off entirely.
    setCapacitor({ isNativePlatform: () => true, Plugins: {} });
    expect(resolveHalo()).toBeNull();
  });

  test("is null when the plugin object is there but has no methods", () => {
    setCapacitor({ isNativePlatform: () => true, Plugins: { Halo: {} } });
    expect(resolveHalo()).toBeNull();
  });

  test("resolves when the method is genuinely callable", () => {
    setCapacitor({
      isNativePlatform: () => true,
      Plugins: { Halo: { openDay: async () => ({}) } },
    });
    expect(resolveHalo()).not.toBeNull();
    expect(isHaloAvailable()).toBe(true);
  });
});

describe("opening a surface", () => {
  test("returns false off-native rather than throwing", async () => {
    setCapacitor(undefined);
    expect(await openHalo("day")).toBe(false);
    expect(await configureHalo("https://x", "t")).toBe(false);
  });

  test("routes each surface to its own native method", async () => {
    const calls: string[] = [];
    const record = (name: string) => async () => {
      calls.push(name);
      return {};
    };
    setCapacitor({
      isNativePlatform: () => true,
      Plugins: {
        Halo: {
          openDay: record("day"),
          openQueue: record("queue"),
          openRecap: record("recap"),
          openOnboarding: record("onboarding"),
        },
      },
    });

    for (const surface of ["day", "queue", "recap", "onboarding"] as const) {
      expect(await openHalo(surface)).toBe(true);
    }
    expect(calls).toEqual(["day", "queue", "recap", "onboarding"]);
  });

  test("hands the native side the SPA's own instance and token", async () => {
    // A second copy of auth could disagree about which instance somebody is
    // signed into, and "my Halo is showing someone else's day" is not a bug
    // worth risking to save a parameter.
    let received: { baseURL: string; token: string } | null = null;
    setCapacitor({
      isNativePlatform: () => true,
      Plugins: {
        Halo: {
          openDay: async () => ({}),
          configure: async (o: { baseURL: string; token: string }) => {
            received = o;
          },
        },
      },
    });

    expect(await configureHalo("https://manav.justcue.app", "tok")).toBe(true);
    expect(received).toEqual({
      baseURL: "https://manav.justcue.app",
      token: "tok",
    });
  });
});
