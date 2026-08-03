/**
 * The keyboard rule, as arithmetic (v25 · G3).
 *
 * Design's note names the bug in the shipped build exactly:
 *
 *   "the whole window scrolls, so the header leaves and the thread jumps.
 *    The window must never move. Only the composer position and the thread's
 *    viewport height change."
 *
 * The reason it kept being wrong is that "lift the composer above the
 * keyboard" is expressible two ways and only one of them is a layout. A
 * `translateY(-keyboardHeight)` moves the composer over the thread and leaves
 * the thread's height untouched, so the newest message ends up *behind* the
 * field; and because the shell was ALSO being resized to the visual viewport
 * (root-layout does this), the two compensations stacked and the composer flew
 * off the top of the keyboard. Nothing in the component tree said which layer
 * owned the keyboard.
 *
 * So the geometry lives here as a pure function with no DOM in it, one caller
 * (`PhoneChatFrame`), and two invariants asserted by name in its return type:
 *
 *   · `translateY` is always `0`  — the window never moves.
 *   · `headerTop` is always `0`   — the header never scrolls off.
 *
 * Everything the keyboard does, it does by taking height away from the thread.
 *
 * `simulateThread` is the other half: given a frame and a list of message
 * heights it reports where the newest message's bottom edge lands. That is the
 * test design asked for ("2-message thread AND a 200-message thread"), and it
 * is a real test rather than a snapshot because both thread sizes go through
 * the same solver the component uses.
 *
 * WKWebView note: `keyboardHeight` is supplied by the caller from
 * `visualViewport`, NOT from a window resize — under Capacitor the web view
 * frame itself resizes and `innerHeight − visualViewport.height` is ~0. See
 * `hooks/use-visible-viewport.ts`, which normalises both runtimes.
 */

/** iOS's keyboard transition. Design: "0.25s easeInOut … with the keys." */
export const KEYBOARD_CURVE = "0.25s cubic-bezier(0.42, 0, 0.58, 1)";

/** Distance from the bottom at or under which the thread counts as pinned. */
export const PINNED_THRESHOLD_PX = 64;

/**
 * Below this the delta is browser chrome / pinch drift, not a keyboard.
 * Same value the root layout uses, so the two layers agree on "open".
 */
export const KEYBOARD_OPEN_THRESHOLD_PX = 100;

/** Composer field growth: one line up to five, then it scrolls internally. */
export const COMPOSER_MAX_LINES = 5;

export interface PhoneFrameInput {
  /**
   * The shell's height with the keyboard DOWN — i.e. the layout viewport, not
   * the visual one. The frame subtracts the keyboard itself; passing an
   * already-shrunk height double-counts it (that was half the original bug).
   */
  shellHeight: number;
  /** Keyboard height in px; `0` when down. Drives "is the keyboard open". */
  keyboardHeight: number;
  /**
   * How much of the keyboard THIS element still has to reserve, which is not
   * always the keyboard's height.
   *
   * Two ancestors can legitimately have already absorbed it: the root layout
   * resizes the shell to `visualViewport.height` on mobile, and Capacitor's
   * WKWebView resizes the web view frame itself. When either has, the space
   * below us is already gone and reserving it again pushes the composer a
   * keyboard's height into the air — which is the second half of the bug this
   * module exists to end. The caller measures rather than assumes; see
   * `use-phone-keyboard.ts`.
   *
   * Defaults to `keyboardHeight` (nothing absorbed it).
   */
  keyboardOverlap?: number;
  /** The pinned header's measured height. */
  headerHeight: number;
  /** The composer block's measured height (grows with the field to 5 lines). */
  composerHeight: number;
  /** Bottom safe-area inset. Only paid while the keyboard is DOWN. */
  safeBottom?: number;
  /** Tab-bar height to reserve while the keyboard is down. */
  tabBarHeight?: number;
  /**
   * Interactive dismiss (spec 8): `0` = keyboard fully up, `1` = fully
   * dismissed. Drives the same arithmetic proportionally, which is what makes
   * the drag track the finger instead of snapping.
   */
  dismissProgress?: number;
}

