import { describe, expect, test } from "bun:test";

import { shouldShowHistorySection } from "@/domains/intelligence/skills/use-skill-history.js";

/**
 * The History section's visibility rule. Three inputs collapse into one
 * boolean, and two of the combinations are easy to get wrong: an in-flight
 * read must not flash the section, and a failed read must not be mistaken for
 * an empty one.
 */

describe("shouldShowHistorySection", () => {
  test("shows the section when there are revisions", () => {
    expect(
      shouldShowHistorySection({
        isLoading: false,
        isError: false,
        revisionCount: 2,
      }),
    ).toBe(true);
  });

  test("hides the section for a skill with nothing recorded", () => {
    expect(
      shouldShowHistorySection({
        isLoading: false,
        isError: false,
        revisionCount: 0,
      }),
    ).toBe(false);
  });

  test("shows the section when the read failed, so the failure is reportable", () => {
    // An errored query also reports zero revisions. Without this branch the
    // page would render as though the skill had never been edited, hiding a
    // transient failure behind a plausible-looking empty state.
    expect(
      shouldShowHistorySection({
        isLoading: false,
        isError: true,
        revisionCount: 0,
      }),
    ).toBe(true);
  });

  test("hides the section while the read is in flight", () => {
    // Gating on the count alone would render the section, then remove it a
    // moment later when the empty result landed.
    expect(
      shouldShowHistorySection({
        isLoading: true,
        isError: false,
        revisionCount: 0,
      }),
    ).toBe(false);
  });

  test("loading wins over a stale error, so a retry does not flicker", () => {
    expect(
      shouldShowHistorySection({
        isLoading: true,
        isError: true,
        revisionCount: 0,
      }),
    ).toBe(false);
  });
});
