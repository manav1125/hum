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
  _setHaloSessionForTests,
  resetHaloConfiguration,
  resolveHalo,
} from "./halo-bridge";

type Capacitor = {
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, unknown>;
};

function setCapacitor(value: Capacitor | undefined): void {
  (globalThis as { Capacitor?: Capacitor }).Capacitor = value;
}

/** Stand in for the SPA's session. `null` means signed out or expired. */
function setToken(token: string | null): void {
  _setHaloSessionForTests(() =>
    token === null ? null : { baseURL: "https://manav.justcue.app", token },
  );
}

afterEach(() => {
  setCapacitor(undefined);
  _setHaloSessionForTests(null);
  resetHaloConfiguration();
});

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

  test("configures itself before opening, so a caller cannot forget", async () => {
    // The failure this prevents is silent: the row opens to "Halo is not
    // configured" and reads as a broken feature rather than a missing call.
    const configures: Array<{ baseURL: string; token: string }> = [];
    setToken("session-token");
    setCapacitor({
      isNativePlatform: () => true,
      Plugins: {
        Halo: {
          openDay: async () => ({}),
          openQueue: async () => ({}),
          configure: async (o: { baseURL: string; token: string }) => {
            configures.push(o);
          },
        },
      },
    });

    expect(await openHalo("day")).toBe(true);
    expect(configures).toHaveLength(1);
    expect(configures[0].token).toBe("session-token");
    // The instance is wherever the SPA is served from — never a second guess
    // at which instance the person is signed into.
    expect(configures[0].baseURL).toBe("https://manav.justcue.app");

    // And only once per page, not per tap.
    expect(await openHalo("queue")).toBe(true);
    expect(configures).toHaveLength(1);
  });

  test("refuses to open with no usable session rather than opening empty", async () => {
    // getGatewayToken returns null for an expired token too, so this is the
    // expired case as well as the signed-out one.
    setToken(null);
    setCapacitor({
      isNativePlatform: () => true,
      Plugins: {
        Halo: { openDay: async () => ({}), configure: async () => {} },
      },
    });
    expect(await openHalo("day")).toBe(false);
  });

  test("routes each surface to its own native method", async () => {
    const calls: string[] = [];
    const record = (name: string) => async () => {
      calls.push(name);
      return {};
    };
    setToken("t");
    setCapacitor({
      isNativePlatform: () => true,
      Plugins: {
        Halo: {
          configure: async () => {},
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
    // Collected rather than assigned: TS narrows a `let x = null` to `null`
    // when the only write happens inside a closure it cannot follow.
    const received: Array<{ baseURL: string; token: string }> = [];
    setCapacitor({
      isNativePlatform: () => true,
      Plugins: {
        Halo: {
          openDay: async () => ({}),
          configure: async (o: { baseURL: string; token: string }) => {
            received.push(o);
          },
        },
      },
    });

    expect(await configureHalo("https://manav.justcue.app", "tok")).toBe(true);
    expect(received).toEqual([
      { baseURL: "https://manav.justcue.app", token: "tok" },
    ]);
  });
});
