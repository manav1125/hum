import { Capacitor } from "@capacitor/core";

import { isElectron } from "@/runtime/is-electron";

/**
 * Opens a URL in the most appropriate context:
 * - Electron: system browser via the main-process `setWindowOpenHandler`
 *   (which routes `target=_blank` opens to `shell.openExternal`).
 * - Native (Capacitor): `SFSafariViewController` via `@capacitor/browser`,
 *   which keeps the user inside the app and properly handles OAuth / Stripe
 *   redirect flows that would otherwise break out to Safari.
 * - Web: falls back to `window.location.href` (same-tab navigation), matching
 *   the previous behaviour.
 *
 * The plugin is lazy-imported so it is never loaded in SSR or plain-browser
 * contexts where the Capacitor runtime is absent.
 */
export const openUrl = async (url: string): Promise<void> => {
  if (isElectron()) {
    window.open(url, "_blank");
    return;
  }
  if (Capacitor.isNativePlatform()) {
    try {
      const { Browser } = await import("@capacitor/browser");
      await Browser.open({ url, presentationStyle: "popover" });
    } catch {
      // Plugin not available (e.g. older app binary without @capacitor/browser
      // registered). Fall back to same-tab navigation so checkout still works.
      window.location.href = url;
    }
  } else {
    window.location.href = url;
  }
};

/**
 * Open an external URL WITHOUT ever navigating the current tab.
 *
 * Used for links relayed out of sandboxed srcdoc frames (`vellum_open_link`):
 * on plain web, `openUrl`'s same-tab fallback would let widget markup
 * navigate the whole SPA away, so this variant opens a new tab instead.
 * Electron and Capacitor keep their native external-browser handling.
 */
export const openExternalUrl = async (url: string): Promise<void> => {
  if (isElectron() || Capacitor.isNativePlatform()) {
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
};

/**
 * Subscribe to the Capacitor Browser `browserFinished` event, which fires
 * when the user dismisses the `SFSafariViewController`. Returns an
 * unsubscribe function. No-ops in non-native contexts.
 *
 * Usage:
 *   useEffect(() => openUrlFinishedListener(() => { refetch(); onClose(); }), []);
 */
export const openUrlFinishedListener = (callback: () => void): (() => void) => {
  if (!Capacitor.isNativePlatform()) return () => {};

  let handle: { remove: () => void } | null = null;

  void import("@capacitor/browser").then(({ Browser }) => {
    void Browser.addListener("browserFinished", callback).then((h) => {
      handle = h;
    });
  });

  return () => {
    handle?.remove();
  };
};
