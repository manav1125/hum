/**
 * Connecting this install to a Cue instance.
 *
 * Every owner runs their own deployment (`cue-<name>.justcue.app`, provisioned
 * by HQ), so the app ships pointing at nothing and learns its instance here —
 * once, from the connect link HQ emails. Until then the window serves the
 * bundled SPA, whose Connect screen calls this.
 */

import { z } from "zod";

import { setPersistedSelfHostUrlReader } from "./app-config";
import { handle } from "./ipc";
import log from "./logger";
import { current as currentMainWindow } from "./main-window";
import { readSetting, writeSetting } from "./settings";

/**
 * The instance URL currently being loaded, or null.
 *
 * Guards {@link connectToInstance} against re-entry — see the comment at the
 * loadURL call for what happened without it.
 */
let loadInFlight: string | null = null;

/**
 * Strip query strings out of any URL in a log-bound string.
 *
 * The instance link carries `?cueToken=<jwt>`, so anything that interpolates it
 * into a message is writing a live credential to disk. Exported for its own
 * test — this is a rule about what leaves the process, and it should fail
 * loudly rather than silently stop working.
 */
export function redactUrls(text: string): string {
  return text.replace(/(https?:\/\/[^\s'"]*?)\?[^\s'"]*/g, "$1?<redacted>");
}

/**
 * Normalize a connect link into the SPA-root URL to load.
 *
 * Accepts what HQ actually emails — `https://<instance>/assistant/?cueToken=…`
 * — plus a bare origin, since an owner who knows their instance will type just
 * that. The token is deliberately kept: the SPA consumes `?cueToken=` on boot
 * to seed its session, so dropping it here would land them on a Connect screen
 * served by their own instance.
 *
 * Returns null for anything that isn't a plausible https instance. Exported
 * for tests.
 */
export function normalizeInstanceUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // https only: the token rides in this URL, and the app loads it as the
  // renderer origin. http would put both on the wire in the clear.
  if (url.protocol !== "https:") return null;
  if (!url.hostname.includes(".")) return null;
  // Mount the SPA root. HQ's link already ends `/assistant/`; a bare origin
  // needs it added. The trailing slash keeps the host from serving its
  // `/assistant/*` NotFound route.
  if (!/\/assistant\/?$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/assistant/`;
  } else if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url.toString();
}

/** The instance this install is connected to, or null. */
export const getConnectedInstanceUrl = (): string | null =>
  readSetting("selfHostUrl") ?? null;

/**
 * Point this install at `input` and load it. Returns the resolved URL, or null
 * when the input isn't a usable instance link.
 */
export function connectToInstance(input: string): string | null {
  const resolved = normalizeInstanceUrl(input);
  if (!resolved) {
    log.warn("[self-host-connect] rejected instance link");
    return null;
  }
  writeSetting("selfHostUrl", resolved);
  log.info(`[self-host-connect] connected to ${new URL(resolved).origin}`);
  // `resolveSelfHostUrl` reads the setting at call time, so the window picks
  // up the new instance on this load — no relaunch.
  const win = currentMainWindow();
  if (win && !win.webContents.isDestroyed()) {
    // Idempotent by target URL. This used to call loadURL unconditionally, and
    // the sign-in handoff arrives more than once — macOS can deliver `open-url`
    // repeatedly, and the web page re-opens the link while it waits. Each call
    // started a fresh navigation that CANCELLED the one before it, so every
    // load died with ERR_ABORTED (-3) and the window sat white forever, never
    // signing in. Connecting to the instance you are already loading is a
    // no-op, not a competing navigation.
    if (loadInFlight === resolved) {
      log.info("[self-host-connect] already loading this instance — ignoring");
      return resolved;
    }
    loadInFlight = resolved;
    void win
      .loadURL(resolved)
      .catch((err: unknown) => {
        // Electron's load errors embed the URL they were loading, and this URL
        // carries `?cueToken=` — a live bearer token for the instance. Logging
        // the raw error wrote a months-valid actor JWT into a plaintext file
        // that anything on the machine can read. The failure code is the whole
        // diagnostic value; the credential is not.
        log.warn(`[self-host-connect] load failed: ${redactUrls(String(err))}`);
      })
      .finally(() => {
        // Cleared whether it succeeded or failed: a failed load must not latch
        // the guard shut and make every later attempt a silent no-op, which
        // would turn one transient error into a permanently unusable app.
        if (loadInFlight === resolved) loadInFlight = null;
      });
  }
  return resolved;
}

/** Forget the instance and return to the bundled Connect screen. */
export function disconnectInstance(): void {
  writeSetting("selfHostUrl", "");
  log.info("[self-host-connect] disconnected");
}

export const installSelfHostConnect = (): void => {
  // The persisted instance is the source of truth for every URL resolution.
  // An empty string means disconnected — `new URL("")` would throw, and a
  // blank instance must read as "none", not as a broken one.
  setPersistedSelfHostUrlReader(() => {
    const stored = readSetting("selfHostUrl");
    return stored && stored.trim() ? stored : null;
  });

  handle(
    "vellum:selfHost:connect",
    z.tuple([z.string()]),
    ([input]): string | null => connectToInstance(input),
  );

  handle("vellum:selfHost:connected", z.tuple([]), (): string | null =>
    getConnectedInstanceUrl(),
  );
};
