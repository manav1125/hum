/**
 * M7 in the DOM: the shipped arc, adapted rather than rebuilt.
 *
 * The geometry itself is pinned in `signon-phone.test.ts`. What these check is
 * the thing a pure function cannot: that the SAME sign-in screen renders inside
 * the sheet on a coarse pointer and inside the desktop card otherwise, and that
 * the magic-link path is untouched by either.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

const pointer = { coarse: false };
const realMatchMedia = globalThis.window?.matchMedia;

beforeEach(() => {
  localStorage.clear();
  // Only the pointer query is answered differently; everything else falls
  // through to the real implementation so reduced-motion and orientation
  // behave normally.
  globalThis.window.matchMedia = ((query: string) => {
    if (query.includes("pointer: coarse")) {
      return {
        matches: pointer.coarse,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        onchange: null,
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    }
    return realMatchMedia
      ? realMatchMedia.call(globalThis.window, query)
      : ({
          matches: false,
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        } as unknown as MediaQueryList);
  }) as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  if (realMatchMedia) globalThis.window.matchMedia = realMatchMedia;
});

const { SignonFlow } = await import("./signon-flow");

describe("at phone width the card becomes a sheet — and nothing else changes", () => {
  test("coarse pointer gets the sheet", () => {
    pointer.coarse = true;
    const { container } = render(<SignonFlow initialStep="signin" />);
    expect(container.querySelector("[data-signon-phone]")).toBeTruthy();
  });

  test("a fine pointer does not — a narrow window is not a phone", () => {
    pointer.coarse = false;
    const { container } = render(<SignonFlow initialStep="signin" />);
    expect(container.querySelector("[data-signon-phone]")).toBeNull();
  });

  test("the sheet carries the same email field and the same submit", () => {
    pointer.coarse = true;
    render(<SignonFlow initialStep="signin" />);
    const input = screen.getByLabelText("EMAIL") as HTMLInputElement;
    expect(input.type).toBe("email");
    expect(screen.getByRole("button", { name: "Send sign-in link" })).toBeTruthy();
    // Still magic-link only: a password box here would be a phishing surface
    // for a credential that does not exist.
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  test("the brand block sits above the sheet and says the thing design asked for", () => {
    pointer.coarse = true;
    render(<SignonFlow initialStep="signin" />);
    expect(screen.getByText("Welcome to Cue")).toBeTruthy();
    expect(
      screen.getByText(/Cue reads nothing until you connect a source/),
    ).toBeTruthy();
  });

  test("the sheet's own heading is a heading, not a second hero", () => {
    pointer.coarse = true;
    render(<SignonFlow initialStep="signin" />);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    // The desktop hero would be the same sentence twice under the wordmark.
    expect(screen.queryByText(/This one's yours/)).toBeNull();
  });

  test("the orbit is decoration — the screen never depends on it for meaning", () => {
    pointer.coarse = true;
    const { container } = render(<SignonFlow initialStep="signin" />);
    const system = container.querySelector("[data-gv-system]");
    expect(system).toBeTruthy();
    expect(system?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("with the keyboard up, the mark shrinks and nothing is clipped", () => {
  /**
   * This is the regression test for a bug that only showed up in a real
   * browser: the geometry was right, the orbit's box was 89px, and the mark was
   * still sheared off the top — because the wordmark under it was at
   * `opacity: 0` and STILL OCCUPYING ITS HEIGHT inside an `overflow: hidden`
   * strip. "Scales rather than being cropped" was true of the number and false
   * of the pixels. So the assertion is on the collapsed BOX, not the opacity.
   */
  function withKeyboard(px: number, run: () => void) {
    const real = window.visualViewport;
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        height: 844 - px,
        scale: 1,
        offsetTop: 0,
        offsetLeft: 0,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });
    try {
      run();
    } finally {
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: real,
      });
    }
  }

  test("the wordmark's box collapses to nothing rather than pushing the mark out", () => {
    pointer.coarse = true;
    withKeyboard(291, () => {
      const { container } = render(<SignonFlow initialStep="signin" />);
      const root = container.querySelector<HTMLElement>("[data-signon-phone]")!;
      expect(root.dataset.keyboard).toBe("open");

      const strip = root.children[0] as HTMLElement;
      const orbitBox = strip.children[0] as HTMLElement;
      const wordmark = strip.children[1] as HTMLElement;

      expect(Number.parseFloat(wordmark.style.maxHeight)).toBe(0);
      expect(Number.parseFloat(wordmark.style.marginTop)).toBe(0);
      expect(wordmark.style.opacity).toBe("0");

      // …and the orbit's own box is small enough to sit in what's left.
      const orbitPx = Number.parseFloat(orbitBox.style.height);
      expect(orbitPx).toBeGreaterThan(0);
      expect(orbitPx).toBeLessThanOrEqual(844 - Number.parseFloat(
        (root.children[1] as HTMLElement).style.height,
      ));
    });
  });

  test("at rest the wordmark is present and legible", () => {
    pointer.coarse = true;
    const { container } = render(<SignonFlow initialStep="signin" />);
    const strip = container.querySelector<HTMLElement>("[data-signon-phone]")!
      .children[0] as HTMLElement;
    const wordmark = strip.children[1] as HTMLElement;
    expect(wordmark.style.opacity).toBe("1");
    expect(Number.parseFloat(wordmark.style.maxHeight)).toBeGreaterThan(0);
  });
});

describe("the sheet never constructs a URL carrying a credential", () => {
  test("no rendered href or action contains a token parameter", () => {
    pointer.coarse = true;
    const { container } = render(<SignonFlow initialStep="signin" />);
    const html = container.innerHTML;
    expect(html).not.toContain("cueToken");
    expect(html).not.toContain("cueExp");
  });
});
