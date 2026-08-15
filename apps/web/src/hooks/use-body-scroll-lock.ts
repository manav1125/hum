/**
 * The single owner of `document.body.style.overflow` while an overlay is open.
 *
 * Every overlay that needs the page behind it to stop scrolling — drawers,
 * modals, sheets — locks through here rather than touching `body.style`
 * itself. The reason is that the naive per-overlay version does not compose:
 * each overlay saves the overflow value it found on open and restores it on
 * close, so the SECOND overlay to open saves `"hidden"` — the first overlay's
 * lock — as the value it will one day restore. Close them out of order (open a
 * modal over a drawer, dismiss the drawer first) and the page is left
 * permanently unscrollable, with no way back but a reload.
 *
 * A refcount fixes it: the first lock captures the pre-lock value and applies
 * `hidden`, nested locks only increment, and the value is restored exactly
 * once, when the last holder releases. Overlays may then open, nest, and close
 * in any order.
 */

import { useEffect } from "react";

let lockCount = 0;
/** The page's own overflow value, captured by the first holder only. */
let restoreValue = "";

function acquire(): void {
  if (lockCount === 0) {
    restoreValue = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  lockCount += 1;
}

function release(): void {
  if (lockCount === 0) return;
  lockCount -= 1;
  if (lockCount === 0) {
    document.body.style.overflow = restoreValue;
    restoreValue = "";
  }
}

/**
 * Lock body scrolling for as long as `locked` is true and this component is
 * mounted. Safe to nest with any other caller of this hook.
 *
 * Pass the overlay's own open state; components that mount only while open can
 * pass `true`.
 */
export function useBodyScrollLock(locked: boolean): void {
  useEffect(() => {
    if (!locked) return;
    acquire();
    return release;
  }, [locked]);
}

/** Test-only: drop all outstanding locks so suites start from a clean body. */
export function __resetBodyScrollLockForTesting(): void {
  lockCount = 0;
  restoreValue = "";
  document.body.style.overflow = "";
}