export interface PhoneFrame {
  /** Always `0`. The window does not move. Kept as a field so a regression
   *  has to write a non-zero here and fail the test that reads it. */
  translateY: 0;
  /** Always `0`. The header is pinned, outside every scroller. */
  headerTop: 0;
  headerHeight: number;
  /** Top edge of the thread viewport (= header height). */
  threadTop: number;
  /** The only thing the keyboard changes: the thread's viewport height. */
  threadHeight: number;
  /** Top edge of the composer block. */
  composerTop: number;
  /**
   * Bottom inset THIS element adds so the composer sits on the keyboard. Zero
   * when an ancestor already shrank away the keyboard region — the composer is
   * against the keys either way.
   */
  composerBottomInset: number;
  /** Effective keyboard height after interactive-dismiss progress. */
  effectiveKeyboardHeight: number;
  /** Whether the keyboard counts as open (past the chrome-drift threshold). */
  keyboardOpen: boolean;
  /** Navigation hides while typing — you are not navigating (spec 4). */
  tabBarVisible: boolean;
}

function clampNonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Resolve the whole phone chat frame from the viewport and the two measured
 * chrome heights. Pure; no DOM, no window.
 */
export function resolveChatFrame(input: PhoneFrameInput): PhoneFrame {
  const {
    shellHeight,
    keyboardHeight,
    headerHeight,
    composerHeight,
    safeBottom = 0,
    tabBarHeight = 0,
    dismissProgress = 0,
  } = input;
  const keyboardOverlap = input.keyboardOverlap ?? keyboardHeight;

  const progress = Math.min(1, Math.max(0, dismissProgress));
  const effectiveKeyboardHeight =
    clampNonNegative(keyboardHeight) * (1 - progress);
  const effectiveOverlap = clampNonNegative(keyboardOverlap) * (1 - progress);
  const keyboardOpen = effectiveKeyboardHeight > KEYBOARD_OPEN_THRESHOLD_PX;

  // With the keyboard up the home indicator is behind the keys and the tab bar
  // is hidden, so neither is paid for. With it down, both are.
  const bottomChrome = keyboardOpen ? 0 : safeBottom + tabBarHeight;

  const threadHeight = clampNonNegative(
    shellHeight - headerHeight - composerHeight - effectiveOverlap - bottomChrome,
  );

  return {
    translateY: 0,
    headerTop: 0,
    headerHeight,
    threadTop: headerHeight,
    threadHeight,
    composerTop: headerHeight + threadHeight,
    composerBottomInset: effectiveOverlap,
    effectiveKeyboardHeight,
    keyboardOpen,
    tabBarVisible: !keyboardOpen,
  };
}

export interface ThreadSimInput {
  frame: PhoneFrame;
  /** Rendered height of each message, oldest first. */
  messageHeights: readonly number[];
  /** Gap between messages. */
  gap?: number;
  /** Thread padding (top and bottom). */
  paddingTop?: number;
  paddingBottom?: number;
  /**
   * Where the scroller sat before this frame. Omitted → pinned to the newest
   * message, which is the state the "type into a thread" test describes.
   */
  scrollTop?: number;
}

export interface ThreadSim {
  /** Total height of the thread's content. */
  contentHeight: number;
  /** Resulting scroll offset. */
  scrollTop: number;
  /** Top edge of the newest message, in shell coordinates. */
  newestTop: number;
  /** Bottom edge of the newest message, in shell coordinates. */
  newestBottom: number;
  /** True when the newest message is fully inside the thread viewport. */
  newestVisible: boolean;
  /** True when the thread scrolls at all (content taller than the viewport). */
  scrolls: boolean;
}

/**
 * Where does the newest message land?
 *
 * The bottom anchor (spec 2, `justify-content: flex-end` — implemented as
 * `margin-top: auto` on the content wrapper, which is the same result without
 * the flex-end overflow clipping) means a SHORT thread sits against the
 * composer rather than floating at the top, and a LONG thread pinned to the
 * bottom lands in exactly the same place. That equivalence is the whole point
 * of design's two-size test, and it is what this function reports.
 */
