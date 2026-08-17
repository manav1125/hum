/**
 * The archive's honesty rules, at a stated clock.
 *
 * The one that matters most is the last block: an instance with months of
 * history and an empty snapshot store shows the interim line and NO rows.
 * Nothing here can invent a past row, because nothing here can make one.
 */
import { describe, expect, test } from "bun:test";

import { dayKey, interimLine, isoWeekKey, keptRows } from "./ritual-archive";
import type { RitualSnapshot } from "./use-ritual-snapshots";

const DAY = 86_400_000;
/** Monday 17 Aug 2026, 09:00 local. */
const NOW = new Date(2026, 7, 17, 9, 0, 0, 0);

function brief(
  periodKey: string,
  composedAt: number,
  facts: Partial<RitualSnapshot["facts"]> = {},
): RitualSnapshot {
  return {
    id: `brief:${periodKey}`,
    ritual: "brief",
    periodKey,
    periodStart: composedAt - DAY,
    periodEnd: composedAt,
    composedAt,
    headline: "While you slept, Cue finished two things.",
    facts: { done: 2, needsYou: 1, ...facts },
  };
}

function weekly(periodKey: string, composedAt: number): RitualSnapshot {
  return {
    id: `weekly:${periodKey}`,
    ritual: "weekly",
    periodKey,
    periodStart: composedAt - 7 * DAY,
    periodEnd: composedAt,
    composedAt,
    headline: "Nine things moved. Two slipped.",
    facts: { moved: 9, slipped: 2 },
  };
}

describe("period keys match the daemon's", () => {
  test("day keys are the local calendar date", () => {
    expect(dayKey(NOW)).toBe("2026-08-17");
  });

  test("Friday and the weekend share one ISO week", () => {
    expect(isoWeekKey("2026-08-21")).toBe(isoWeekKey("2026-08-23"));
    expect(isoWeekKey("2026-08-21")).not.toBe(isoWeekKey("2026-08-24"));
  });
});

describe("keptRows", () => {
  test("renders a kept brief with the sentence composed on the day", () => {
    const rows = keptRows(NOW, [brief("2026-08-14", NOW.getTime() - 3 * DAY)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Morning brief");
    expect(rows[0]!.sentence).toBe("While you slept, Cue finished two things.");
    expect(rows[0]!.detail).toBe("2 finished · 1 needed you");
  });

  test("a kept weekly carries its span and both numbers", () => {
    const rows = keptRows(NOW, [weekly("2026-W33", NOW.getTime() - 3 * DAY)]);
    expect(rows[0]!.title).toBe("Weekly review");
    expect(rows[0]!.detail).toBe("9 moved · 2 slipped");
    expect(rows[0]!.eyebrow).toContain("—");
  });

  test("today's brief and this week's review are left to the live rows", () => {
    const rows = keptRows(NOW, [
      brief("2026-08-17", NOW.getTime()),
      weekly(isoWeekKey("2026-08-17"), NOW.getTime()),
      brief("2026-08-16", NOW.getTime() - DAY),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["brief:2026-08-16"]);
  });

  test("a snapshot with no figures still renders its sentence", () => {
    const quiet = brief("2026-08-14", NOW.getTime() - 3 * DAY, {});
    quiet.facts = {};
    quiet.headline = "All quiet overnight.";
    const rows = keptRows(NOW, [quiet]);
    expect(rows[0]!.detail).toBeNull();
    expect(rows[0]!.sentence).toBe("All quiet overnight.");
  });
});

describe("interimLine — the absence, stated for exactly as long as it is true", () => {
  test("an empty store gets design's line", () => {
    expect(interimLine(NOW, null, true)).toBe(
      "Cue only started keeping these today. Earlier briefs weren't saved — they went out and weren't written down.",
    );
  });

  test("a store that started today gets the same line", () => {
    const startedThisMorning = new Date(2026, 7, 17, 7, 30).getTime();
    expect(interimLine(NOW, startedThisMorning, true)).toBe(
      "Cue only started keeping these today. Earlier briefs weren't saved — they went out and weren't written down.",
    );
  });

  test("after the first day it names the day rather than saying 'today'", () => {
    const line = interimLine(NOW, NOW.getTime() - 3 * DAY, true);
    expect(line).toContain("Cue started keeping these on");
    expect(line).not.toContain("today");
    expect(line).toContain("they went out and weren't written down");
  });

  test("it removes itself once the log is a week old", () => {
    expect(interimLine(NOW, NOW.getTime() - 8 * DAY, true)).toBeNull();
  });

  test("an unanswered request states nothing — a failed fetch is not evidence of absence", () => {
    expect(interimLine(NOW, null, false)).toBeNull();
  });
});

describe("no backfill, end to end", () => {
  test("months of history with an empty store yields the line and zero rows", () => {
    // The instance has been running since June; the store has kept nothing.
    const rows = keptRows(NOW, []);
    expect(rows).toEqual([]);
    expect(interimLine(NOW, null, true)).toContain(
      "Earlier briefs weren't saved",
    );
  });

  test("once rows exist, only the periods actually kept appear", () => {
    const rows = keptRows(NOW, [brief("2026-08-16", NOW.getTime() - DAY)]);
    expect(rows.map((r) => r.eyebrow.includes("AUG"))).toEqual([true]);
    expect(rows).toHaveLength(1);
  });
});
