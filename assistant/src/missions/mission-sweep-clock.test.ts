/**
 * Sweep-clock schedule computation (mission `sweepAt`) — pure-function tests
 * for `isMissionCycleDue` + `nextSweepOccurrenceAfter`.
 *
 * The whole file runs pinned to America/New_York (set before any Date use;
 * scripts/test.sh runs every test file in its own process, so this cannot
 * leak into other suites). Pinning a DST-observing zone makes the local
 * wall-clock math — including the spring-forward transition — deterministic
 * regardless of the machine running the tests.
 */
process.env.TZ = "America/New_York";

import { describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../__tests__/helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import {
  isMissionCycleDue,
  nextSweepOccurrenceAfter,
} from "./mission-orchestrator.js";
import type { Mission } from "./mission-store.js";

/** Epoch ms for a local (America/New_York) wall-clock moment. */
function local(
  year: number,
  month1: number,
  day: number,
  hour = 0,
  minute = 0,
): number {
  return new Date(year, month1 - 1, day, hour, minute).getTime();
}

function mission(overrides: Partial<Mission>): Mission {
  return {
    id: "m-1",
    title: "M",
    outcome: "x",
    metric: null,
    horizon: null,
    status: "active",
    mode: null,
    brief: null,
    cadence: null, // null = daily
    sweepAt: "08:00",
    budgetCents: null,
    spentCents: 0,
    continuationSummary: null,
    pinned: 0,
    sortIndex: null,
    lastCycleAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("nextSweepOccurrenceAfter", () => {
  test("same-day occurrence when the clock hasn't struck yet", () => {
    expect(nextSweepOccurrenceAfter(local(2026, 7, 20, 7, 15), 8, 0)).toBe(
      local(2026, 7, 20, 8, 0),
    );
  });

  test("rolls to the next day when the clock already struck (strictly after)", () => {
    expect(nextSweepOccurrenceAfter(local(2026, 7, 20, 8, 0), 8, 0)).toBe(
      local(2026, 7, 21, 8, 0),
    );
    expect(nextSweepOccurrenceAfter(local(2026, 7, 20, 9, 30), 8, 0)).toBe(
      local(2026, 7, 21, 8, 0),
    );
  });

  test("crosses a month boundary", () => {
    expect(nextSweepOccurrenceAfter(local(2026, 7, 31, 23, 59), 8, 0)).toBe(
      local(2026, 8, 1, 8, 0),
    );
  });

  test("DST spring-forward: the occurrence lands on the wall clock, not a fixed 24h offset", () => {
    // America/New_York 2026-03-08: 02:00 EST jumps to 03:00 EDT — the local
    // day is only 23 real hours. 08:00 on Mar 8 must mean wall-clock 08:00.
    const after = local(2026, 3, 7, 8, 0); // Mar 7, 08:00 EST (rolls forward)
    const next = nextSweepOccurrenceAfter(after, 8, 0);
    expect(next).toBe(local(2026, 3, 8, 8, 0));
    // 23 real hours, not 24 — proves wall-clock anchoring across the jump.
    expect(next - after).toBe(23 * 60 * 60 * 1000);
  });
});

describe("isMissionCycleDue with a sweep clock", () => {
  test("daily: due exactly at the sweep clock, not before", () => {
    const m = mission({ lastCycleAt: local(2026, 7, 20, 7, 0) });
    expect(isMissionCycleDue(m, local(2026, 7, 20, 7, 59))).toBe(false);
    expect(isMissionCycleDue(m, local(2026, 7, 20, 8, 0))).toBe(true);
  });

  test("daily: after sweeping at the clock, next due is tomorrow's clock", () => {
    const m = mission({ lastCycleAt: local(2026, 7, 20, 8, 0) });
    expect(isMissionCycleDue(m, local(2026, 7, 20, 23, 0))).toBe(false);
    expect(isMissionCycleDue(m, local(2026, 7, 21, 7, 59))).toBe(false);
    expect(isMissionCycleDue(m, local(2026, 7, 21, 8, 0))).toBe(true);
  });

  test("daily: a missed sweep (daemon down at 08:00) fires on the next poll", () => {
    const m = mission({ lastCycleAt: local(2026, 7, 20, 8, 0) });
    // Daemon came back at 14:00 the next day — well past the clock.
    expect(isMissionCycleDue(m, local(2026, 7, 21, 14, 0))).toBe(true);
  });

  test("daily: explicit cadence string behaves like the null default", () => {
    const m = mission({
      cadence: "daily",
      sweepAt: "06:30",
      lastCycleAt: local(2026, 7, 20, 6, 30),
    });
    expect(isMissionCycleDue(m, local(2026, 7, 21, 6, 29))).toBe(false);
    expect(isMissionCycleDue(m, local(2026, 7, 21, 6, 30))).toBe(true);
  });

  test("weekly: due at the sweep clock on the 7th day", () => {
    const m = mission({
      cadence: "weekly",
      lastCycleAt: local(2026, 7, 13, 8, 0), // Mon Jul 13, 08:00
    });
    expect(isMissionCycleDue(m, local(2026, 7, 19, 8, 0))).toBe(false); // day 6
    expect(isMissionCycleDue(m, local(2026, 7, 20, 7, 59))).toBe(false);
    expect(isMissionCycleDue(m, local(2026, 7, 20, 8, 0))).toBe(true); // day 7, 08:00
  });

  test("weekly: an off-clock manual run re-anchors to the clock a week out", () => {
    const m = mission({
      cadence: "weekly",
      lastCycleAt: local(2026, 7, 13, 15, 42), // manual run Mon 15:42
    });
    // Day 6 anchor = Sun Jul 19 15:42; next 08:00 strictly after = Mon 08:00.
    expect(isMissionCycleDue(m, local(2026, 7, 20, 7, 59))).toBe(false);
    expect(isMissionCycleDue(m, local(2026, 7, 20, 8, 0))).toBe(true);
  });

  test("hourly cadence ignores the sweep clock (rolling interval)", () => {
    const m = mission({
      cadence: "hourly",
      sweepAt: "08:00",
      lastCycleAt: local(2026, 7, 20, 13, 0),
    });
    expect(isMissionCycleDue(m, local(2026, 7, 20, 13, 59))).toBe(false);
    expect(isMissionCycleDue(m, local(2026, 7, 20, 14, 0))).toBe(true);
  });

  test("null sweepAt (legacy rows) keeps the rolling-interval behavior", () => {
    const m = mission({
      sweepAt: null,
      lastCycleAt: local(2026, 7, 20, 22, 0),
    });
    // 08:00 passes but the 24h interval hasn't elapsed — NOT due.
    expect(isMissionCycleDue(m, local(2026, 7, 21, 8, 0))).toBe(false);
    expect(isMissionCycleDue(m, local(2026, 7, 21, 22, 0))).toBe(true);
  });

  test("malformed sweepAt degrades to the rolling interval", () => {
    const m = mission({
      sweepAt: "25:99",
      lastCycleAt: local(2026, 7, 20, 22, 0),
    });
    expect(isMissionCycleDue(m, local(2026, 7, 21, 8, 0))).toBe(false);
    expect(isMissionCycleDue(m, local(2026, 7, 21, 22, 0))).toBe(true);
  });

  test("never-ran and non-active statuses are unaffected by the clock", () => {
    expect(
      isMissionCycleDue(
        mission({ lastCycleAt: null }),
        local(2026, 7, 20, 3, 0),
      ),
    ).toBe(true);
    expect(
      isMissionCycleDue(
        mission({ status: "paused", lastCycleAt: local(2026, 7, 19, 8, 0) }),
        local(2026, 7, 21, 12, 0),
      ),
    ).toBe(false);
  });

  test("DST spring-forward day still sweeps at wall-clock time", () => {
    const m = mission({ lastCycleAt: local(2026, 3, 7, 8, 0) }); // Mar 7, 08:00 EST
    // Mar 8 is the 23-hour spring-forward day.
    expect(isMissionCycleDue(m, local(2026, 3, 8, 7, 59))).toBe(false);
    expect(isMissionCycleDue(m, local(2026, 3, 8, 8, 0))).toBe(true);
  });
});
