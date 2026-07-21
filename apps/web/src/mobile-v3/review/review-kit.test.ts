/**
 * Frame-55 review index logic — stale detection + the newest-first partition.
 */
import { describe, expect, test } from "bun:test";

import type { HqWorkItem } from "@/pages/hq/use-missions";

import {
  hasFreshBorder,
  partitionReview,
  staleLabel,
  STALE_AGE_MS,
} from "./review-kit";

const NOW = new Date("2026-07-20T12:00:00").getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function item(over: Partial<HqWorkItem>): HqWorkItem {
  return {
    id: "wi-1",
    title: "A deliverable",
    status: "awaiting_review",
    dueAt: null,
    updatedAt: NOW - HOUR,
    createdAt: NOW - DAY,
    ...over,
  } as HqWorkItem;
}

describe("staleLabel", () => {
  test("fresh items carry no label", () => {
    expect(staleLabel(item({ updatedAt: NOW - 2 * HOUR }), NOW)).toBeNull();
  });

  test("a week untouched reads stale, dated from the last touch", () => {
    const label = staleLabel(
      item({ updatedAt: NOW - STALE_AGE_MS - DAY }),
      NOW,
    );
    expect(label).toMatch(/^From .+ — likely stale$/);
    expect(label).toContain("Jul 12");
  });

  test("a passed due date reads stale even when recently touched", () => {
    const label = staleLabel(
      item({ updatedAt: NOW - HOUR, dueAt: NOW - 3 * DAY }),
      NOW,
    );
    expect(label).toMatch(/likely stale$/);
    expect(label).toContain("Jul 17");
  });

  test("a due date within the last day is NOT stale yet", () => {
    expect(
      staleLabel(item({ updatedAt: NOW - HOUR, dueAt: NOW - HOUR }), NOW),
    ).toBeNull();
  });
});

describe("partitionReview", () => {
  test("newest first, stale below the divider (each half ordered)", () => {
    const items = [
      item({ id: "old-1", updatedAt: NOW - 16 * DAY }),
      item({ id: "fresh-2", updatedAt: NOW - 5 * HOUR }),
      item({ id: "old-2", updatedAt: NOW - 18 * DAY }),
      item({ id: "fresh-1", updatedAt: NOW - 2 * HOUR }),
    ];
    const { fresh, stale } = partitionReview(items, NOW);
    expect(fresh.map((i) => i.id)).toEqual(["fresh-1", "fresh-2"]);
    expect(stale.map((i) => i.id)).toEqual(["old-1", "old-2"]);
  });

  test("empty in, empty out", () => {
    expect(partitionReview([], NOW)).toEqual({ fresh: [], stale: [] });
  });
});

describe("hasFreshBorder", () => {
  test("violet border inside 24h, neutral after", () => {
    expect(hasFreshBorder(item({ updatedAt: NOW - 5 * HOUR }), NOW)).toBe(true);
    expect(hasFreshBorder(item({ updatedAt: NOW - 30 * HOUR }), NOW)).toBe(
      false,
    );
  });
});
