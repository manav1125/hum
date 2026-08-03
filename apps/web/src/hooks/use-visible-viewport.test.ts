/**
 * The reference height, and why it used to drift.
 *
 * `readVisibleViewport` derives "is a keyboard covering the page?" by comparing
 * the visual viewport against a remembered no-keyboard `innerHeight`. That
 * remembered value used to be the largest ever seen, which could only go up —
 * so anything that permanently shrank the layout viewport left it stale-high,
 * and the hook then reported a 60–120px "keyboard" with nothing on screen.
 * `RootLayout` sizes its shell to `visualViewport.height` past 100px, so the
 * app resized itself while the user was only browsing.
 *
 * The reference is now pinned to focus: no editable element focused means no
 * soft keyboard is possible, so the current `innerHeight` IS the reference and
 * is taken in both directions. These tests hold both halves — the drift must
 * self-correct, and a real keyboard must still be detected in the WKWebView
 * runtime where the web view frame itself shrinks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  isEditableFocused,
  readVisibleViewport,
} from "./use-visible-viewport";

const originalViewport = Object.getOwnPropertyDescriptor(
  window,
  "visualViewport",
);
const originalInner = Object.getOwnPropertyDescriptor(window, "innerHeight");
const originalMatchMedia = window.matchMedia;

/** Layout viewport height — what the web view frame reports. */
function setInnerHeight(value: number) {
  Object.defineProperty(window, "innerHeight", { value, configurable: true });
}

/** Visual viewport — what is actually visible after the keyboard/zoom. */
function setVisualViewport(height: number, extra: Record<string, number> = {}) {
  Object.defineProperty(window, "visualViewport", {
    value: { height, offsetTop: 0, offsetLeft: 0, scale: 1, ...extra },
    configurable: true,
  });
}

function setOrientation(portrait: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("portrait") ? portrait : !portrait,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

let field: HTMLInputElement;

function focusField() {
  field.focus();
}

function blurField() {
  field.blur();
}

beforeEach(() => {
  setOrientation(true);
  field = document.createElement("input");
  field.type = "text";
  document.body.appendChild(field);
  blurField();
  // Settle the module's reference at a known unobstructed height.
  setInnerHeight(800);
  setVisualViewport(800);
  readVisibleViewport();
});

afterEach(() => {
  field.remove();
  window.matchMedia = originalMatchMedia;
  if (originalViewport)
    Object.defineProperty(window, "visualViewport", originalViewport);
  if (originalInner)
    Object.defineProperty(window, "innerHeight", originalInner);
});

describe("isEditableFocused", () => {
  test("a focused text input can raise a keyboard", () => {
    focusField();
    expect(isEditableFocused()).toBe(true);
  });

  test("nothing focused cannot", () => {
    blurField();
    expect(isEditableFocused()).toBe(false);
  });

  test("a readonly input cannot", () => {
    field.readOnly = true;
    focusField();
    expect(isEditableFocused()).toBe(false);
  });

  test("a focused checkbox cannot", () => {
    field.type = "checkbox";
    focusField();
    expect(isEditableFocused()).toBe(false);
  });
});

describe("the reference does not drift", () => {
  test("a permanently shorter layout viewport is not a keyboard", () => {
    // The regression. The page was 800 tall; something took 140px of it for
    // good (browser chrome, a frame change) with no field focused. The old
    // ratchet held 800 forever and reported a 140px keyboard, which is over
    // RootLayout's 100px threshold — so the shell resized, mid-browse.
    blurField();
    setInnerHeight(660);
    setVisualViewport(660);
    expect(readVisibleViewport()?.keyboardHeight).toBe(0);
  });

  test("…and it stays corrected on every later read", () => {
    blurField();
    setInnerHeight(660);
    setVisualViewport(660);
    readVisibleViewport();
    setVisualViewport(660);
    expect(readVisibleViewport()?.keyboardHeight).toBe(0);
  });

  test("growing back is picked up too", () => {
    blurField();
    setInnerHeight(660);
    setVisualViewport(660);
    readVisibleViewport();
    setInnerHeight(800);
    setVisualViewport(800);
    expect(readVisibleViewport()?.keyboardHeight).toBe(0);
  });
});

describe("a real keyboard is still detected", () => {
  test("Safari: only the visual viewport shrinks", () => {
    focusField();
    setInnerHeight(800);
    setVisualViewport(464);
    expect(readVisibleViewport()?.keyboardHeight).toBe(336);
  });

  test("WKWebView: the frame shrinks too, and the reference holds", () => {
    // The case the ratchet exists for: both values drop together, so
    // `innerHeight - vv.height` is 0 with the keys plainly up.
    focusField();
    setInnerHeight(464);
    setVisualViewport(464);
    expect(readVisibleViewport()?.keyboardHeight).toBe(336);
  });

  test("rotating mid-typing does not clear the keyboard", () => {
    // The mirror-image bug: the orientation reset re-sampled `innerHeight` at
    // the instant of the flip. Under WKWebView that is a keyboard-shrunk
    // height, so the app decided the keyboard had closed while it was up.
    focusField();
    setInnerHeight(464);
    setVisualViewport(464);
    expect(readVisibleViewport()?.keyboardHeight).toBe(336);
    setOrientation(false);
    expect(readVisibleViewport()?.keyboardHeight).toBe(336);
  });

  test("dismissing the keyboard settles back to zero", () => {
    focusField();
    setInnerHeight(464);
    setVisualViewport(464);
    expect(readVisibleViewport()?.keyboardHeight).toBe(336);
    blurField();
    setInnerHeight(800);
    setVisualViewport(800);
    expect(readVisibleViewport()?.keyboardHeight).toBe(0);
  });
});

describe("zoom is never a keyboard", () => {
  test("a pinch-zoomed visual viewport reports no keyboard and no offset", () => {
    focusField();
    setInnerHeight(800);
    setVisualViewport(400, { scale: 2, offsetTop: 120 });
    const vp = readVisibleViewport();
    expect(vp?.keyboardHeight).toBe(0);
    expect(vp?.offsetTop).toBe(0);
  });
});

describe("no VisualViewport API", () => {
  test("returns null so callers fall back to 100dvh", () => {
    Object.defineProperty(window, "visualViewport", {
      value: undefined,
      configurable: true,
    });
    expect(readVisibleViewport()).toBeNull();
  });
});
