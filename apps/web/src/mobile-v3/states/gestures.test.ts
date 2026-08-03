/**
 * The two gestures the reach audit (K5) turns into requirements.
 *
 * Both are pure discriminators because the failure mode is the same for each:
 * a gesture that fires too readily eats a scroll, and one that fires too rarely
 * leaves the top-corner chevron as the only way out. The boundaries are the
 * whole design, so the boundaries are what is asserted.
 */
import { describe, expect, test } from "bun:test";

import { isPullDownForSearch, PULL_SEARCH_THRESHOLD_PX } from "./pull-search";
import {
  isSwipeBack,
  SWIPE_BACK_COMMIT_PX,
  SWIPE_BACK_EDGE_PX,
} from "./swipe-back";

describe("swipe-back — so a chevron is never the only way out", () => {
  test("a decisive drag from the left edge goes back", () => {
    expect(
      isSwipeBack({ startX: 6, startY: 400, endX: 140, endY: 410 }),
    ).toBe(true);
  });

  test("a drag that starts mid-screen belongs to the content", () => {
    expect(
      isSwipeBack({ startX: 200, startY: 400, endX: 340, endY: 400 }),
    ).toBe(false);
  });

  test("a mostly-vertical drag is a scroll, not a back", () => {
    expect(
      isSwipeBack({ startX: 6, startY: 200, endX: 90, endY: 520 }),
    ).toBe(false);
  });

  test("a nudge is not a commitment", () => {
    expect(
      isSwipeBack({
        startX: 4,
        startY: 400,
        endX: 4 + SWIPE_BACK_COMMIT_PX - 1,
        endY: 400,
      }),
    ).toBe(false);
  });

  test("the edge zone is a zone, not a pixel", () => {
    expect(
      isSwipeBack({
        startX: SWIPE_BACK_EDGE_PX,
        startY: 300,
        endX: SWIPE_BACK_EDGE_PX + 120,
        endY: 300,
      }),
    ).toBe(true);
    expect(
      isSwipeBack({
        startX: SWIPE_BACK_EDGE_PX + 1,
        startY: 300,
        endX: SWIPE_BACK_EDGE_PX + 121,
        endY: 300,
      }),
    ).toBe(false);
  });

  test("a rightward drag is back; a leftward one is not", () => {
    expect(isSwipeBack({ startX: 6, startY: 300, endX: -80, endY: 300 })).toBe(
      false,
    );
  });
});

describe("pull down from any screen to search", () => {
  test("a long pull from an unscrolled top opens it", () => {
    expect(
      isPullDownForSearch({
        startY: 60,
        endY: 60 + PULL_SEARCH_THRESHOLD_PX,
        deltaX: 4,
        scrollTop: 0,
      }),
    ).toBe(true);
  });

  test("a pull on a scrolled surface is a scroll — search never steals it", () => {
    expect(
      isPullDownForSearch({
        startY: 60,
        endY: 400,
        deltaX: 0,
        scrollTop: 220,
      }),
    ).toBe(false);
  });

  test("a short tug is not enough", () => {
    expect(
      isPullDownForSearch({
        startY: 60,
        endY: 60 + PULL_SEARCH_THRESHOLD_PX - 1,
        deltaX: 0,
        scrollTop: 0,
      }),
    ).toBe(false);
  });

  test("a diagonal swipe belongs to whatever it was swiping", () => {
    expect(
      isPullDownForSearch({
        startY: 60,
        endY: 200,
        deltaX: 180,
        scrollTop: 0,
      }),
    ).toBe(false);
  });

  test("an upward drag never opens search", () => {
    expect(
      isPullDownForSearch({ startY: 400, endY: 60, deltaX: 0, scrollTop: 0 }),
    ).toBe(false);
  });
});
