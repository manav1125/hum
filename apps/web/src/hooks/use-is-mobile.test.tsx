/**
 * B6: the desktop app rendered the PHONE flow.
 *
 * `useIsMobile()` is a pure `(max-width: 767px)` media query with no platform
 * guard, and Electron legitimately opens sub-767px windows: onboarding is forced
 * to 440x660 (apps/macos/src/main/main-window.ts), chat pop-outs are 720px, and
 * Cmd+ twice shrinks the layout viewport below the breakpoint. On first run that
 * meant desktop onboarding took the MOBILE completion branch, which omits
 * `markExpectingFirstMessage()` — so a new desktop user landed on an empty HQ
 * deck having never been introduced to their assistant.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { renderHook } from "@testing-library/react";

let mockIsElectron = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => mockIsElectron,
}));

const { useIsMobile, useMobileLayout } = await import("@/hooks/use-is-mobile");

/** Pin the viewport-match answer without a real layout engine. */
function setViewportMatches(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const originalMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  mockIsElectron = false;
});

describe("useMobileLayout (B6)", () => {
  test("a narrow ELECTRON window is not treated as mobile", () => {
    setViewportMatches(true);
    mockIsElectron = true;

    // The 440px onboarding window: narrow, but a desktop. The raw viewport
    // hook still reports true — that part is correct and unchanged.
    expect(renderHook(() => useIsMobile()).result.current).toBe(true);
    expect(renderHook(() => useMobileLayout()).result.current).toBe(false);
  });

  test("a narrow browser viewport is still mobile", () => {
    setViewportMatches(true);
    mockIsElectron = false;
    expect(renderHook(() => useMobileLayout()).result.current).toBe(true);
  });

  test("a wide viewport is never mobile, on either platform", () => {
    setViewportMatches(false);
    mockIsElectron = false;
    expect(renderHook(() => useMobileLayout()).result.current).toBe(false);
    mockIsElectron = true;
    expect(renderHook(() => useMobileLayout()).result.current).toBe(false);
  });
});
