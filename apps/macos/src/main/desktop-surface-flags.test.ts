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

describe("the corner replaces the orb", () => {
  test("corner on, companion's stored true is overruled", () => {
    // Exactly Manav's machine on 2026-08-23: `desktop-companion: true` left
    // over from before the corner existed.
    setFlags({ "desktop-corner": true, "desktop-companion": true });
    expect(isCornerEnabled()).toBe(true);
    expect(isCompanionEnabled()).toBe(false);
  });

  test("corner off, the orb still works — nothing is taken away early", () => {
    setFlags({ "desktop-corner": false, "desktop-companion": true });
    expect(isCompanionEnabled()).toBe(true);
  });
});

describe("the env override still wins in both directions", () => {
  test("the orb can be forced on alongside the corner, to compare them", () => {
    setFlags({ "desktop-corner": true, "desktop-companion": false });
    process.env.VELLUM_FLAG_DESKTOP_COMPANION = "1";
    expect(isCompanionEnabled()).toBe(true);
    expect(isCornerEnabled()).toBe(true);
  });

  test("the corner can be forced off without touching stored flags", () => {
    setFlags({ "desktop-corner": true, "desktop-companion": true });
    process.env.VELLUM_FLAG_DESKTOP_CORNER = "off";
    expect(isCornerEnabled()).toBe(false);
    // …and the orb comes back, because nothing has replaced it.
    expect(isCompanionEnabled()).toBe(true);
  });

  test("an unparseable override falls through to the stored flag", () => {
    setFlags({ "desktop-corner": true });
    process.env.VELLUM_FLAG_DESKTOP_CORNER = "maybe";
    expect(isCornerEnabled()).toBe(true);
  });
});
