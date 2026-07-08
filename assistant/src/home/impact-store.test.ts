/**
 * Unit tests for impact aggregation (pure `aggregateEvents`).
 */

import { describe, expect, it } from "bun:test";

import { aggregateEvents, type ImpactEvent } from "./impact-store.js";

const NOW = new Date("2026-06-17T12:00:00Z");
const ago = (hours: number): string =>
  new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();

const ev = (
  category: ImpactEvent["category"],
  minutesSaved: number,
  hoursAgo: number,
  detail?: string,
): ImpactEvent => ({
  type: "t",
  category,
  minutesSaved,
  at: ago(hoursAgo),
  ...(detail ? { detail } : {}),
});

describe("aggregateEvents", () => {
  it("sums hours-saved and counts tasks within the window", () => {
    const s = aggregateEvents(
      [ev("email", 6, 1), ev("email", 6, 2), ev("scheduling", 18, 3)],
      7,
      NOW,
    );
    expect(s.taskCount).toBe(3);
    expect(s.hoursSaved).toBe(0.5); // (6+6+18)/60 = 0.5
  });

  it("excludes events older than the range", () => {
    const s = aggregateEvents(
      [ev("email", 60, 1), ev("email", 60, 24 * 10)], // second is 10 days ago
      7,
      NOW,
    );
    expect(s.taskCount).toBe(1);
    expect(s.hoursSaved).toBe(1);
  });

  it("rolls up by category, sorted by hours desc", () => {
    const s = aggregateEvents(
      [ev("email", 30, 1), ev("scheduling", 90, 1), ev("email", 30, 2)],
      7,
      NOW,
    );
    expect(s.byCategory[0]).toEqual({
      category: "scheduling",
      count: 1,
      hours: 1.5,
    });
    expect(s.byCategory[1]).toEqual({ category: "email", count: 2, hours: 1 });
  });

  it("surfaces recent items with details, newest first", () => {
    const s = aggregateEvents(
      [
        ev("email", 6, 3, "Drafted a reply — Re: A"),
        ev("email", 6, 1, "Drafted a reply — Re: B"),
        ev("email", 1, 2), // no detail -> excluded from recent
      ],
      7,
      NOW,
    );
    expect(s.recent.map((r) => r.detail)).toEqual([
      "Drafted a reply — Re: B",
      "Drafted a reply — Re: A",
    ]);
  });

  it("is empty for no events", () => {
    const s = aggregateEvents([], 7, NOW);
    expect(s).toEqual({
      rangeDays: 7,
      hoursSaved: 0,
      taskCount: 0,
      byCategory: [],
      byDay: [0, 0, 0, 0, 0, 0, 0],
      previousHoursSaved: 0,
      changePercent: null,
      recent: [],
    });
  });

  it("computes week-over-week change vs the prior equal-length window", () => {
    // 60 min this week (24h ago) vs 30 min the prior week (240h ≈ 10d ago) → +100%.
    const s = aggregateEvents(
      [ev("email", 60, 24), ev("email", 30, 240)],
      7,
      NOW,
    );
    expect(s.hoursSaved).toBe(1);
    expect(s.previousHoursSaved).toBe(0.5);
    expect(s.changePercent).toBe(100);
  });

  it("reports null change when there is no prior-window activity", () => {
    const s = aggregateEvents([ev("email", 60, 24)], 7, NOW);
    expect(s.previousHoursSaved).toBe(0);
    expect(s.changePercent).toBeNull();
  });
});
