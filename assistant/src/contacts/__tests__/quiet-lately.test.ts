/**
 * The "Quiet lately" rules, tested against the cases design named as the ones
 * that decide whether the signal is trustworthy.
 *
 * Several are MUTATION CHECKS: they hold only while a specific threshold is
 * intact, so weakening one turns the suite red rather than turning the list
 * into noise. The failure mode this guards against is subtle — a list that is
 * merely *plausible* is worse than an empty one, because the owner acts on it.
 */

import { describe, expect, test } from "bun:test";

import {
  assessAllQuiet,
  assessQuiet,
  countEligible,
  medianGapMs,
  MIN_MESSAGES,
  quietIneligibleReason,
  quietRowExplanation,
} from "../quiet-lately.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

/** `count` messages every `everyDays`, the most recent `lastSeenDaysAgo` ago. */
function rhythm(
  count: number,
  everyDays: number,
  lastSeenDaysAgo: number,
): number[] {
  const last = NOW - lastSeenDaysAgo * DAY;
  return Array.from({ length: count }, (_, i) => last - i * everyDays * DAY);
}

describe("medianGapMs", () => {
  test("odd gap count takes the middle", () => {
    // gaps: 1, 2, 10 days -> median 2
    const t = [0, 1 * DAY, 3 * DAY, 13 * DAY];
    expect(medianGapMs(t)).toBe(2 * DAY);
  });

  test("even gap count averages the two middle", () => {
    // gaps: 1, 2, 4, 10 -> (2 + 4) / 2 = 3
    const t = [0, 1 * DAY, 3 * DAY, 7 * DAY, 17 * DAY];
    expect(medianGapMs(t)).toBe(3 * DAY);
  });

  test("MUTATION CHECK: a single outlier does not move the median", () => {
    // The reason design specified median over mean. One six-month silence in
    // an otherwise weekly rhythm must not redefine "normal" — a mean here is
    // ~34 days and would make the person un-flaggable forever.
    const weekly = [0, 7 * DAY, 14 * DAY, 21 * DAY, 28 * DAY];
    const withHoliday = [...weekly, 28 * DAY + 180 * DAY];
    expect(medianGapMs(withHoliday)).toBe(7 * DAY);
  });

  test("fewer than two points has no gap at all", () => {
    expect(medianGapMs([])).toBeNull();
    expect(medianGapMs([NOW])).toBeNull();
  });
});

describe("eligibility — no baseline, no verdict", () => {
  test("too few messages is its own reason", () => {
    const t = rhythm(MIN_MESSAGES - 1, 5, 90).sort((a, b) => a - b);
    expect(quietIneligibleReason(t)).toBe("too_few_messages");
  });

  test("enough messages but crammed into a burst is span_too_short", () => {
    // Ten messages in one afternoon is not a habit.
    const t = Array.from({ length: 10 }, (_, i) => NOW - i * 60_000).sort(
      (a, b) => a - b,
    );
    expect(quietIneligibleReason(t)).toBe("span_too_short");
  });

  test("an ineligible person is never flagged, however long the silence", () => {
    // The dangerous case: three emails two years ago reads as "very quiet" to
    // any naive rule, and saying so would be a confident claim about a
    // relationship Cue knows nothing about.
    const v = assessQuiet({ key: "p", timestamps: rhythm(3, 10, 300) }, NOW);
    expect(v).toBeNull();
  });
});

describe("the two conditions, and why both", () => {
  test("a daily correspondent quiet for four days is NOT flagged", () => {
    // Ratio alone would flag this (4 > 3x1). The absolute floor is what stops
    // the list filling with people who are simply having a normal week.
    const v = assessQuiet({ key: "p", timestamps: rhythm(40, 1, 4) }, NOW);
    expect(v).toBeNull();
  });

  test("someone who writes monthly is NOT flagged at 20 days", () => {
    // Absolute alone would flag this (20 > 14). The ratio is what stops the
    // list being "everyone who writes infrequently".
    const v = assessQuiet({ key: "p", timestamps: rhythm(8, 30, 20) }, NOW);
    expect(v).toBeNull();
  });

  test("a weekly correspondent silent for a month IS flagged", () => {
    // 30 > 3x7 and 30 > 14. Both conditions, genuinely unusual for them.
    const v = assessQuiet({ key: "p", timestamps: rhythm(20, 7, 30) }, NOW);
    expect(v).not.toBeNull();
    expect(v!.medianGapDays).toBe(7);
    expect(v!.silentDays).toBe(30);
  });

  test("MUTATION CHECK: exactly at a threshold does not flag", () => {
    // Strictly-greater on both, so a boundary case never tips into a claim.
    // 3x5 = 15 days silence on a 5-day rhythm, and 15 > 14 — but the ratio is
    // exactly 3, not more than 3.
    const v = assessQuiet({ key: "p", timestamps: rhythm(30, 5, 15) }, NOW);
    expect(v).toBeNull();
  });
});

