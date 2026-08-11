/**
 * Cross-platform accessor for the native "VentureVerse inline view" capability.
 *
 * A VentureVerse mini app only authenticates when VentureVerse is the top-level
 * browsing context (its SSO handshake times out otherwise) — so it cannot run in
 * a same-origin iframe inside Cue. Instead each native shell composites a
 * *separate* top-level web view over Cue's app area:
 *
 *   · **Electron desktop** — a `WebContentsView` exposed on the preload bridge
 *     as `window.vellum.vvView` (see `apps/macos/src/main/ventureverse-view.ts`).
 *   · **Capacitor iOS** — a `WKWebView` overlay exposed by the
 *     `VentureverseView` plugin (see
 *     `apps/ios/App/App/VentureverseViewPlugin.swift`).
 *
 * Both speak the same three-method contract, so the embed page
 * (`ventureverse-app-embed-page.tsx`) drives one `VvView` and stays
 * platform-agnostic. On the web (no native shell) this returns `null` and the
 * page falls back to the launch screen.
 *
 * This wrapper follows the per-capability runtime pattern documented in
 * `is-electron.ts`: feature code never reaches into `window.vellum` /
 * `Capacitor` directly.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

import { isElectron } from "@/runtime/is-electron";

export interface VvViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VvView {
  open(url: string, bounds: VvViewBounds): Promise<void>;
  setBounds(bounds: VvViewBounds): Promise<void>;
  close(): Promise<void>;
}

/** The iOS plugin's raw shape — `open` takes url + bounds as one object. */
interface VentureverseViewPlugin {
  open(options: { url: string } & VvViewBounds): Promise<void>;
  setBounds(bounds: VvViewBounds): Promise<void>;
  close(): Promise<void>;
}

// Registered lazily on first native use, then memoized. `undefined` = not yet
// resolved; `null` = resolved to "no native view here".
let cachedCapacitor: VvView | null | undefined;

/**
 * The native inline-view driver for this platform, or `null` when there is
 * none (web, or a native build that predates the capability). Callers MUST
 * feature-check the result and fall back to the launch screen on `null`.
 */
export function getVvView(): VvView | null {
  // Electron desktop: the preload bridge. Absent on older desktop builds.
  if (isElectron() && typeof window.vellum?.vvView !== "undefined") {
    return window.vellum.vvView;
  }

  // Capacitor iOS: the VentureverseView plugin. `isPluginAvailable` is false in
  // TestFlight builds that shipped before the plugin, so those fall back.
  if (
    Capacitor.isNativePlatform() &&
    Capacitor.isPluginAvailable("VentureverseView")
  ) {
    if (cachedCapacitor === undefined) {
      const plugin = registerPlugin<VentureverseViewPlugin>("VentureverseView");
      cachedCapacitor = {
        open: (url, bounds) => plugin.open({ url, ...bounds }),
        setBounds: (bounds) => plugin.setBounds(bounds),
        close: () => plugin.close(),
      };
    }
    return cachedCapacitor;
  }

  return null;
}

/** Whether this platform can embed a VentureVerse app inline. */
export function hasVvView(): boolean {
  return getVvView() !== null;
}
