import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Which floating surface exists, and the rule that only one of them may.
 *
 * The corner was designed to REPLACE the always-on orb. The flag that turns
 * the orb on is sticky — once an install has stored `true` it keeps it — so
 * without an explicit rule the day the corner ships is the day both panels
 * appear at once. That rule lives here, and so does its test.
 */

let settingsState: Record<string, unknown> = {};

mock.module("./settings", () => ({
  readSetting: (key: string) => settingsState[key],
}));

const { isCornerEnabled, isCompanionEnabled } = await import(
  "./desktop-surface-flags"
);

const ORIGINAL_ENV = {
  corner: process.env.VELLUM_FLAG_DESKTOP_CORNER,
  companion: process.env.VELLUM_FLAG_DESKTOP_COMPANION,
};

const setFlags = (flags: Record<string, boolean>): void => {
  settingsState = { featureFlags: flags };
};

beforeEach(() => {
  settingsState = {};
  delete process.env.VELLUM_FLAG_DESKTOP_CORNER;
  delete process.env.VELLUM_FLAG_DESKTOP_COMPANION;
});

afterEach(() => {
  for (const [k, v] of [
    ["VELLUM_FLAG_DESKTOP_CORNER", ORIGINAL_ENV.corner],
    ["VELLUM_FLAG_DESKTOP_COMPANION", ORIGINAL_ENV.companion],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("absent means off", () => {
  test("no flags at all", () => {
    expect(isCornerEnabled()).toBe(false);
    expect(isCompanionEnabled()).toBe(false);
  });
});

describe("the companion stands on its own flag", () => {
  /**
   * Reversed on 2026-08-24. This suite used to assert the opposite — that the
   * corner suppressed the companion, because the corner was said to replace
   * it. The owner's decision went the other way: the always-on companion is
   * the direction and the summoned corner is what retires. A surface that
   * silently switches another one off is the wrong shape either way round;
   * now nothing yields.
   */
  test("both on is allowed — neither suppresses the other", () => {
    setFlags({ "desktop-corner": true, "desktop-companion": true });
    expect(isCornerEnabled()).toBe(true);
    expect(isCompanionEnabled()).toBe(true);
  });

  test("the companion does not need the corner off", () => {
    setFlags({ "desktop-corner": true, "desktop-companion": false });
    expect(isCompanionEnabled()).toBe(false);
  });

  test("corner off, companion on — the shipping shape", () => {
    setFlags({ "desktop-corner": false, "desktop-companion": true });
    expect(isCompanionEnabled()).toBe(true);
    expect(isCornerEnabled()).toBe(false);
  });
});

describe("the env override still wins in both directions", () => {
  test("the companion can be forced on regardless of its stored flag", () => {
    setFlags({ "desktop-corner": true, "desktop-companion": false });
    process.env.VELLUM_FLAG_DESKTOP_COMPANION = "1";
    expect(isCompanionEnabled()).toBe(true);
    expect(isCornerEnabled()).toBe(true);
  });

  test("the corner can be forced off without touching stored flags", () => {
    setFlags({ "desktop-corner": true, "desktop-companion": true });
    process.env.VELLUM_FLAG_DESKTOP_CORNER = "off";
    expect(isCornerEnabled()).toBe(false);
    expect(isCompanionEnabled()).toBe(true);
  });

  test("an unparseable override falls through to the stored flag", () => {
    setFlags({ "desktop-corner": true });
    process.env.VELLUM_FLAG_DESKTOP_CORNER = "maybe";
    expect(isCornerEnabled()).toBe(true);
  });
});
