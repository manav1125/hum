/**
 * Pointing the packaged renderer's one HQ call at the main-process rail.
 *
 * `hq-forward.ts` puts a same-origin route in front of HQ's `POST /signin`
 * (`app://vellum.ai/assistant/__hq/signin`). This module is the other half:
 * making the shipped renderer actually use it.
 *
 * The sign-on client in `apps/web` calls an ABSOLUTE URL —
 * `https://justcue.ai/signin` — and that is correct for it. In a browser the
 * direct cross-origin call is the right call and (since HQ learned about
 * instance origins) it works. The web build must keep behaving exactly that
 * way; it is not the desktop's business to change it, and `apps/web` is not
 * this change's to edit.
 *
 * So the redirection happens where the desktop difference actually lives: the
 * main process installs a tiny shim in the renderer's main world that rewrites
 * that one exact URL onto the same-origin rail. The request the renderer then
 * makes is same-origin, so — measured, not assumed — Chromium sends NO preflight
 * at all, and the main process makes the HQ hop server-side where CORS does not
 * apply.
 *
 * WHY A SHIM AND NOT IPC
 *
 * IPC would mean the renderer calling `window.vellum.signin(email)`, which
 * means changing `apps/web` and giving the web build a desktop-shaped branch it
 * does not need. It would also mint a second, parallel sign-in path to keep
 * correct forever. The shim keeps ONE implementation of the sign-in contract
 * (the web one) and changes only its transport, on the one platform that needs
 * it. When `apps/web` is next open for edits, `signon-client.ts` can point at
 * `/assistant/__hq/signin` directly under an `isElectron()` check and this file
 * deletes itself — the rail it targets is already the permanent one.
 *
 * WHY NOT FAKE THE CORS GRANT INSTEAD
 *
 * `session.webRequest.onHeadersReceived` can rewrite HQ's preflight 404 into a
 * 204 and inject `Access-Control-Allow-Origin` locally; that was measured to
 * work on Electron 42. It was rejected: it teaches Chromium something untrue,
 * it depends on undocumented ordering between Electron's webRequest and
 * Chromium's CORS checks that has already shifted across Electron majors, and
 * when it shifts again it fails silently back to exactly today's bug. A
 * same-origin request cannot regress that way.
 *
 * BLAST RADIUS
 *
 * The renderer's `fetch` is the SPA's entire network layer, so the shim is
 * written to be incapable of affecting anything else:
 *
 *   - it rewrites only when the first argument is a `string` and is EXACTLY
 *     the HQ sign-in URL — `Request` objects, `URL` objects, prefixed or
 *     query-carrying variants all fall through untouched;
 *   - every other call is `original.apply(this, arguments)`, byte-for-byte the
 *     call the page made;
 *   - the whole install is inside a `try`, and it is idempotent.
 *
 * If anything goes wrong the app is left exactly as it is today: the direct
 * cross-origin call, and the sign-on screen's honest "use justcue.ai instead"
 * fallback.
 */

import type { BrowserWindow } from "electron";

import { APP_PROTOCOL } from "./app-config";
import type { AllowedOrigin } from "./app-origin";
import { resolveAllowedOrigin } from "./app-origin";
import { DEFAULT_HQ_ORIGIN, HQ_SIGNIN_PATH } from "./hq-forward";
import log from "./logger";

/**
 * The absolute URL the shipped renderer requests. Deliberately the constant,
 * not `resolveHqOrigin()`: this is what the WEB BUNDLE was built to call, and
 * it is matched literally. A build that overrode `VITE_CUE_SIGNIN_URL` simply
 * won't match, and falls back to the direct call — fail-safe, not fail-open.
 */
export const RENDERER_HQ_SIGNIN_URL = `${DEFAULT_HQ_ORIGIN}/signin`;

/** Marker the shim sets so a reload can't stack two layers of patch. */
export const HQ_SIGNIN_BRIDGE_FLAG = "__cueHqSigninBridge";

/**
 * Whether this renderer needs the bridge.
 *
 * Only the app's own `app://` origin does. Once the owner has connected, the
 * renderer runs at `https://<name>.justcue.app`, HQ allows that origin, and the
 * direct call is both correct and working — bridging it would add a hop for
 * nothing. Read at call time so connecting mid-session flips it off.
 */
export function shouldBridgeHqSignin(origin: AllowedOrigin): boolean {
  return origin.protocol === `${APP_PROTOCOL}:`;
}

/**
 * The shim, as source. Both URLs are injected via `JSON.stringify` so no
 * caller-supplied value can break out of the string literal.
 *
 * Returns a short status string so `installHqSigninBridge` can log whether it
 * took — a silent no-op here would look exactly like the bug it fixes.
 */
export function buildHqSigninBridgeSource(
  hqSigninUrl: string,
  localPath: string,
): string {
  return `(() => {
  try {
    if (window[${JSON.stringify(HQ_SIGNIN_BRIDGE_FLAG)}]) return "already-installed";
    var original = window.fetch;
    if (typeof original !== "function") return "no-fetch";
    var HQ_SIGNIN = ${JSON.stringify(hqSigninUrl)};
    var LOCAL_SIGNIN = ${JSON.stringify(localPath)};
    var patched = function (input) {
      // Exact-string match only. Anything else is forwarded verbatim, so this
      // patch cannot alter any other request the app makes.
      if (typeof input === "string" && input === HQ_SIGNIN) {
        return original.call(this, LOCAL_SIGNIN, arguments[1]);
      }
      return original.apply(this, arguments);
    };
    window.fetch = patched;
    window[${JSON.stringify(HQ_SIGNIN_BRIDGE_FLAG)}] = true;
    return "installed";
  } catch (err) {
    return "failed";
  }
})()`;
}

/**
 * Install the bridge on a window, re-applying on every document load.
 *
 * `dom-ready` is late enough that the document exists and early enough that no
 * one has typed an email yet. It is also late enough that the SPA's module
 * scripts have already run — which is fine, and checked against the real build:
 * the sign-on client reads the global `fetch` through a default parameter
 * (`async function ts(e, t = fetch)`), evaluated per call, so a later patch is
 * still picked up. Nothing captures `fetch` at module scope.
 */
export function installHqSigninBridge(win: BrowserWindow): void {
  win.webContents.on("dom-ready", () => {
    if (!shouldBridgeHqSignin(resolveAllowedOrigin())) return;
    const source = buildHqSigninBridgeSource(
      RENDERER_HQ_SIGNIN_URL,
      HQ_SIGNIN_PATH,
    );
    win.webContents
      .executeJavaScript(source, true)
      .then((result: unknown) => {
        log.info(`[hq-signin-bridge] ${String(result)}`);
      })
      .catch((err: unknown) => {
        // Non-fatal: sign-on falls back to the direct cross-origin call and,
        // if HQ blocks it, to its own "use justcue.ai" fallback.
        log.warn(`[hq-signin-bridge] install failed: ${String(err)}`);
      });
  });
}
