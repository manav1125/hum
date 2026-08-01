/**
 * Day-rail route: the not-connected contract and parameter handling.
 *
 * The load-bearing assertion is the one the design demands — a day with no
 * calendar and a day with no meetings must not produce the same payload. The
 * first reports `not_connected` with null minutes; the second reports
 * `connected` with a real, full working window.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

/** Swapped per-test to steer what the connection layer does. */
let connectionBehaviour: () => never = () => {
  throw new Error(
    'No active OAuth connection found for "google". The google service needs to be connected before it can be used.',
  );
};

mock.module("../../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: async () => connectionBehaviour(),
}));

import {
  CalendarApiError,
  type CalendarEvent,
} from "../../calendar/google-calendar-client.js";
import {
  classifyCalendarError,
  type DayRailPayload,
  getDayRail,
} from "../../calendar/today.js";
import {
  handleCalendarDay,
  parseClockMinute,
  resolveRailDate,
  resolveRailTimeZone,
  ROUTES,
} from "./calendar-day-routes.js";
import { BadRequestError } from "./errors.js";

const TZ = "Europe/London";
const DATE = "2026-08-03";

function callRoute(
  queryParams: Record<string, string> = {},
): Promise<DayRailPayload> {
  return handleCalendarDay({ headers: {}, queryParams });
}

describe("route definition", () => {
  test("is a side-effect-free GET on calendar/day", () => {
    const route = ROUTES.find((r) => r.endpoint === "calendar/day");
    expect(route).toBeDefined();
    expect(route?.method).toBe("GET");
    expect(route?.operationId).toBe("getCalendarDay");
    expect(route?.policy?.requiredScopes).toEqual(["settings.read"]);
    expect(route?.responseBody).toBeDefined();
  });
});

describe("not connected vs quiet day", () => {
  test("no calendar connection returns an explicit not_connected shape", async () => {
    connectionBehaviour = () => {
      throw new Error(
        'No active OAuth connection found for "google". The google service needs to be connected before it can be used.',
      );
    };
    const out = await callRoute({ tz: TZ, date: DATE });

    expect(out.connection.state).toBe("not_connected");
    expect(out.connection.detail).toBeTruthy();
    expect(out.commitments).toEqual([]);
    expect(out.allDayCommitments).toEqual([]);
    // Null, not zero: the client cannot render "9h free" off an absent calendar.
    expect(out.bookedMinutes).toBeNull();
    expect(out.unbookedMinutes).toBeNull();
    expect(out.freeBlocks).toEqual([]);
    expect(out.largestFreeBlock).toBeNull();
    // The frame is still described so the rail can draw an honest empty strip.
    expect(out.window.minutes).toBe(540);
    expect(out.date).toBe(DATE);
    expect(out.timeZone).toBe(TZ);
  });

  test("a Composio toolkit that is not connected reads as not_connected", async () => {
    connectionBehaviour = () => {
      throw new Error(
        'Composio has no active "googlecalendar" connection for this user. Connect it in Cue → Connectors.',
      );
    };
    const out = await callRoute({ tz: TZ, date: DATE });
    expect(out.connection.state).toBe("not_connected");
    expect(out.unbookedMinutes).toBeNull();
  });

  test("a connected calendar with nothing today reports real numbers", async () => {
    const out = await getDayRail({
      date: DATE,
      timeZone: TZ,
      fetchEvents: async () => [],
    });
    expect(out.connection.state).toBe("connected");
    expect(out.connection.detail).toBeNull();
    expect(out.commitments).toEqual([]);
    expect(out.bookedMinutes).toBe(0);
    expect(out.unbookedMinutes).toBe(540);
    expect(out.largestFreeBlock?.minutes).toBe(540);
  });

  test("a read failure is unavailable, not not_connected, and still nulls", async () => {
    connectionBehaviour = () => {
      throw new Error("socket hang up");
    };
    const out = await callRoute({ tz: TZ, date: DATE });
    expect(out.connection.state).toBe("unavailable");
    expect(out.connection.detail).toBeTruthy();
    expect(out.bookedMinutes).toBeNull();
    expect(out.unbookedMinutes).toBeNull();
  });
});

describe("classifyCalendarError", () => {
  test("401/403 from the API mean the calendar is not readable at all", () => {
    expect(classifyCalendarError(new CalendarApiError(401, "", "x"))).toBe(
      "not_connected",
    );
    expect(classifyCalendarError(new CalendarApiError(403, "", "x"))).toBe(
      "not_connected",
    );
  });

  test("other API failures are transient", () => {
    expect(classifyCalendarError(new CalendarApiError(503, "", "x"))).toBe(
      "unavailable",
    );
    expect(classifyCalendarError(new Error("aborted"))).toBe("unavailable");
  });

  test("reconnect prompts from the resolver are not_connected", () => {
    expect(
      classifyCalendarError(
        new Error(
          'OAuth connection for "google" exists but the access token is missing or expired. The google service needs to be reconnected.',
        ),
      ),
    ).toBe("not_connected");
  });
});

