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
