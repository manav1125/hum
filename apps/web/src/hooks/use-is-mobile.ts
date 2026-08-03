import { useSyncExternalStore } from "react";

import { isElectron } from "@/runtime/is-electron";

/**
 * Media query that marks viewports narrow enough to swap a sidebar rail
 * for an overlay drawer. Mirrors `SidebarPageLayout`'s `md:` breakpoint
 * (768px).
 */
export const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

/**
 * Returns `true` while the viewport matches `MOBILE_MEDIA_QUERY`
 * (`max-width: 767px`).
 *
 * This is a pure VIEWPORT question. For "should I render the phone UI?" use
 * {@link useMobileLayout} instead — a narrow window on a desktop is not a phone.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Whether to render the phone experience: a narrow viewport AND not the desktop
 * app.
 *
 * `useIsMobile()` alone is a width test with no platform guard, and Electron
 * legitimately opens windows narrower than 767px — onboarding is forced to
 * 440×660 (`apps/macos/src/main/main-window.ts`), chat pop-outs are 720px, and
 * two presses of Cmd+ shrink the layout viewport below the breakpoint. Each of
 * those made the desktop app silently render the mobile flow.
 *
 * The worst case was first-run: desktop onboarding took the mobile completion
 * branch, which navigates to Today and omits `markExpectingFirstMessage()`, so a
 * brand-new desktop user landed on an empty HQ deck having never been introduced
 * to their assistant at all.
 */
export function useMobileLayout(): boolean {
  return useIsMobile() && !isElectron();
}

/* -------------------------------------------------------------------------- */
/* The phone gate — pointer type, not viewport width                          */
/* -------------------------------------------------------------------------- */

/**
 * Whether the primary pointer is coarse — i.e. a finger.
 *
 * Reactive (a mouse can be attached to a tablet mid-session), unlike the
 * one-shot `isPointerCoarse()` in utils/pointer.ts.
 */
const COARSE_POINTER_QUERY = "(pointer: coarse)";

function subscribeCoarse(onChange: () => void): () => void {
  const mql = window.matchMedia(COARSE_POINTER_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getCoarseSnapshot(): boolean {
  return window.matchMedia(COARSE_POINTER_QUERY).matches;
}

export function usePointerCoarse(): boolean {
  return useSyncExternalStore(subscribeCoarse, getCoarseSnapshot);
}

/**
 * "Am I on a phone?" — narrow AND touch-first AND not the desktop app.
 *
 * {@link useMobileLayout} answers a width question with a platform guard, and
 * width alone has already cost this codebase a surface: a 720px desktop
 * window is not a phone, but it matched the breakpoint, and the People page
 * rendered its touch-only rendering and lost its list. A resized window, a
 * side-by-side split and two presses of Cmd+ all cross 767px; none of them
 * grow a finger.
 *
 * Use this for anything that assumes touch — swipe-back, swipe-reveal,
 * long-press, sheets that expect a thumb. Keep {@link useMobileLayout} for
 * questions that really are about width.
 */
export function usePhoneLayout(): boolean {
  // Both hooks run unconditionally — `&&` would short-circuit the second one
  // and change the hook order between renders.
  const narrow = useIsMobile();
  const coarse = usePointerCoarse();
  return narrow && coarse && !isElectron();
}
