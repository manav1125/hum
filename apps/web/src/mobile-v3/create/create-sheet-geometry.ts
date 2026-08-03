/**
 * Mobile v3 Create — the sheet's height arithmetic, kept away from React.
 *
 * The detent heights and the peek fit live here rather than in
 * `create-detent-sheet.tsx` so they can be checked against the numbers measured
 * on a real phone. happy-dom has no layout engine, so a test cannot lay the
 * sheet out; what it can do is feed the arithmetic the boxes the device
 * actually produced and assert the height that comes back.
 */

/** The two snap points, as a fraction of the containing block's height. */
export const PEEK_DETENT = 0.42;
export const FULL_DETENT = 0.94;

/** One measurement of a settled peek sheet. All px. */
export interface PeekFitMeasurement {
  /** The containing block — viewport, or the frame inside a phone wrapper. */
  viewportH: number;
  /** The sheet's own current height. */
  sheetH: number;
  /** The scroller's viewport height. */
  bodyClientH: number;
  /** The scroller's content height. */
  bodyScrollH: number;
}

/**
 * The height the peek detent needs in order to show the peek stage whole.
 *
 * 42% is a floor, not a height. The entry's chrome does not scale with the
 * viewport — the grab strip and the footer (composer + rescue + safe area) come
 * to a fixed 188px — so a fixed fraction hands the scroller whatever is left
 * over, and on a 393×852 phone that was 170px for 271px of content. Measured
 * there: the two type cards were laid out 606→718 inside a scroller ending at
 * 688, so their bottom 30px — the rounded edge, the "N templates" count and the
 * foot of the name — were clipped, and the composer began at exactly 688, so
 * the clip read as the input cutting the cards off. Below them the "+4 more
 * types" row (729→771) was outside the sheet entirely, which is why the screen
 * also read as "these two are all there is". That is the "create is showing a
 * cut off screen" report.
 *
 * It is a different fault from the one `.mv3c-flow` had. Nothing here is
 * painted outside the sheet and the scroller's origin is reachable; the peek
 * simply is not tall enough for what peek is for, and no scroll cue says so.
 *
 * So the peek is measured rather than assumed: chrome (`sheetH - bodyClientH`)
 * plus content (`bodyScrollH`), floored at 42% so a short stage cannot collapse
 * and capped at the full detent so a long one still scrolls rather than
 * swallowing the screen behind it.
 *
 * Two properties make this safe to run on every render:
 *
 * - It is a fixpoint. Grow the sheet and `bodyClientH` grows by the same
 *   amount, so `chrome` is unchanged and the result stops moving the moment the
 *   content fits.
 * - It is invariant under the height transition, because `sheetH` and
 *   `bodyClientH` animate together and only their difference is read.
 */
export function fittedPeekHeight(m: PeekFitMeasurement): number {
  const floor = PEEK_DETENT * m.viewportH;
  const ceiling = FULL_DETENT * m.viewportH;
  // Before layout there is nothing to fit to; the floor is the honest answer.
  if (m.bodyClientH <= 0 || m.sheetH <= 0) return floor;
  const chrome = m.sheetH - m.bodyClientH;
  return Math.min(ceiling, Math.max(floor, chrome + m.bodyScrollH));
}
