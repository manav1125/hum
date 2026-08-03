/**
 * Swipe-back — the escape the reach audit (v28 · K5) makes mandatory.
 *
 *   "Back chevrons and ⋯ sit top-left/right. Acceptable — they're escapes, not
 *    primaries — BUT every screen needs a swipe-back gesture so the chevron is
 *    never the only way out."
 *
 * On a 6.7" phone the top-left corner is the single hardest pixel to reach with
 * the thumb that is holding the device. A chevron there is fine as a target of
 * last resort and unacceptable as the only one, so every surface that can be
 * backed out of attaches this.
 *
 * Deliberately edge-initiated and horizontal-dominant: a gesture that starts in
 * the middle of the screen, or that is mostly vertical, belongs to the content
 * (scrolling, a swipe-to-archive row). Only a drag that begins inside the left
 * edge zone and travels mostly sideways counts, which is the same discrimination
 * UIKit's interactive pop gesture makes.
 *
 * `.light` on reveal, per the haptic map — the same weight as any other
 * selection. Never `.medium`: going back commits nothing.
 */
import { useEffect } from "react";

import { haptic } from "@/utils/haptics";

/** How far in from the left edge a back gesture may start. */
export const SWIPE_BACK_EDGE_PX = 28;
/** How far it must travel before it counts. */
export const SWIPE_BACK_COMMIT_PX = 64;
/** Horizontal travel must beat vertical by this factor — otherwise it's a scroll. */
export const SWIPE_BACK_AXIS_RATIO = 1.6;

export interface SwipeSample {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

/**
 * Does this drag mean "go back"? Pure, so the discrimination is testable
 * without a touch device.
 */
export function isSwipeBack(sample: SwipeSample): boolean {
  const dx = sample.endX - sample.startX;
  const dy = Math.abs(sample.endY - sample.startY);
  if (sample.startX > SWIPE_BACK_EDGE_PX) return false;
  if (dx < SWIPE_BACK_COMMIT_PX) return false;
  return dx > dy * SWIPE_BACK_AXIS_RATIO;
}

/**
 * Attach a left-edge swipe-back to an element.
 *
 * `onBack` may be null — a screen with nowhere to go back to attaches nothing
 * rather than swallowing the gesture.
 */
export function useSwipeBack(
  target: React.RefObject<HTMLElement | null>,
  onBack: (() => void) | null,
): void {
  useEffect(() => {
    const node = target.current;
    if (!node || !onBack) return;

    let start: { x: number; y: number } | null = null;

    const onStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      start = { x: touch.clientX, y: touch.clientY };
    };
    const onEnd = (e: TouchEvent) => {
      const from = start;
      start = null;
      const touch = e.changedTouches[0];
      if (!from || !touch) return;
      if (
        !isSwipeBack({
          startX: from.x,
          startY: from.y,
          endX: touch.clientX,
          endY: touch.clientY,
        })
      )
        return;
      void haptic.light();
      onBack();
    };

    node.addEventListener("touchstart", onStart, { passive: true });
    node.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      node.removeEventListener("touchstart", onStart);
      node.removeEventListener("touchend", onEnd);
    };
  }, [target, onBack]);
}