export function simulateThread({
  frame,
  messageHeights,
  gap = 0,
  paddingTop = 0,
  paddingBottom = 0,
  scrollTop,
}: ThreadSimInput): ThreadSim {
  const stack = messageHeights.reduce((sum, h) => sum + h, 0);
  const gaps = messageHeights.length > 1 ? gap * (messageHeights.length - 1) : 0;
  const contentHeight = paddingTop + stack + gaps + paddingBottom;

  const viewport = frame.threadHeight;
  const maxScroll = Math.max(0, contentHeight - viewport);
  const scrolls = maxScroll > 0;

  // Bottom-anchored: with content shorter than the viewport there is nothing
  // to scroll and the stack is pushed down against the composer.
  const resolvedScrollTop = scrolls
    ? Math.min(maxScroll, Math.max(0, scrollTop ?? maxScroll))
    : 0;

  const newestHeight = messageHeights.at(-1) ?? 0;
  // Distance from the top of the CONTENT box to the bottom of the last message.
  const contentBottomOfNewest = contentHeight - paddingBottom;
  // Short content is shifted down by the bottom anchor.
  const anchorShift = scrolls ? 0 : Math.max(0, viewport - contentHeight);

  const newestBottom =
    frame.threadTop + anchorShift + contentBottomOfNewest - resolvedScrollTop;
  const newestTop = newestBottom - newestHeight;

  const viewportTop = frame.threadTop;
  const viewportBottom = frame.threadTop + viewport;

  return {
    contentHeight,
    scrollTop: resolvedScrollTop,
    newestTop,
    newestBottom,
    newestVisible:
      newestBottom <= viewportBottom + 0.5 && newestTop >= viewportTop - 0.5,
    scrolls,
  };
}

export interface ScrollAnchorInput {
  prevScrollTop: number;
  prevScrollHeight: number;
  prevClientHeight: number;
  nextScrollHeight: number;
  nextClientHeight: number;
}

/**
 * Spec 6 — "scroll position is preserved". Which position, exactly, depends on
 * which way the thread's viewport moved, and the two directions are NOT
 * symmetric. Getting that wrong is what put a reader 312px up a thread they
 * had been sitting at the bottom of.
 *
 * **Shrinking** (the keyboard arriving, the composer growing to five lines):
 * the viewport's bottom edge rises through the content. To keep the same
 * messages against the composer, `scrollTop` has to increase by the shrink —
 * i.e. hold the distance from the bottom. A reader pinned to the newest message
 * stays pinned; a reader 900px up stays 900px up.
 *
 * **Growing** (the keyboard leaving): the bottom edge descends and REVEALS more
 * content — nothing has to move. `scrollTop` is already correct, and the browser
 * has already clamped it if it exceeded the new maximum, which is exactly the
 * bottom pin. Applying the shrink rule in reverse here is the bug: a pinned
 * reader's clamped `scrollTop` reads as "312px from the bottom", and holding
 * that invented gap scrolls them up by 312px on every keyboard dismissal.
 *
 * So: hold the gap on the way down, hold the offset on the way up. Neither
 * branch ever snaps a scrolled-up reader to the bottom.
 */
export function nextScrollTop({
  prevScrollTop,
  prevScrollHeight,
  prevClientHeight,
  nextScrollHeight,
  nextClientHeight,
}: ScrollAnchorInput): number {
  const prevMax = Math.max(0, prevScrollHeight - prevClientHeight);
  const nextMax = Math.max(0, nextScrollHeight - nextClientHeight);
  const scrollTop = Math.min(Math.max(0, prevScrollTop), prevMax);

  // Viewport grew (or content shrank): leave the reader where they are.
  if (nextMax <= prevMax) return Math.min(scrollTop, nextMax);

  // Viewport shrank: hold the distance from the bottom.
  const distanceFromBottom = Math.max(0, prevMax - scrollTop);
  return Math.min(nextMax, Math.max(0, nextMax - distanceFromBottom));
}

/**
 * Spec 8 — interactive dismiss. Downward drag on the thread dismisses the
 * keyboard proportionally; the keyboard is actually dismissed once the drag
 * has eaten enough of its height for the intent to be unambiguous.
 */
export const INTERACTIVE_DISMISS_COMMIT = 0.45;

export function dismissProgressForDrag(
  dragDistancePx: number,
  keyboardHeight: number,
): number {
  if (keyboardHeight <= 0) return 0;
  if (dragDistancePx <= 0) return 0;
  return Math.min(1, dragDistancePx / keyboardHeight);
}

/**
 * The textarea's height: grows to `COMPOSER_MAX_LINES`, then the field scrolls
 * internally and nothing else moves (spec 7).
 */
export function composerFieldHeight(
  scrollHeight: number,
  lineHeight: number,
  verticalPadding: number,
): number {
  const cap = lineHeight * COMPOSER_MAX_LINES + verticalPadding;
  return Math.min(Math.max(scrollHeight, lineHeight + verticalPadding), cap);
}
