import { describe, expect, test } from "bun:test";

import { composeTurnActivityLabel } from "../turn-activity-label.js";

describe("composeTurnActivityLabel", () => {
  test("returns the label the model wrote", () => {
    expect(
      composeTurnActivityLabel({
        command: "ls ~/Downloads",
        activity: "Counting the files in Downloads",
      }),
    ).toBe("Counting the files in Downloads");
  });

  test("falls back to the reason field", () => {
    expect(composeTurnActivityLabel({ reason: "Checking the invoice" })).toBe(
      "Checking the invoice",
    );
  });

  test("prefers activity over reason when both are present", () => {
    expect(
      composeTurnActivityLabel({
        activity: "Reading your calendar",
        reason: "because you asked",
      }),
    ).toBe("Reading your calendar");
  });

  test("invents nothing when the model declared nothing", () => {
    // The whole point: no label is a truthful answer, a derived one is not.
    expect(composeTurnActivityLabel({ command: "ls" })).toBeUndefined();
    expect(composeTurnActivityLabel({})).toBeUndefined();
    expect(composeTurnActivityLabel(undefined)).toBeUndefined();
  });

  test("treats a blank or non-string label as no label", () => {
    expect(composeTurnActivityLabel({ activity: "   " })).toBeUndefined();
    expect(composeTurnActivityLabel({ activity: 42 })).toBeUndefined();
    expect(composeTurnActivityLabel({ activity: null })).toBeUndefined();
  });

  test("trims surrounding whitespace", () => {
    expect(composeTurnActivityLabel({ activity: "  Booking it  " })).toBe(
      "Booking it",
    );
  });

  test("redacts a credential the model echoed into its own status line", () => {
    // A lock screen renders this to whoever is looking at the phone.
    const fakeToken = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8".slice(0, 36)}`;
    const label = composeTurnActivityLabel({
      activity: `Pushing with ${fakeToken}`,
    });
    expect(label).toBeDefined();
    expect(label).not.toContain(fakeToken);
    expect(label).toContain("redacted");
  });

  test("caps a long label on a word boundary", () => {
    const label = composeTurnActivityLabel({
      activity:
        "Going through every single message in the inbox to work out which ones actually need a reply today",
    });
    expect(label).toBeDefined();
    expect(label!.length).toBeLessThanOrEqual(80);
    expect(label!.endsWith("…")).toBe(true);
    expect(label!.startsWith("Going through every single message")).toBe(true);
    // Cut between words: the last kept word is whole, not severed.
    const kept = label!.slice(0, -1);
    expect(
      "Going through every single message in the inbox to work out which ones actually need a reply today".startsWith(
        `${kept} `,
      ),
    ).toBe(true);
  });

  test("caps a single unbroken token without a word boundary to fall back on", () => {
    const label = composeTurnActivityLabel({ activity: "x".repeat(200) });
    expect(label).toBeDefined();
    expect(label!.length).toBeLessThanOrEqual(80);
    expect(label!.endsWith("…")).toBe(true);
  });

  test("leaves a label at the cap untouched", () => {
    const exact = "a".repeat(80);
    expect(composeTurnActivityLabel({ activity: exact })).toBe(exact);
  });
});