describe("day assembly through the route", () => {
  const events: CalendarEvent[] = [
    {
      id: "all-day",
      summary: "Conference",
      start: { date: DATE },
      end: { date: "2026-08-04" },
    },
    {
      id: "standup",
      summary: "Standup",
      start: { dateTime: "2026-08-03T09:00:00+01:00" },
      end: { dateTime: "2026-08-03T09:30:00+01:00" },
      organizer: { self: true },
    },
    {
      id: "review",
      summary: "Pricing review",
      start: { dateTime: "2026-08-03T12:00:00+01:00" },
      end: { dateTime: "2026-08-03T13:00:00+01:00" },
      organizer: { email: "someone@example.com" },
    },
  ];

  test("produces the rail the K1 frame needs", async () => {
    const out = await getDayRail({
      date: DATE,
      timeZone: TZ,
      nowMs: Date.parse("2026-08-03T10:00:00+01:00"),
      fetchEvents: async () => events,
    });

    expect(out.connection.state).toBe("connected");
    expect(out.allDayCommitments.map((c) => c.id)).toEqual(["all-day"]);
    expect(out.commitments.map((c) => c.id)).toEqual(["standup", "review"]);
    expect(out.commitments.map((c) => c.isOrganizer)).toEqual([true, false]);
    expect(out.bookedMinutes).toBe(90);
    expect(out.unbookedMinutes).toBe(450);
    // 09:30–12:00 (150) and 13:00–18:00 (300).
    expect(out.freeBlocks.map((b) => b.minutes)).toEqual([150, 300]);
    expect(out.largestFreeBlock?.minutes).toBe(300);
    expect(out.largestFreeBlock?.startMinuteOfDay).toBe(13 * 60);
    expect(out.now.isToday).toBe(true);
    expect(out.now.minuteOfDay).toBe(10 * 60);
  });

  test("the now-marker is null when the date is not today", async () => {
    const out = await getDayRail({
      date: "2026-08-04",
      timeZone: TZ,
      nowMs: Date.parse("2026-08-03T10:00:00+01:00"),
      fetchEvents: async () => [],
    });
    expect(out.now.isToday).toBe(false);
    expect(out.now.minuteOfDay).toBeNull();
  });

  test("bounds the query to the local day", async () => {
    let seen: { timeMinIso: string; timeMaxIso: string } | null = null;
    await getDayRail({
      date: DATE,
      timeZone: TZ,
      fetchEvents: async (args) => {
        seen = args;
        return [];
      },
    });
    expect(seen).not.toBeNull();
    expect(seen!.timeMinIso).toBe("2026-08-02T23:00:00.000Z"); // 00:00 BST
    expect(seen!.timeMaxIso).toBe("2026-08-03T23:00:00.000Z");
  });
});

describe("parameter handling", () => {
  test("rejects an unparseable timezone", () => {
    expect(() => resolveRailTimeZone("Mars/Olympus")).toThrow(BadRequestError);
  });

  test("canonicalizes a supplied timezone", () => {
    expect(resolveRailTimeZone("america/new_york")).toBe("America/New_York");
  });

  test("rejects a malformed date", () => {
    expect(() => resolveRailDate("03-08-2026", TZ, Date.now())).toThrow(
      BadRequestError,
    );
  });

  test("defaults the date to today in the target zone", () => {
    // 23:30 UTC is already the next day in Tokyo.
    const ms = Date.parse("2026-08-03T23:30:00Z");
    expect(resolveRailDate(undefined, "Asia/Tokyo", ms)).toBe("2026-08-04");
    expect(resolveRailDate(undefined, "UTC", ms)).toBe("2026-08-03");
  });

  test("parses clock times and rejects nonsense", () => {
    expect(parseClockMinute("08:30", 0, "windowStart")).toBe(510);
    expect(parseClockMinute(undefined, 540, "windowStart")).toBe(540);
    expect(() => parseClockMinute("25:00", 0, "windowStart")).toThrow(
      BadRequestError,
    );
    expect(() => parseClockMinute("9am", 0, "windowStart")).toThrow(
      BadRequestError,
    );
  });

  test("rejects a window that ends before it starts", async () => {
    await expect(
      callRoute({
        tz: TZ,
        date: DATE,
        windowStart: "18:00",
        windowEnd: "09:00",
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("honours a custom window end-to-end", async () => {
    connectionBehaviour = () => {
      throw new Error("not connected");
    };
    const out = await callRoute({
      tz: TZ,
      date: DATE,
      windowStart: "08:00",
      windowEnd: "20:00",
    });
    expect(out.window.minutes).toBe(720);
    expect(out.window.startMinuteOfDay).toBe(480);
    expect(out.window.endMinuteOfDay).toBe(1200);
  });
});
