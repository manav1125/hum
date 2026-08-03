/**
 * The test design named, written as an actual test.
 *
 *   "type in a 2-message thread AND a 200-message thread. In both, the newest
 *    message must be visible above the composer and the header must not move.
 *    If either scrolls, it's the bug."
 *
 * Both thread sizes run through the same solver the frame uses, at a real
 * 390×844 with a real 336px iOS keyboard, in both keyboard states. The two
 * sizes exercise genuinely different branches — under 2 messages the thread
 * does not scroll at all and the bottom anchor is doing the work; at 200 the
 * scroller is doing it — which is exactly why design asked for both.
 */

import { describe, expect, test } from "bun:test";

import {
  COMPOSER_MAX_LINES,
  composerFieldHeight,
  dismissProgressForDrag,
  INTERACTIVE_DISMISS_COMMIT,
  nextScrollTop,
  PINNED_THRESHOLD_PX,
  resolveChatFrame,
  simulateThread,
} from "./phone-keyboard";

/** iPhone 14/15 portrait, the size design drew at. */
const SHELL = 844;
/** iOS QWERTY with the predictive bar, portrait. */
const KEYBOARD = 336;
const HEADER = 58;
const COMPOSER = 64;
const SAFE_BOTTOM = 34;

const GAP = 8;
const PAD = 12;

function thread(count: number): number[] {
  // Alternating short user turn / taller assistant answer, as in C5.
  return Array.from({ length: count }, (_, i) => (i % 2 === 0 ? 38 : 74));
}

function frameFor(keyboardHeight: number, composerHeight = COMPOSER) {
  return resolveChatFrame({
    shellHeight: SHELL,
    keyboardHeight,
    headerHeight: HEADER,
    composerHeight,
    safeBottom: SAFE_BOTTOM,
  });
}

describe("the keyboard rule — 2 messages and 200 messages", () => {
  for (const count of [2, 200]) {
    describe(`${count}-message thread`, () => {
      test("the header does not move when the keyboard comes up", () => {
        const down = frameFor(0);
        const up = frameFor(KEYBOARD);
        expect(down.headerTop).toBe(0);
        expect(up.headerTop).toBe(0);
        expect(up.headerHeight).toBe(down.headerHeight);
        expect(up.threadTop).toBe(down.threadTop);
      });

      test("the window never translates", () => {
        expect(frameFor(0).translateY).toBe(0);
        expect(frameFor(KEYBOARD).translateY).toBe(0);
        // Mid-drag, too — interactive dismiss moves the keyboard, not the page.
        expect(
          resolveChatFrame({
            shellHeight: SHELL,
            keyboardHeight: KEYBOARD,
            headerHeight: HEADER,
            composerHeight: COMPOSER,
            dismissProgress: 0.5,
          }).translateY,
        ).toBe(0);
      });

      test("the newest message stays visible above the composer", () => {
        for (const keyboard of [0, KEYBOARD]) {
          const frame = frameFor(keyboard);
          const sim = simulateThread({
            frame,
            messageHeights: thread(count),
            gap: GAP,
            paddingTop: PAD,
            paddingBottom: PAD,
          });
          expect(sim.newestVisible).toBe(true);
          // "Above the composer" is the load-bearing half: the bug shipped a
          // newest message sitting BEHIND the lifted composer.
          expect(sim.newestBottom).toBeLessThanOrEqual(frame.composerTop);
        }
      });

      test("only the thread's height changes; the chrome is untouched", () => {
        const down = frameFor(0);
        const up = frameFor(KEYBOARD);
        expect(down.threadHeight - up.threadHeight).toBe(
          // The keyboard's height, less the home indicator it now covers.
          KEYBOARD - SAFE_BOTTOM,
        );
        expect(up.composerTop + COMPOSER + up.composerBottomInset).toBe(SHELL);
      });
    });
  }

  test("2 messages sit against the composer instead of floating at the top", () => {
    // The bottom anchor, stated as the observable difference it makes.
    const frame = frameFor(KEYBOARD);
    const sim = simulateThread({
      frame,
      messageHeights: thread(2),
      gap: GAP,
      paddingTop: PAD,
      paddingBottom: PAD,
    });
    expect(sim.scrolls).toBe(false);
    expect(sim.newestBottom).toBeCloseTo(frame.composerTop - PAD, 5);
  });

  test("200 messages land in exactly the same place as 2", () => {
    const frame = frameFor(KEYBOARD);
    const short = simulateThread({
      frame,
      messageHeights: thread(2),
      gap: GAP,
      paddingTop: PAD,
      paddingBottom: PAD,
    });
    const long = simulateThread({
      frame,
      messageHeights: thread(200),
      gap: GAP,
      paddingTop: PAD,
      paddingBottom: PAD,
    });
    expect(long.scrolls).toBe(true);
    expect(long.newestBottom).toBeCloseTo(short.newestBottom, 5);
  });
});

