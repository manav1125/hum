/**
 * A recurring schedule created without an explicit zone must inherit the
 * owner's, not silently fall to UTC.
 *
 * The null `timezone` column is not "unset" at execution time — the recurrence
 * engine evaluates the cron in UTC. Prod daemons run UTC, so on this instance
 * "0 18 * * *" (the daily brief) fired at 02:00 the next morning for an owner
 * in Hong Kong, and the weekly review landed eight hours off its stated time.
 * Both had been wrong for months, because nothing on the schedule surface ever
 * disagreed with itself: it printed the expression back exactly as entered.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

mock.module("../background-wake/publisher.js", () => ({
  refreshBackgroundWakeIntent: () => {},
}));

let uiConfig: {
  userTimezone?: string | null;
  detectedTimezone?: string | null;
};
let configThrows = false;

const realLoader = await import("../config/loader.js");
mock.module("../config/loader.js", () => ({
  ...realLoader,
  getConfig: () => {
    if (configThrows) throw new Error("config unreadable");
    return { ui: uiConfig } as ReturnType<typeof realLoader.getConfig>;
  },
}));

const { resolveDefaultScheduleTimeZone, createSchedule } =
  await import("../schedule/schedule-store.js");
const { initializeDb } = await import("../memory/db-init.js");

initializeDb();

let seq = 0;
/** Unique per call — createSchedule rejects exact duplicates by design. */
const uniqueName = () => `tz-probe-${++seq}`;

beforeEach(() => {
  uiConfig = {};
  configThrows = false;
});

describe("resolveDefaultScheduleTimeZone", () => {
  test("prefers the zone the owner configured", () => {
    uiConfig = {
      userTimezone: "Asia/Hong_Kong",
      detectedTimezone: "America/New_York",
    };
    expect(resolveDefaultScheduleTimeZone()).toBe("Asia/Hong_Kong");
  });

  test("falls back to the zone the client detected", () => {
    uiConfig = { userTimezone: null, detectedTimezone: "Europe/Berlin" };
    expect(resolveDefaultScheduleTimeZone()).toBe("Europe/Berlin");
  });

  test("canonicalizes a non-IANA spelling rather than dropping it", () => {
    uiConfig = { userTimezone: "HKT" };
    expect(resolveDefaultScheduleTimeZone()).toBe("Asia/Hong_Kong");
  });

  test("ignores an empty string — it is not a zone", () => {
    uiConfig = { userTimezone: "   ", detectedTimezone: "Europe/Berlin" };
    expect(resolveDefaultScheduleTimeZone()).toBe("Europe/Berlin");
  });

  test("ignores an unparseable zone rather than throwing", () => {
    uiConfig = { userTimezone: "Not/AZone", detectedTimezone: "Europe/Berlin" };
    expect(resolveDefaultScheduleTimeZone()).toBe("Europe/Berlin");
  });

  test("returns null when nothing is configured", () => {
    // Deliberately NOT the host zone. Prod's host zone is UTC, so guessing it
    // would reproduce the original wrong answer while looking deliberate.
    expect(resolveDefaultScheduleTimeZone()).toBeNull();
  });

  test("returns null when config cannot be read at all", () => {
    configThrows = true;
    uiConfig = { userTimezone: "Asia/Hong_Kong" };
    expect(resolveDefaultScheduleTimeZone()).toBeNull();
  });
});

describe("createSchedule applies the default", () => {
  test("a recurring schedule with no zone inherits the owner's", () => {
    uiConfig = { userTimezone: "Asia/Hong_Kong" };
    const job = createSchedule({
      name: uniqueName(),
      cronExpression: "0 18 * * *",
      message: "daily brief",
    });
    // Without this the row stored null and the engine read "0 18" as UTC —
    // 02:00 the next morning in Hong Kong.
    expect(job.timezone).toBe("Asia/Hong_Kong");
  });

  test("an explicit zone still wins over the owner's default", () => {
    uiConfig = { userTimezone: "Asia/Hong_Kong" };
    const job = createSchedule({
      name: uniqueName(),
      cronExpression: "0 9 * * 1",
      message: "weekly review",
      timezone: "America/New_York",
    });
    expect(job.timezone).toBe("America/New_York");
  });

  test("stays null when the owner has no zone configured", () => {
    uiConfig = {};
    const job = createSchedule({
      name: uniqueName(),
      cronExpression: "0 7 * * *",
      message: "no zone anywhere",
    });
    expect(job.timezone).toBeNull();
  });
});
