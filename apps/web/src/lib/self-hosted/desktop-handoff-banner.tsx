/**
 * "Open in the Cue app" — shown once, right after a magic-link sign-in lands in
 * a browser.
 *
 * The sign-in email has to be an `https://` link, so the OS opens the browser
 * even when the user started in the desktop app. Without this they are simply
 * left in Chrome, and the app they signed in from never picks up the session.
 *
 * An offer rather than an automatic redirect: the email may be opened on a
 * phone, or on a machine with no Cue installed, where firing a custom scheme
 * does nothing the user can see. The page behind this banner is a working,
 * signed-in Cue either way — so ignoring it costs nothing.
 */
import { useState } from "react";

import {
  openInDesktopApp,
  shouldOfferDesktopHandoff,
} from "@/lib/self-hosted/open-in-desktop-app";

export function DesktopHandoffBanner() {
  // Captured once on mount: the underlying signal is a page-load fact, and
  // re-reading it on every render would let a re-render resurrect a dismissed
  // banner.
  const [offer] = useState(shouldOfferDesktopHandoff);
  const [dismissed, setDismissed] = useState(false);
  if (!offer || dismissed) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-[60] flex flex-wrap items-center justify-center gap-3 border-b border-[var(--border-base)] bg-[var(--surface-lift)] px-4 py-2.5"
    >
      <span className="text-body-small-default text-[color:var(--content-default)]">
        You&rsquo;re signed in. Continue in the Cue app?
      </span>
      <button
        type="button"
        onClick={openInDesktopApp}
        className="rounded-md bg-[var(--primary-base)] px-3 py-1.5 text-body-small-default text-[color:var(--content-inset)] transition-opacity hover:opacity-90"
      >
        Open in Cue
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="text-body-small-default text-[color:var(--content-tertiary)] underline underline-offset-2 transition-colors hover:text-[color:var(--content-default)]"
      >
        Stay in the browser
      </button>
    </div>
  );
}
