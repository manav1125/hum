/**
 * Tests for the device-push preference gate: per-category toggles and the
 * quiet-hours window (same-day, overnight wrap, timezone resolution,
 * disabled/degenerate configs). Pure — no config loader, no network.
 */

import { describe, expect, test } from "bun:test";

import {
  type PushConfig,
  PushConfigSchema,
} from "../../config/schemas/notifications.js";
import { evaluatePushGate, isWithinQuietHours } from "../push-prefs.js";

/** Local-time Date (deterministic regardless of the machine timezone). */
function localDate(hour: number, minute: number): Date {
  return new Date(2026, 6, 20, hour, minute);
}

function pushConfig(overrides: {
  categories?: Partial<PushConfig["categories"]>;
  quietHours?: Partial<PushConfig["quietHours"]>;
}): PushConfig {
  const base = PushConfigSchema.parse({});
  return {
    categories: { ...base.categories, ...overrides.categories },
    quietHours: { ...base.quietHours, ...overrides.quietHours },
  };
}

describe("isWithinQuietHours", () => {
  test("disabled when start/end are unset (the default)", () => {
    const { quietHours } = PushConfigSchema.parse({});
    expect(isWithinQuietHours(localDate(3, 0), quietHours)).toBe(false);
  });

  test("disabled when only one endpoint is set", () => {
    expect(
      isWithinQuietHours(localDate(3, 0), {
        start: "22:00",
        end: null,
        timezone: null,
      }),
    ).toBe(false);
    expect(
      isWithinQuietHours(localDate(3, 0), {
        start: null,
        end: "08:00",
        timezone: null,
      }),
    ).toBe(false);
  });

  test("same-day window: inclusive start, exclusive end", () => {
    const qh = { start: "13:00", end: "15:00", timezone: null };
    expect(isWithinQuietHours(localDate(12, 59), qh)).toBe(false);
    expect(isWithinQuietHours(localDate(13, 0), qh)).toBe(true);
    expect(isWithinQuietHours(localDate(14, 30), qh)).toBe(true);
    expect(isWithinQuietHours(localDate(15, 0), qh)).toBe(false);
  });

  test("overnight wrap (22:00 → 08:00) covers both sides of midnight", () => {
    const qh = { start: "22:00", end: "08:00", timezone: null };
    expect(isWithinQuietHours(localDate(21, 59), qh)).toBe(false);
    expect(isWithinQuietHours(localDate(22, 0), qh)).toBe(true);
    expect(isWithinQuietHours(localDate(23, 30), qh)).toBe(true);
    expect(isWithinQuietHours(localDate(3, 0), qh)).toBe(true);
    expect(isWithinQuietHours(localDate(7, 59), qh)).toBe(true);
    expect(isWithinQuietHours(localDate(8, 0), qh)).toBe(false);
    expect(isWithinQuietHours(localDate(12, 0), qh)).toBe(false);
  });

  test("degenerate window (start === end) is disabled, not always-on", () => {
    const qh = { start: "09:00", end: "09:00", timezone: null };
    expect(isWithinQuietHours(localDate(9, 0), qh)).toBe(false);
    expect(isWithinQuietHours(localDate(21, 0), qh)).toBe(false);
  });

  test("malformed times disable the window", () => {
    expect(
      isWithinQuietHours(localDate(3, 0), {
        start: "25:00",
        end: "08:00",
        timezone: null,
      }),
    ).toBe(false);
    expect(
      isWithinQuietHours(localDate(3, 0), {
        start: "nope",
        end: "08:00",
        timezone: null,
      }),
    ).toBe(false);
  });

  test("configured timezone shifts the wall clock", () => {
    // 2026-07-20T05:30Z = 22:30 in Los Angeles (PDT, UTC-7): inside a
    // 22:00–23:00 LA window even though the UTC clock reads 05:30.
    const now = new Date(Date.UTC(2026, 6, 20, 5, 30));
    expect(
      isWithinQuietHours(now, {
        start: "22:00",
        end: "23:00",
        timezone: "America/Los_Angeles",
      }),
    ).toBe(true);
    // The same instant is 07:30 in Berlin (CEST, UTC+2): outside.
    expect(
      isWithinQuietHours(now, {
        start: "22:00",
        end: "23:00",
        timezone: "Europe/Berlin",
      }),
    ).toBe(false);
  });
});

describe("evaluatePushGate", () => {
  test("defaults: every category allowed", () => {
    const push = PushConfigSchema.parse({});
    for (const category of [
      "needsYou",
      "reviewReady",
      "morningBrief",
      "mentions",
    ] as const) {
      expect(evaluatePushGate(category, push, localDate(12, 0))).toEqual({
        allowed: true,
      });
    }
  });

  test("a disabled category is suppressed; the others stay on", () => {
    const push = pushConfig({ categories: { reviewReady: false } });
    expect(evaluatePushGate("reviewReady", push, localDate(12, 0))).toEqual({
      allowed: false,
      reason: "category_disabled",
    });
    expect(evaluatePushGate("needsYou", push, localDate(12, 0))).toEqual({
      allowed: true,
    });
  });

  test("quiet hours suppress an enabled category", () => {
    const push = pushConfig({
      quietHours: { start: "22:00", end: "08:00" },
    });
    expect(evaluatePushGate("needsYou", push, localDate(23, 15))).toEqual({
      allowed: false,
      reason: "quiet_hours",
    });
    expect(evaluatePushGate("needsYou", push, localDate(12, 0))).toEqual({
      allowed: true,
    });
  });

  test("category_disabled wins over quiet_hours in the reported reason", () => {
    const push = pushConfig({
      categories: { morningBrief: false },
      quietHours: { start: "22:00", end: "08:00" },
    });
    expect(evaluatePushGate("morningBrief", push, localDate(23, 0))).toEqual({
      allowed: false,
      reason: "category_disabled",
    });
  });
});