describe("the shell must not pay for the keyboard twice", () => {
  test("an ancestor that already shrank the shell leaves nothing to reserve", () => {
    // This is the shipped bug's second half: the root layout resizes the shell
    // to the visual viewport, and the chat screen ALSO lifted the composer by
    // the keyboard's height — so the composer flew a keyboard above the keys.
    const absorbed = resolveChatFrame({
      shellHeight: SHELL - KEYBOARD,
      keyboardHeight: KEYBOARD,
      keyboardOverlap: 0,
      headerHeight: HEADER,
      composerHeight: COMPOSER,
      safeBottom: SAFE_BOTTOM,
    });
    expect(absorbed.composerBottomInset).toBe(0);
    // The composer's bottom edge is the bottom of the shell — on the keys.
    expect(absorbed.composerTop + COMPOSER).toBe(SHELL - KEYBOARD);
    expect(absorbed.keyboardOpen).toBe(true);
  });

  test("nobody absorbed it → the frame reserves the whole keyboard", () => {
    const own = frameFor(KEYBOARD);
    expect(own.composerBottomInset).toBe(KEYBOARD);
    expect(own.composerTop + COMPOSER + KEYBOARD).toBe(SHELL);
  });
});

describe("tab bar (spec 4)", () => {
  test("hides while typing and returns on dismiss", () => {
    expect(frameFor(KEYBOARD).tabBarVisible).toBe(false);
    expect(frameFor(0).tabBarVisible).toBe(true);
  });

  test("browser-chrome drift is not a keyboard", () => {
    expect(frameFor(48).keyboardOpen).toBe(false);
    expect(frameFor(48).tabBarVisible).toBe(true);
  });
});

describe("interactive dismiss (spec 8)", () => {
  test("progress tracks the finger rather than snapping", () => {
    expect(dismissProgressForDrag(0, KEYBOARD)).toBe(0);
    expect(dismissProgressForDrag(KEYBOARD / 2, KEYBOARD)).toBeCloseTo(0.5, 5);
    expect(dismissProgressForDrag(KEYBOARD * 2, KEYBOARD)).toBe(1);
    expect(dismissProgressForDrag(120, 0)).toBe(0);
  });

  test("the thread grows back proportionally as the keyboard leaves", () => {
    const half = resolveChatFrame({
      shellHeight: SHELL,
      keyboardHeight: KEYBOARD,
      headerHeight: HEADER,
      composerHeight: COMPOSER,
      safeBottom: SAFE_BOTTOM,
      dismissProgress: 0.5,
    });
    expect(half.composerBottomInset).toBeCloseTo(KEYBOARD / 2, 5);
    expect(half.threadHeight).toBeCloseTo(
      SHELL - HEADER - COMPOSER - KEYBOARD / 2,
      5,
    );
  });

  test("a committed drag has eaten a meaningful share of the keyboard", () => {
    expect(INTERACTIVE_DISMISS_COMMIT).toBeGreaterThan(0.2);
    expect(INTERACTIVE_DISMISS_COMMIT).toBeLessThan(1);
  });
});