describe("ranking is by their own normal, not raw silence", () => {
  test("a big departure outranks a longer but ordinary silence", () => {
    // 'daily'  — silent 20 days against a 1-day rhythm  → ratio 20
    // 'tenday' — silent 40 days against a 10-day rhythm → ratio 4
    // Raw silence ranks tenday first and is useless; the ratio must not.
    const out = assessAllQuiet(
      [
        { key: "tenday", timestamps: rhythm(10, 10, 40) },
        { key: "daily", timestamps: rhythm(60, 1, 20) },
      ],
      NOW,
    );
    expect(out.map((v) => v.key)).toEqual(["daily", "tenday"]);
    // The point of the ordering: the top row is the SHORTER silence.
    expect(out[0]!.silentDays).toBeLessThan(out[1]!.silentDays);
  });
});

describe("the baseline window bounds the claim", () => {
  test("history older than the window cannot supply a rhythm", () => {
    // A monthly correspondent silent for 100 days has only ~3 messages inside
    // the 180-day window, so there is no baseline and no verdict — rather than
    // a confident claim built from a rhythm that ended half a year ago.
    // Ineligible, NOT merely un-flagged: the distinction is what keeps the
    // "Cue needs a rhythm" state honest.
    const candidate = { key: "monthly", timestamps: rhythm(10, 30, 100) };
    expect(assessQuiet(candidate, NOW)).toBeNull();
    expect(countEligible([candidate], NOW)).toBe(0);
  });
});

describe("the two empty states are different facts", () => {
  test("eligible people, none quiet — everyone is at their usual pace", () => {
    const candidates = [
      { key: "a", timestamps: rhythm(20, 7, 3) },
      { key: "b", timestamps: rhythm(20, 7, 5) },
    ];
    expect(assessAllQuiet(candidates, NOW)).toHaveLength(0);
    expect(countEligible(candidates, NOW)).toBe(2);
  });

  test("nobody eligible — Cue has no rhythm yet", () => {
    const candidates = [
      { key: "a", timestamps: rhythm(2, 7, 3) },
      { key: "b", timestamps: [NOW - DAY] },
    ];
    expect(assessAllQuiet(candidates, NOW)).toHaveLength(0);
    expect(countEligible(candidates, NOW)).toBe(0);
  });
});

describe("the row states its own arithmetic", () => {
  test("plural days", () => {
    const v = assessQuiet({ key: "p", timestamps: rhythm(20, 3, 19) }, NOW);
    expect(quietRowExplanation(v!)).toBe("usually every 3 days · silent 19");
  });

  test("a daily rhythm does not say 'every 1 days'", () => {
    const v = assessQuiet({ key: "p", timestamps: rhythm(60, 1, 20) }, NOW);
    expect(quietRowExplanation(v!)).toBe("usually every day · silent 20");
  });
});

describe("hostile inputs do not produce a confident claim", () => {
  test("future timestamps are ignored rather than trusted", () => {
    // A bad Date header should not make someone look freshly active.
    const t = [...rhythm(20, 7, 30), NOW + 40 * DAY];
    const v = assessQuiet({ key: "p", timestamps: t }, NOW);
    expect(v).not.toBeNull();
    expect(v!.silentDays).toBe(30);
  });

  test("NaN entries are dropped, not propagated", () => {
    const t = [...rhythm(20, 7, 30), Number.NaN];
    const v = assessQuiet({ key: "p", timestamps: t }, NOW);
    expect(v).not.toBeNull();
    expect(Number.isFinite(v!.ratio)).toBe(true);
  });

  test("simultaneous duplicates cannot divide by a zero median", () => {
    // A thread delivered as five arrivals at the same instant yields a median
    // gap of 0; returning a verdict would be an infinite ratio at the top of
    // the list.
    const same = Array.from({ length: 8 }, () => NOW - 60 * DAY);
    expect(assessQuiet({ key: "p", timestamps: same }, NOW)).toBeNull();
  });
});
