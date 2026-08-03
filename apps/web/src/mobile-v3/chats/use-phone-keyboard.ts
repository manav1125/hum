/**
 * The measured half of the keyboard rule (v25 · G3).
 *
 * `phone-keyboard.ts` holds the arithmetic; this holds the observations that
 * feed it. Three things are observed rather than assumed, each because
 * assuming it is a bug that has already shipped:
 *
 * 1. **Keyboard height comes from `visualViewport`, not from a resize.** This
 *    is a Capacitor WKWebView: the web view frame is resized under the
 *    keyboard, so `window.innerHeight − visualViewport.height` is ~0 while the
 *    keyboard is plainly up. `useVisibleViewport` already normalises Safari and
 *    WKWebView against a max-observed reference; we reuse it rather than
 *    re-deriving it wrongly.
 *
 * 2. **How much of the keyboard is still ours to reserve is measured.** The
 *    root layout shrinks the shell to the visual viewport on mobile, so by the
 *    time the chat screen renders, the keyboard's space is usually already
 *    gone. Reserving it a second time is what threw the composer into the air.
 *    We compare our own element against the visible region and reserve only the
 *    difference — so this works whether or not an ancestor got there first, and
 *    keeps working if one changes.
 *
 * 3. **The chrome heights are measured, not constants.** The header compacts,
 *    the composer grows to five lines, attachment strips and the live-activity
 *    block come and go. A hard-coded 56px is a thread that is 20px wrong all day.
 *
 * The hook returns a `PhoneFrame` plus the refs to attach. It never scrolls
 * anything and never sets a transform.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { readVisibleViewport } from "@/hooks/use-visible-viewport";

import {
  dismissProgressForDrag,
  INTERACTIVE_DISMISS_COMMIT,
  resolveChatFrame,
  type PhoneFrame,
} from "./phone-keyboard";

/** Tolerance when asking "is my box already clear of the keyboard?" */
const CLEAR_TOLERANCE_PX = 4;

/** A downward drag under this is a scroll, not a dismissal. */
const DRAG_SLOP_PX = 8;

export interface PhoneKeyboardOptions {
  /** Height to reserve for the tab bar while the keyboard is down. */
  tabBarHeight?: number;
  /** Bottom safe-area inset in px, when the caller has resolved one. */
  safeBottom?: number;
  /** Called when an interactive drag has committed to dismissing (spec 8). */
  onDismiss?: () => void;
}

export interface PhoneKeyboardState {
  frame: PhoneFrame;
  /** Attach to the screen's outermost element — the box being divided up. */
  shellRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to the pinned header. */
  headerRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to the composer block. */
  composerRef: React.RefObject<HTMLDivElement | null>;
  /** Touch handlers for interactive dismiss; spread onto the thread. */
  dragHandlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: () => void;
  };
}

interface Measured {
  shellHeight: number;
  headerHeight: number;
  composerHeight: number;
  keyboardHeight: number;
  keyboardOverlap: number;
}

const EMPTY: Measured = {
  shellHeight: 0,
  headerHeight: 0,
  composerHeight: 0,
  keyboardHeight: 0,
  keyboardOverlap: 0,
};

