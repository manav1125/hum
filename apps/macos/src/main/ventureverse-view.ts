/**
 * VentureVerse inline app embedding — the desktop-only path that makes a
 * VentureVerse mini app run *inside* the Cue window, without any change on
 * VentureVerse's side.
 *
 * ## Why a WebContentsView and not an iframe
 *
 * VentureVerse mini apps authenticate via a postMessage SSO handshake between
 * the VentureVerse shell and the app, and that handshake only completes when
 * VentureVerse is the **top-level** browsing context (the app's SDK times out
 * with "must be opened from VentureVerse" otherwise). An `<iframe>` inside
 * Cue's web app puts VentureVerse under a foreign top origin (manav.justcue.app)
 * and the handshake never completes — plus browser storage partitioning hides
 * the user's VentureVerse session from the frame.
 *
 * A {@link WebContentsView} is a *separate top-level web-contents* that Electron
 * composites into the Cue window at a rectangle we control. From VentureVerse's
 * point of view it IS the top-level page (`window.top === window.self`), so the
 * shell↔app handshake runs exactly as it does in a normal browser tab — while
 * visually it sits embedded inside Cue. No VentureVerse code changes, no token
 * minting, no SSO impersonation.
 *
 * ## Session
 *
 * The view uses a dedicated persisted partition (`persist:ventureverse`) that
 * Cue owns. The user signs into VentureVerse once inside the view (first-party,
 * so Google / passkey / email all work) and the session persists across app
 * restarts — subsequent app opens are already authenticated. Cue never sees a
 * VentureVerse password: sign-in happens in VentureVerse's own page.
 *
 * ## Isolation
 *
 * The view has NO Cue preload and its own session, so VentureVerse cannot reach
 * Cue's IPC bridge. Cue's `app://` CSP does not apply (this is a top-level
 * web-contents loading `https://…ventureverse.com`, governed by VentureVerse's
 * own headers). Top-level navigation is pinned to VentureVerse origins; any
 * other http(s) destination (and every `window.open` that isn't an OAuth popup)
 * is handed to the system browser.
 */

import { BrowserWindow, WebContentsView, shell } from "electron";
import { z } from "zod";

import { handle } from "./ipc.js";
import { current as currentMainWindow } from "./main-window.js";
import { hardenedWebPreferences } from "./windows.js";

/** Rectangle in the main window's content coordinates (DIP). */
export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const VV_PARTITION = "persist:ventureverse";

/**
 * Origins allowed to load as the view's TOP-LEVEL document. VentureVerse and
 * its regional hosts only; the per-app deployments load as sub-frames of the
 * shell (not top-level navigations) so they don't need listing here.
 */
function isVentureverseTopOrigin(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:") return false;
    return (
      u.hostname === "ventureverse.com" || u.hostname.endsWith(".ventureverse.com")
    );
  } catch {
    return false;
  }
}

/** The single embedded view. One VentureVerse app shows at a time. */
let view: WebContentsView | null = null;
/** The window the view is currently attached to. */
let attachedTo: BrowserWindow | null = null;
/** The URL last requested, so a repeat open() doesn't reload needlessly. */
let currentUrl: string | null = null;

function destroyView(): void {
  if (view && attachedTo && !attachedTo.isDestroyed()) {
    try {
      attachedTo.contentView.removeChildView(view);
    } catch {
      // View already detached — nothing to do.
    }
  }
  // `WebContentsView` has no destroy(); closing its webContents releases it.
  if (view && !view.webContents.isDestroyed()) {
    view.webContents.close();
  }
  view = null;
  attachedTo = null;
  currentUrl = null;
}

function createView(): WebContentsView {
  const v = new WebContentsView({
    webPreferences: {
      ...hardenedWebPreferences(),
      // A remote site: no Cue preload, its own persisted session, and the
      // sandbox on. VentureVerse gets no access to Cue's IPC.
      preload: undefined,
      partition: VV_PARTITION,
    },
  });

  const wc = v.webContents;

  // Pin top-level navigation to VentureVerse; hand anything else to the system
  // browser. Sub-frames (the app deployments the shell iframes) are not
  // `will-navigate` events on the top web-contents, so they load unimpeded.
  wc.on("will-navigate", (event, url) => {
    if (isVentureverseTopOrigin(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });

  // `window.open` from VentureVerse: OAuth/passkey popups (Google) open as a
  // real hardened child window so the ceremony can complete; everything else
  // goes to the system browser. This mirrors the main window's popup policy.
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (
      disposition === "new-window" ||
      url.startsWith("https://accounts.google.com") ||
      isVentureverseTopOrigin(url)
    ) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: {
            ...hardenedWebPreferences(),
            partition: VV_PARTITION,
          },
        },
      };
    }
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  return v;
}

/**
 * Open (or move) the embedded VentureVerse view at `bounds`, loading `url`
 * (the VentureVerse shell launch URL, e.g.
 * `https://www.ventureverse.com/apps?launch=10-alchemy`).
 *
 * Idempotent: called on mount and whenever the SPA's app area resizes. Only
 * (re)loads when the URL actually changes.
 */
export function openVentureverseView(url: string, bounds: ViewBounds): void {
  if (!isVentureverseTopOrigin(url)) return;
  const win = currentMainWindow();
  if (!win || win.isDestroyed()) return;

  // A window swap (rare) means rebuild the view against the live window.
  if (view && attachedTo !== win) destroyView();

  if (!view) {
    view = createView();
    attachedTo = win;
    win.contentView.addChildView(view);
  }

  view.setBounds(roundBounds(bounds));

  if (currentUrl !== url) {
    currentUrl = url;
    void view.webContents.loadURL(url);
  }
}

/** Move/resize the open view. No-op when nothing is open. */
export function setVentureverseViewBounds(bounds: ViewBounds): void {
  if (!view) return;
  view.setBounds(roundBounds(bounds));
}

/** Tear the view down (SPA navigated away from the app, or window closing). */
export function closeVentureverseView(): void {
  destroyView();
}

/** Electron wants integer device-independent pixels. */
function roundBounds(b: ViewBounds): ViewBounds {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(0, Math.round(b.width)),
    height: Math.max(0, Math.round(b.height)),
  };
}

// ---------------------------------------------------------------------------
// IPC — the SPA's embed page drives the view (mount, resize, unmount).
// ---------------------------------------------------------------------------

const boundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const installVentureverseViewIpc = (): void => {
  handle(
    "vellum:vvView:open",
    z.tuple([z.string(), boundsSchema]),
    ([url, bounds]): void => openVentureverseView(url, bounds),
  );
  handle(
    "vellum:vvView:setBounds",
    z.tuple([boundsSchema]),
    ([bounds]): void => setVentureverseViewBounds(bounds),
  );
  handle("vellum:vvView:close", z.tuple([]), (): void =>
    closeVentureverseView(),
  );
};
