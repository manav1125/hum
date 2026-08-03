/**
 * Mobile v3 — swipe-back for a pushed stage.
 *
 * Design §6: *"Back chevrons and ⋯ may sit top-side as escapes — provided every
 * screen has swipe-back, so the chevron is never the only way out."* A top-left
 * chevron on a 390×844 phone sits well outside the thumb arc, so without this
 * the only exit from a pushed Create stage would be unreachable one-handed.
 *
 * There is no swipe-back anywhere in mobile-v3 today, so this is new. It follows
 * the gesture rules already proven in `swipe-archive-row.tsx`:
 *
 * - **Decide once.** The axis is locked on the first move past the threshold and
 *   held for the rest of the gesture. Re-testing `|dy| > |dx|` every move is what
 *   made the archive row freeze on a noisy diagonal.
 * - **Capture on the element**, not the event target, so a drag that leaves the
 *   child still reports to us.
 * - **Edge-anchored.** Only gestures starting near the leading edge count, so a
 *   horizontal scroll inside the stage isn't stolen.
 *
 * Returns handlers to spread onto the stage element plus the live drag offset,
 * so the caller can translate the screen and make the gesture feel attached
 * rather than firing at the end.
 */

import { useCallback, useRef, useState } from "react";

import { haptic } from "@/utils/haptics";
import { isPointerCoarse } from "@/utils/pointer";

/** Gestures must start within this many px of the leading edge. */
const EDGE_PX = 28;
/** Movement under this is not yet a gesture. */
const LOCK_PX = 8;
/** Past this, releasing commits the back navigation. */
const COMMIT_PX = 72;

export interface SwipeBackResult {
  /** Live horizontal offset, for `transform: translateX(...)`. */
  offset: number;
  /** True while a back gesture is in flight — suppress the height transition. */
  dragging: boolean;
  handlers: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
  };
}

/**
 * @param onBack Fired once, when a gesture commits.
 * @param enabled Pass false on the root stage, which has nothing to go back to.
 */
export function useSwipeBack(onBack: () => void, enabled = true): SwipeBackResult {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const state = useRef<{ x: number; y: number; axis: "none" | "x" | "y" } | null>(
    null,
  );

  const reset = useCallback(() => {
    state.current = null;
    setOffset(0);
    setDragging(false);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // Gate on the POINTER, not the viewport: a narrow desktop window is not a
      // phone, and a mouse has no swipe-back.
      if (!enabled || !isPointerCoarse()) return;
      const bounds = e.currentTarget.getBoundingClientRect();
      if (e.clientX - bounds.left > EDGE_PX) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      state.current = { x: e.clientX, y: e.clientY, axis: "none" };
    },
    [enabled],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const s = state.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;

    // Lock the axis exactly once, then honour it for the whole gesture.
    if (s.axis === "none") {
      if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return;
      s.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (s.axis === "x") setDragging(true);
    }
    if (s.axis !== "x") return;
    setOffset(Math.max(0, dx));
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const s = state.current;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      const committed = s?.axis === "x" && offset >= COMMIT_PX;
      reset();
      if (committed) {
        // .light on swipe-reveal — never on scroll, never on appear.
        haptic.light();
        onBack();
      }
    },
    [offset, onBack, reset],
  );

  return {
    offset,
    dragging,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: () => reset(),
    },
  };
}
