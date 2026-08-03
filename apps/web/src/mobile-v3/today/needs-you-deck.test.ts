/**
 * The deck never grows — pinned, because the failure is invisible.
 *
 * A cap that quietly stopped working looks exactly like a busy morning, and a
 * cap that hides items without saying how many is the silent absence the rest
 * of this deck's rules exist to prevent. Both halves are asserted here.
 */

import { describe, expect, test } from "bun:test";

import { NEEDS_YOU_CAP } from "@/pages/hq/hq-deck";

import { capDeck, isCapped, needsYouLabel } from "./needs-you-deck";

describe("the needs-you cap", () => {
  test("is three, and is desktop's constant rather than a second copy", () => {
    // Two places for one rule is how the HQ headline came to read 6 while the
    // sidebar badge read 5, both reading real data.
    expect(NEEDS_YOU_CAP).toBe(3);
  });

  test("caps the stack at three, in the caller's order", () => {
    expect(capDeck(["paused", "move", "r1", "r2", "r3"])).toEqual([
      "paused",
      "move",
      "r1",
    ]);
  });

  test("a shorter stack is untouched", () => {
    expect(capDeck(["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("N of M", () => {
  test("says 3 of 7 once the lane holds more than it shows", () => {
    expect(needsYouLabel(7)).toBe("3 of 7");
    expect(isCapped(7)).toBe(true);
  });

  test("at or below the cap it is the bare number", () => {
    // "3 of 3" makes a complete list look truncated.
    expect(needsYouLabel(3)).toBe("3");
    expect(needsYouLabel(1)).toBe("1");
    expect(isCapped(3)).toBe(false);
  });

  test("zero is a real number and is stated out loud", () => {
    expect(needsYouLabel(0)).toBe("0");
  });

  test("a number we could not compute never renders as a fake one", () => {
    expect(needsYouLabel(Number.NaN)).toBe("0");
    expect(needsYouLabel(-1)).toBe("0");
    expect(isCapped(Number.NaN)).toBe(false);
  });
});
