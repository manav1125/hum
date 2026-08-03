/**
 * The deck never grows.
 *
 * "Needs you" caps at three and says `N of M` — one of the invariants that is
 * true on every screen, and the only one whose violation is invisible in a
 * screenshot of a quiet account. A deck that grows with the backlog stops being
 * a deck; it becomes the backlog with rounded corners, and the point of the
 * surface is that it can be answered in one sitting.
 *
 * Two decisions worth stating, because both have been got wrong here before:
 *
 * **The cap is desktop's constant, imported.** `NEEDS_YOU_CAP` lives in
 * `@/pages/hq/hq-deck`. A phone-local `3` would be a second place for the rule
 * to live, and the two would eventually disagree in front of the owner — which
 * is the same failure mode that made the HQ headline read 6 while the sidebar
 * badge read 5, both reading real data that measured different things.
 *
 * **The total is `glanceCount`, never a length.** HqPage computes the needs-you
 * number once and hands it to both surfaces, so the badge, the headline and the
 * rows are provably the same set. Counting the cards this screen happens to
 * have built would re-derive it, and re-deriving it is exactly how they came to
 * disagree.
 */

import { NEEDS_YOU_CAP } from "@/pages/hq/hq-deck";

export { NEEDS_YOU_CAP };

/**
 * What the lane header says after "‖ Needs you · ".
 *
 * Below the cap it is the bare number, because "3 of 3" makes a complete list
 * look truncated. Above it, `N of M` always — a hidden item must never be a
 * silent one.
 */
export function needsYouLabel(
  glanceCount: number,
  cap: number = NEEDS_YOU_CAP,
): string {
  if (!Number.isFinite(glanceCount) || glanceCount < 0) return "0";
  return glanceCount > cap ? `${cap} of ${glanceCount}` : String(glanceCount);
}

/** True when the lane is holding more than it is showing. */
export function isCapped(
  glanceCount: number,
  cap: number = NEEDS_YOU_CAP,
): boolean {
  return Number.isFinite(glanceCount) && glanceCount > cap;
}

/**
 * Take the first `cap` cards, in the order the caller stacked them.
 *
 * The caller's order is load-bearing: paused runs sort above everything, since
 * unlike a draft awaiting review, NOTHING continues until they are answered. A
 * cap applied to a badly ordered list quietly hides the one card that stops a
 * run.
 */
export function capDeck<T>(
  items: readonly T[],
  cap: number = NEEDS_YOU_CAP,
): T[] {
  return items.slice(0, Math.max(0, cap));
}