export function usePhoneKeyboard(
  options: PhoneKeyboardOptions = {},
): PhoneKeyboardState {
  const { tabBarHeight = 0, safeBottom = 0, onDismiss } = options;

  const shellRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);

  const [measured, setMeasured] = useState<Measured>(EMPTY);
  const [dismissProgress, setDismissProgress] = useState(0);
  const pendingTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  /**
   * @param allowOverlap Whether this pass may adopt a NON-ZERO overlap.
   *
   * The overlap answers "did an ancestor already take the keyboard's space
   * away from me?", and it is answered by comparing our box to the visible
   * region. Both sides of that comparison move during a keyboard transition,
   * and they do not move in the same tick: the root layout resizes the shell
   * from its own React state, so a listener that measures synchronously on the
   * viewport event reads a shell that has not shrunk yet, concludes the whole
   * keyboard is still ours, and reserves it a second time. Observed in the real
   * app: `padding-bottom: 336px` on a shell that was already only 508px tall —
   * thread height zero, composer hanging off the bottom.
   *
   * So a synchronous pass may only ever LOWER the reservation to zero, and a
   * non-zero one is adopted from a settled pass. The transient is then "the
   * composer has not lifted yet for a frame", which is invisible, instead of
   * "the layout has collapsed", which is not.
   */
  const measure = useCallback((allowOverlap = false) => {
    const shell = shellRef.current;
    if (!shell) return;
    const viewport = readVisibleViewport();
    const keyboardHeight = viewport?.keyboardHeight ?? 0;

    // The shell's own box. `getBoundingClientRect().height` rather than
    // clientHeight so a fractional device-pixel height doesn't round the
    // thread into a 1px scroll.
    const shellRect = shell.getBoundingClientRect();
    const shellHeight = shellRect.height;

    // How much of the keyboard still overlaps US. If an ancestor already
    // shrank the shell to the visible viewport, our box ends above the keys
    // and there is nothing left to reserve.
    const visibleBottom = viewport
      ? viewport.height + viewport.offsetTop
      : shellRect.bottom;
    const keyboardOverlap =
      keyboardHeight > 0
        ? Math.max(0, Math.min(keyboardHeight, shellRect.bottom - visibleBottom))
        : 0;

    setMeasured((prev) => {
      const next: Measured = {
        // `shellHeight` must be the box WITH the keyboard's space still in it,
        // because `resolveChatFrame` subtracts the overlap itself. When an
        // ancestor already removed it, overlap is 0 and this is already right.
        shellHeight,
        headerHeight: headerRef.current?.getBoundingClientRect().height ?? 0,
        composerHeight: composerRef.current?.getBoundingClientRect().height ?? 0,
        keyboardHeight,
        keyboardOverlap:
          allowOverlap && keyboardOverlap > CLEAR_TOLERANCE_PX
            ? keyboardOverlap
            : 0,
      };
      // Avoid a render per sub-pixel jitter during the keyboard animation.
      const same =
        Math.abs(prev.shellHeight - next.shellHeight) < 0.5 &&
        Math.abs(prev.headerHeight - next.headerHeight) < 0.5 &&
        Math.abs(prev.composerHeight - next.composerHeight) < 0.5 &&
        Math.abs(prev.keyboardHeight - next.keyboardHeight) < 0.5 &&
        Math.abs(prev.keyboardOverlap - next.keyboardOverlap) < 0.5;
      return same ? prev : next;
    });
  }, []);

  /**
   * Measure now, then again once the layout has settled.
   *
   * The settled passes ride `setTimeout`, not only `requestAnimationFrame`: a
   * document that is not being painted (an inactive tab, a headless or offscreen
   * embedder) delivers neither rAF nor ResizeObserver callbacks, and a layout
   * rule that quietly stops converging in those environments is a layout rule
   * that cannot be verified anywhere but a device. Timers still fire. The extra
   * passes are free — the state setter returns the previous object when nothing
   * moved, so a no-op measurement costs no render.
   *
   * The 0ms pass catches React having committed the root layout's own resize;
   * the ~140ms pass covers the tail of the keyboard's animation curve.
   */
  const measureNow = useCallback(() => {
    measure(false);
    const settle = () => measure(true);
    const t0 = setTimeout(settle, 0);
    const t1 = setTimeout(settle, 140);
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(settle);
    }
    pendingTimers.current.push(t0, t1);
  }, [measure]);

  useEffect(() => {
    measureNow();
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    // `resize` covers the keyboard's height; `scroll` covers iOS shifting the
    // visual viewport up. iOS commonly fires one without the other during a
    // single keyboard transition, so both are needed.
    vv?.addEventListener("resize", measureNow);
    vv?.addEventListener("scroll", measureNow);
    window.addEventListener("resize", measureNow);
    window.addEventListener("orientationchange", measureNow);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      // Chrome heights (header compacting, composer growing to five lines,
      // a dock row appearing) are settled by the time the observer fires, so
      // these passes may adopt an overlap.
      observer = new ResizeObserver(() => measure(true));
      for (const el of [shellRef.current, headerRef.current, composerRef.current]) {
        if (el) observer.observe(el);
      }
    }
    return () => {
      for (const t of pendingTimers.current) clearTimeout(t);
      pendingTimers.current = [];
      vv?.removeEventListener("resize", measureNow);
      vv?.removeEventListener("scroll", measureNow);
      window.removeEventListener("resize", measureNow);
      window.removeEventListener("orientationchange", measureNow);
      observer?.disconnect();
    };
  }, [measure, measureNow]);

  // The keyboard going away ends any drag-in-progress; otherwise a committed
  // drag would leave `dismissProgress` pinned at 1 and shrink the next frame.
  useEffect(() => {
    if (measured.keyboardHeight === 0 && dismissProgress !== 0) {
      setDismissProgress(0);
    }
  }, [measured.keyboardHeight, dismissProgress]);

  // ── Interactive dismiss (spec 8): drag the thread down and the keyboard
  // follows the finger. Only from a thread already at its bottom — otherwise
  // the gesture is a scroll and belongs to the scroller.
  const drag = useRef<{ startY: number; armed: boolean } | null>(null);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (measured.keyboardHeight <= 0) return;
      const touch = e.touches[0];
      if (!touch) return;
      const target = e.currentTarget as HTMLElement;
      const scroller = target.querySelector<HTMLElement>("[data-phone-thread-scroller]")
        ?? target;
      const atBottom =
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 2;
      drag.current = { startY: touch.clientY, armed: atBottom };
    },
    [measured.keyboardHeight],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const state = drag.current;
      if (!state?.armed || measured.keyboardHeight <= 0) return;
      const touch = e.touches[0];
      if (!touch) return;
      const distance = touch.clientY - state.startY - DRAG_SLOP_PX;
      setDismissProgress(
        dismissProgressForDrag(distance, measured.keyboardHeight),
      );
    },
    [measured.keyboardHeight],
  );

  const onTouchEnd = useCallback(() => {
    const committed = dismissProgress >= INTERACTIVE_DISMISS_COMMIT;
    drag.current = null;
    if (committed) {
      onDismiss?.();
      // Leave progress where it is: the real keyboard is on its way out and
      // the `keyboardHeight === 0` effect above resets it. Snapping to 0 here
      // would spring the composer back down for one frame.
      return;
    }
    setDismissProgress(0);
  }, [dismissProgress, onDismiss]);

  const frame = resolveChatFrame({
    shellHeight: measured.shellHeight,
    keyboardHeight: measured.keyboardHeight,
    keyboardOverlap: measured.keyboardOverlap,
    headerHeight: measured.headerHeight,
    composerHeight: measured.composerHeight,
    safeBottom,
    tabBarHeight,
    dismissProgress,
  });

  return {
    frame,
    shellRef,
    headerRef,
    composerRef,
    dragHandlers: { onTouchStart, onTouchMove, onTouchEnd },
  };
}
