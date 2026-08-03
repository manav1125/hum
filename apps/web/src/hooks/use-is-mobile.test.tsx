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

const { useIsMobile, useMobileLayout, usePhoneLayout } = await import(
  "@/hooks/use-is-mobile"
);

/**
 * Pin the media-query answers without a real layout engine. Width and pointer
 * are answered separately, because the whole point of `usePhoneLayout` is that
 * they are different questions.
 */
function setMedia({
  narrow,
  coarse = narrow,
}: {
  narrow: boolean;
  coarse?: boolean;
}) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("pointer") ? coarse : narrow,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function setViewportMatches(matches: boolean) {
  setMedia({ narrow: matches });
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

/**
 * The narrower gate: a 720px desktop window matches the breakpoint and has no
 * thumb. The People page rendered its touch-only layout there and lost its
 * list — width answered a question only the pointer can answer.
 */
describe("usePhoneLayout — pointer type, not viewport width", () => {
  test("a narrow window with a MOUSE is not a phone", () => {
    setMedia({ narrow: true, coarse: false });
    mockIsElectron = false;
    // The width question still says yes; the phone question says no.
    expect(renderHook(() => useIsMobile()).result.current).toBe(true);
    expect(renderHook(() => useMobileLayout()).result.current).toBe(true);
    expect(renderHook(() => usePhoneLayout()).result.current).toBe(false);
  });

  test("a narrow window with a FINGER is a phone", () => {
    setMedia({ narrow: true, coarse: true });
    mockIsElectron = false;
    expect(renderHook(() => usePhoneLayout()).result.current).toBe(true);
  });

  test("a touchscreen laptop is not a phone — width still has to agree", () => {
    setMedia({ narrow: false, coarse: true });
    mockIsElectron = false;
    expect(renderHook(() => usePhoneLayout()).result.current).toBe(false);
  });

  test("the desktop app is never a phone, however narrow or touchy", () => {
    setMedia({ narrow: true, coarse: true });
    mockIsElectron = true;
    expect(renderHook(() => usePhoneLayout()).result.current).toBe(false);
  });
});
