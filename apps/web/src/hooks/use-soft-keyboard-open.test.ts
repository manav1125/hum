/**
 * The signal the tab bar hides on.
 *
 * Two properties matter more than the arithmetic (which `phone-keyboard.test.ts`
 * covers): it must FAIL OPEN, and it must not mistake browser chrome for a
 * keyboard. A signal that reads "keyboard up" when it does not know would hide
 * the phone's navigation — and with the mark gone, the only door to Your Cue —
 * on every device whose viewport it cannot read.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { isSoftKeyboardOpen } from "./use-soft-keyboard-open";

const original = Object.getOwnPropertyDescriptor(window, "visualViewport");

function setViewport(value: unknown) {
  Object.defineProperty(window, "visualViewport", {
    value,
    configurable: true,
  });
}

afterEach(() => {
  if (original) Object.defineProperty(window, "visualViewport", original);
  else setViewport(undefined);
});

describe("isSoftKeyboardOpen", () => {
  test("no VisualViewport API → shown, never hidden", () => {
    setViewport(undefined);
    expect(isSoftKeyboardOpen()).toBe(false);
  });

  test("full-height viewport → no keyboard", () => {
    setViewport({
      height: window.innerHeight,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
    });
    expect(isSoftKeyboardOpen()).toBe(false);
  });

  test("a keyboard's worth of missing viewport → open", () => {
    setViewport({
      height: window.innerHeight - 336,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
    });
    expect(isSoftKeyboardOpen()).toBe(true);
  });

  test("browser chrome sliding away is not a keyboard", () => {
    setViewport({
      height: window.innerHeight - 48,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
    });
    expect(isSoftKeyboardOpen()).toBe(false);
  });

  test("pinch-zoom shrinks the visual viewport and is not a keyboard", () => {
    setViewport({
      height: window.innerHeight - 400,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 2,
    });
    expect(isSoftKeyboardOpen()).toBe(false);
  });
});
