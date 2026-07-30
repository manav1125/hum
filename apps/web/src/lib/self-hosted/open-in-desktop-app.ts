/**
 * Hand a magic-link sign-in from the browser back to the desktop app.
 *
 * The sign-in email necessarily contains an `https://` link, so the OS opens
 * the user's BROWSER. Someone who started in the Cue desktop app therefore
 * lands in Chrome and has to go find the app again — the app never picks the
 * session up. This closes that loop: when the token lands in a browser (not in
 * the app's own window), offer a one-click handoff on the desktop deep-link
 * scheme, which main intercepts and uses to load the instance.
 *
 * Deliberately an OFFER, not an automatic redirect:
 *   · the user may genuinely want the web app, and hijacking that is worse
 *     than an extra click;
 *   · the email may be opened on a phone or a machine with no Cue installed,
 *     where firing a custom scheme does nothing visible — a button that sits
 *     there unclicked is honest, a silent failed redirect is not.
 * The web session is seeded either way, so the page behind the offer is a
 * working, signed-in Cue.
 */
import { isElectron } from "@/runtime/is-electron";
import { isNativePlatform } from "@/runtime/native-auth";

import { didSeedFromMagicLink, getStoredActorToken } from "./cue-self-host";

/**
 * Schemes to try, in order. A production Cue build registers `vellum:` and
 * `vellum-assistant:`; a locally-built app registers only its env-suffixed
 * scheme. The browser cannot see which build is installed, so the handoff
 * offers the production scheme first and falls back to the local one — an
 * unregistered scheme simply does nothing, so a wrong guess is harmless.
 */
const DESKTOP_SCHEMES = ["vellum", "vellum-assistant-local"] as const;
const DESKTOP_SCHEME = DESKTOP_SCHEMES[0];

/**
 * The deep link that hands `href` (an instance URL carrying `?cueToken=`) to
 * the desktop app. Exported for tests.
 */
export function buildDesktopConnectLink(href: string): string {
  return `${DESKTOP_SCHEME}://connect?url=${encodeURIComponent(href)}`;
}

/**
 * Rebuild the instance link the app needs. The seeding step strips `cueToken`
 * from the URL, so this reconstructs it from the token that was stored — the
 * app needs the token to boot an authenticated session, and it is the same
 * credential this browser already holds.
 */
export function buildHandoffLinkFromStoredToken(): string | null {
  const token = getStoredActorToken();
  if (!token) return null;
  return buildDesktopConnectLink(
    `${window.location.origin}/assistant/?cueToken=${encodeURIComponent(token)}`,
  );
}

/**
 * True when this page is a freshly-seeded sign-in sitting in a DESKTOP browser
 * — i.e. exactly the moment a desktop user would want to be back in the app.
 *
 * Excluding Electron alone was not enough. The iOS app loads
 * `<instance>/assistant/?cueToken=…` inside its WebView
 * (apps/ios/App/App/CueNativePlugin.swift), which sets `seededFromMagicLink` —
 * so the native app offered to "Continue in the Cue app" while already being
 * the Cue app, and the `vellum://` it fired was a no-op. Mobile web has the same
 * problem for a different reason: there is no desktop app to hand off to.
 */
export function shouldOfferDesktopHandoff(): boolean {
  if (isElectron()) return false; // already in the app
  if (isNativePlatform()) return false; // already in the native app
  if (isTouchOnlyDevice()) return false; // no desktop app to hand off to
  return didSeedFromMagicLink() && !!getStoredActorToken();
}

/**
 * A phone/tablet, judged by the absence of a fine pointer rather than by user
 * agent. Used to suppress desktop-only affordances on mobile web, where the
 * custom-scheme navigation can't resolve to anything.
 */
function isTouchOnlyDevice(): boolean {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/** Fire the handoff for the current URL. */
export function openInDesktopApp(): void {
  const link = buildHandoffLinkFromStoredToken();
  if (!link) return;
  try {
    window.location.assign(link);
    // A locally-built app registers only its env-suffixed scheme, so retry
    // with that one shortly after. If the first attempt worked the app is
    // already focused and this is a no-op; if it did not, nothing happened at
    // all and this is the second chance.
    //
    // Skipped on touch-only devices: there is no desktop app there, so the
    // delayed second navigation can only produce a second failed scheme jump
    // (and on iOS Safari, a second "cannot open page" interruption).
    const token = isTouchOnlyDevice() ? null : getStoredActorToken();
    if (token) {
      const alt = `${DESKTOP_SCHEMES[1]}://connect?url=${encodeURIComponent(
        `${window.location.origin}/assistant/?cueToken=${encodeURIComponent(token)}`,
      )}`;
      window.setTimeout(() => {
        try {
          window.location.assign(alt);
        } catch {
          /* no handler for the fallback scheme either */
        }
      }, 1200);
    }
  } catch {
    // Custom-scheme navigation is blocked or no handler is registered —
    // nothing to recover, the user stays signed in on the web.
  }
}