describe("scroll position across a keyboard transition (spec 6)", () => {
  const openHeight = SHELL - HEADER - COMPOSER - KEYBOARD; // keyboard up
  const closedHeight = SHELL - HEADER - COMPOSER; // keyboard down
  const contentHeight = 6000;
  const closedMax = contentHeight - closedHeight;
  const openMax = contentHeight - openHeight;

  /** Keyboard arriving: the thread viewport SHRINKS. */
  const shrink = (scrollTop: number) =>
    nextScrollTop({
      prevScrollTop: scrollTop,
      prevScrollHeight: contentHeight,
      prevClientHeight: closedHeight,
      nextScrollHeight: contentHeight,
      nextClientHeight: openHeight,
    });

  /** Keyboard leaving: the thread viewport GROWS. */
  const grow = (scrollTop: number) =>
    nextScrollTop({
      prevScrollTop: scrollTop,
      prevScrollHeight: contentHeight,
      prevClientHeight: openHeight,
      nextScrollHeight: contentHeight,
      nextClientHeight: closedHeight,
    });

  test("pinned to the newest message → still pinned once the keyboard is up", () => {
    expect(shrink(closedMax)).toBe(openMax);
  });

  test("scrolled up to read → the same content stays on screen", () => {
    const restored = shrink(closedMax - 900);
    expect(restored).toBeLessThan(openMax);
    expect(openMax - restored).toBe(900);
  });

  test("dismissing does not snap a scrolled-up reader to the bottom", () => {
    const scrolledUp = openMax - 900;
    expect(grow(scrolledUp)).toBe(scrolledUp);
  });

  test("dismissing keeps a pinned reader pinned, not 296px up it", () => {
    // The browser has already clamped `scrollTop` to the new maximum by the
    // time we look. Reading that clamp as "296px from the bottom" and holding
    // the gap is what scrolled a pinned reader up the thread on every single
    // keyboard dismissal.
    expect(grow(openMax)).toBe(closedMax);
    expect(grow(closedMax)).toBe(closedMax);
  });

  test("a round trip returns a pinned reader to exactly where they started", () => {
    expect(grow(shrink(closedMax))).toBe(closedMax);
  });

  test("a thread too short to scroll has nowhere to go", () => {
    expect(
      nextScrollTop({
        prevScrollTop: 0,
        prevScrollHeight: 200,
        prevClientHeight: openHeight,
        nextScrollHeight: 200,
        nextClientHeight: closedHeight,
      }),
    ).toBe(0);
  });

  test("the pin threshold is still what the transcript means by pinned", () => {
    // Exported for callers that need to ask "is the reader at the bottom?";
    // the anchor arithmetic above no longer needs a threshold at all.
    expect(PINNED_THRESHOLD_PX).toBeGreaterThan(0);
  });
});

describe("multiline growth (spec 7)", () => {
  const LINE = 22;
  const PADDING = 20;

  test("grows to five lines then stops — the field scrolls, nothing moves", () => {
    expect(composerFieldHeight(LINE + PADDING, LINE, PADDING)).toBe(
      LINE + PADDING,
    );
    expect(composerFieldHeight(LINE * 3 + PADDING, LINE, PADDING)).toBe(
      LINE * 3 + PADDING,
    );
    const cap = LINE * COMPOSER_MAX_LINES + PADDING;
    expect(composerFieldHeight(LINE * 5 + PADDING, LINE, PADDING)).toBe(cap);
    expect(composerFieldHeight(LINE * 40 + PADDING, LINE, PADDING)).toBe(cap);
  });

  test("a five-line composer takes its height from the thread, not the header", () => {
    const one = frameFor(KEYBOARD, COMPOSER);
    const five = frameFor(KEYBOARD, COMPOSER + LINE * 4);
    expect(five.headerHeight).toBe(one.headerHeight);
    expect(five.threadTop).toBe(one.threadTop);
    expect(one.threadHeight - five.threadHeight).toBe(LINE * 4);
    // And the newest message is still visible in the shorter thread.
    const sim = simulateThread({
      frame: five,
      messageHeights: thread(200),
      gap: GAP,
      paddingTop: PAD,
      paddingBottom: PAD,
    });
    expect(sim.newestVisible).toBe(true);
    expect(sim.newestBottom).toBeLessThanOrEqual(five.composerTop);
  });
});

describe("degenerate viewports", () => {
  test("chrome taller than the shell clamps the thread to zero, not negative", () => {
    const frame = resolveChatFrame({
      shellHeight: 300,
      keyboardHeight: 336,
      headerHeight: HEADER,
      composerHeight: COMPOSER,
    });
    expect(frame.threadHeight).toBe(0);
    expect(frame.composerTop).toBe(HEADER);
  });

  test("an unmeasured frame (first paint) is inert rather than wrong", () => {
    const frame = resolveChatFrame({
      shellHeight: 0,
      keyboardHeight: 0,
      headerHeight: 0,
      composerHeight: 0,
    });
    expect(frame.threadHeight).toBe(0);
    expect(frame.translateY).toBe(0);
    expect(frame.tabBarVisible).toBe(true);
  });
});
