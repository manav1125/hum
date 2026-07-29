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

import { didSeedFromMagicLink, getStoredActorToken } from "./cue-self-host";

/** Production registers both `vellum:` and `vellum-assistant:`. */
const DESKTOP_SCHEME = "vellum";

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
 * True when this page is a freshly-seeded sign-in sitting in a browser — i.e.
 * exactly the moment a desktop user would want to be back in the app.
 */
export function shouldOfferDesktopHandoff(): boolean {
  if (isElectron()) return false; // already in the app
  return didSeedFromMagicLink() && !!getStoredActorToken();
}

/** Fire the handoff for the current URL. */
export function openInDesktopApp(): void {
  const link = buildHandoffLinkFromStoredToken();
  if (!link) return;
  try {
    window.location.assign(link);
  } catch {
    // Custom-scheme navigation is blocked or no handler is registered —
    // nothing to recover, the user stays signed in on the web.
  }
}
