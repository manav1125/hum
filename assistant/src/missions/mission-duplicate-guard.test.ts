/**
 * A mission must not re-plan work it has already done.
 *
 * Production did exactly that. These two were planned three weeks apart, into
 * the same project, and are the same piece of work:
 *
 *   2026-08-10  "Review Ghita's shared folders and prepare summary of key
 *                documents for AEF Fund"          → ran, then awaiting_review
 *   2026-08-30  "Review Ghita's shared folders and prepare a concise summary
 *                of key documents for AEF Fund"   → queued, and charged for
 *
 * Two things made it possible. The planner is told "do NOT re-plan these" over
 * a list capped at 20 while the mission had 35 open items, so the first item
 * was invisible to the instruction. And `awaiting_review` work shows no
 * result, so from the planner's side finished-but-unreviewed reads as
 * never-started.
 *
 * The titles differ by two words, so an equality check would have missed it.
 * That is why the guard is a similarity.
 */

import { describe, expect, test } from "bun:test";

import { titleOverlap } from "./mission-orchestrator.js";

const AUG_10 =
  "Review Ghita's shared folders and prepare summary of key documents for AEF Fund";
const AUG_30 =
  "Review Ghita's shared folders and prepare a concise summary of key documents for AEF Fund";

describe("duplicate-work detection", () => {
  test("the real production pair scores as the same work", () => {
    // The case that motivated the guard. Must clear the 0.8 threshold.
    expect(titleOverlap(AUG_10, AUG_30)).toBeGreaterThanOrEqual(0.8);
  });

  test("an identical title is a perfect match", () => {
    expect(titleOverlap(AUG_10, AUG_10)).toBe(1);
  });

  test("punctuation and case do not affect the verdict", () => {
    expect(
      titleOverlap(
        "Send the FCNR notification",
        "send THE fcnr, notification!",
      ),
    ).toBe(1);
  });

  test("genuinely different work stays well clear of the threshold", () => {
    // The false-positive risk. Skipping a real task because it shares a verb
    // with another is worse than the duplication being fixed.
    const pairs: Array<[string, string]> = [
      [
        "Review Ghita's shared folders for AEF Fund",
        "Review the Rasmal partnership draft",
      ],
      [
        "Draft investor outreach for the seed round",
        "Pay the Boxlab settlement invoices",
      ],
      ["Plan Monday from calendar and inbox", "Track shipment for order 16976"],
    ];
    for (const [a, b] of pairs) {
      expect(titleOverlap(a, b)).toBeLessThan(0.8);
    }
  });

  test("same verb, different object is NOT a duplicate", () => {
    // The sharpest false-positive case: both start "Review the ... draft".
    expect(
      titleOverlap(
        "Review the Rasmal partnership draft",
        "Review the Blockwee vendor draft",
      ),
    ).toBeLessThan(0.8);
  });

  test("an empty or stopword-only title never matches anything", () => {
    // Otherwise two contentless titles would collide and silently suppress
    // a real item.
    expect(titleOverlap("", AUG_10)).toBe(0);
    expect(titleOverlap("the and of for", "a to in on")).toBe(0);
  });
});
