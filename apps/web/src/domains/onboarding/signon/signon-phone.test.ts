/**
 * M7's two numbers, asserted at the viewport design drew them at.
 *
 * "The orbit scales to 40% as the sheet rises rather than being cropped —
 *  detents: 55% at rest, 90% with keyboard."
 *
 * Both halves are load-bearing and the second one is the one that gets lost in
 * a refactor: a `transform: scale()` with no layout change still "scales", and
 * still pushes the mark under the sheet. So the tests check the SIZE, and check
 * it against the space that is actually left.
 */
import { describe, expect, test } from "bun:test";

import {
  ORBIT_FULL_PX,
  ORBIT_KEYBOARD_SCALE,
  ORBIT_MIN_SCALE,
  resolveSignonSheet,
  SIGNON_DETENT_KEYBOARD,
  SIGNON_DETENT_REST,
} from "./signon-phone";

/** The frame design drew: iPhone 14 Pro, and iOS's portrait keyboard on it. */
const H = 844;
const KEYBOARD = 291;

describe("the detents", () => {
  test("55% at rest", () => {
    const frame = resolveSignonSheet({ viewportHeight: H, keyboardHeight: 0 });
    expect(frame.detent).toBeCloseTo(SIGNON_DETENT_REST, 5);
    expect(frame.sheetHeight).toBeCloseTo(H * 0.55, 5);
    expect(frame.keyboardOpen).toBe(false);
  });

  test("90% with the keyboard up", () => {
    const frame = resolveSignonSheet({
      viewportHeight: H,
      keyboardHeight: KEYBOARD,
    });
    // A real iOS keyboard is within a few px of the detent delta, so the sheet
    // lands on the top detent without a threshold being invented for it.
    expect(frame.detent).toBeGreaterThan(0.88);
    expect(frame.detent).toBeLessThanOrEqual(SIGNON_DETENT_KEYBOARD);
    expect(frame.keyboardOpen).toBe(true);
  });

  test("browser chrome drift is not a keyboard", () => {
    const frame = resolveSignonSheet({ viewportHeight: H, keyboardHeight: 60 });
    expect(frame.keyboardOpen).toBe(false);
    expect(frame.sheetBottomInset).toBe(0);
  });

  test("the sheet's content clears the keys rather than sitting behind them", () => {
    const frame = resolveSignonSheet({
      viewportHeight: H,
      keyboardHeight: KEYBOARD,
    });
    expect(frame.sheetBottomInset).toBe(KEYBOARD);
  });
});

describe("the orbit scales — and is never cropped", () => {
  test("full size at rest, and it fits the strip above the sheet", () => {
    const frame = resolveSignonSheet({ viewportHeight: H, keyboardHeight: 0 });
    expect(frame.orbitScale).toBe(1);
    expect(frame.orbitSize).toBe(ORBIT_FULL_PX);
    expect(frame.orbitSize).toBeLessThanOrEqual(frame.brandHeight);
  });

  test("about 40% once the sheet has risen — design's number, from design's frame", () => {
    const frame = resolveSignonSheet({
      viewportHeight: H,
      keyboardHeight: KEYBOARD,
    });
    // Design drew the risen orbit at 92px. 230 × 0.4 = 92.
    expect(frame.orbitSize).toBeGreaterThan(78);
    expect(frame.orbitSize).toBeLessThanOrEqual(ORBIT_FULL_PX * ORBIT_KEYBOARD_SCALE);
  });

  test("the LAYOUT box shrinks, so the mark can never be pushed under the sheet", () => {
    // This is the assertion a transform-only "scale" would fail: the orbit's
    // reported size must fit the strip at every keyboard height, on a device
    // with a deep top inset, at every point of the rise.
    for (let kb = 0; kb <= 400; kb += 20) {
      for (const safeTop of [0, 47, 59]) {
        const frame = resolveSignonSheet({
          viewportHeight: H,
          keyboardHeight: kb,
          safeTop,
        });
        expect(frame.orbitSize).toBeLessThanOrEqual(frame.brandHeight + 0.001);
      }
    }
  });

  test("it shrinks monotonically as the sheet rises — never a jump", () => {
    let previous = Infinity;
    for (let kb = 0; kb <= 400; kb += 10) {
      const { orbitSize } = resolveSignonSheet({
        viewportHeight: H,
        keyboardHeight: kb,
      });
      expect(orbitSize).toBeLessThanOrEqual(previous + 0.001);
      previous = orbitSize;
    }
  });

  test("it never disappears — a floor, because the brand moment has to survive", () => {
    const frame = resolveSignonSheet({
      viewportHeight: 568, // iPhone SE, the tightest device in the set
      keyboardHeight: 260,
      safeTop: 20,
    });
    expect(frame.orbitScale).toBeGreaterThanOrEqual(ORBIT_MIN_SCALE);
    expect(frame.orbitSize).toBeGreaterThan(0);
  });
});

describe("the wordmark yields, the mark does not", () => {
  test("both lines are legible at rest", () => {
    expect(
      resolveSignonSheet({ viewportHeight: H, keyboardHeight: 0 })
        .wordmarkOpacity,
    ).toBe(1);
  });

  test("and are gone by the time the sheet is up", () => {
    expect(
      resolveSignonSheet({ viewportHeight: H, keyboardHeight: KEYBOARD })
        .wordmarkOpacity,
    ).toBe(0);
  });
});

describe("degenerate inputs never produce a broken frame", () => {
  test("a zero viewport", () => {
    const frame = resolveSignonSheet({ viewportHeight: 0, keyboardHeight: 0 });
    expect(frame.orbitScale).toBeGreaterThanOrEqual(ORBIT_MIN_SCALE);
    expect(frame.sheetHeight).toBe(0);
  });

  test("a keyboard taller than the screen", () => {
    const frame = resolveSignonSheet({
      viewportHeight: H,
      keyboardHeight: 2000,
    });
    expect(frame.progress).toBe(1);
    expect(frame.detent).toBeCloseTo(SIGNON_DETENT_KEYBOARD, 5);
  });
});
