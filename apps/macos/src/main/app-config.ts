/**
 * Shared application identity constants for the main process.
 *
 * `app-protocol` and `app-host` define the custom scheme the packaged
 * renderer is served from. They're referenced from at least three
 * places today (`index.ts` for `protocol.registerSchemesAsPrivileged`
 * + the `protocol.handle` registration, `main-window.ts` for the
 * BrowserWindow load URL and the same-origin navigation guard,
 * `about.ts` for the About window's prod URL), so they live here as a
 * single source of truth. Drift between callers would have shown up
 * as a broken renderer load rather than a build error, which is
 * exactly the kind of thing a small shared module prevents.
 *
 * The renderer-base URLs are derived: `RENDERER_BASE_PROD` is the
 * packaged path the `app://` protocol handler resolves to; the dev
 * path is honored from `VELLUM_DEV_URL` (vel's edge proxy, or the
 * local Vite default at port 5173). Both end at the `/assistant`
 * suffix that `apps/web/vite.config.ts`'s `base` setting requires.
 */

export const APP_PROTOCOL = "app";
export const APP_HOST = "vellum.ai";
export const VELLUMAPP_PROTOCOL = "vellumapp";
export const BUNDLES_DIR_NAME = "bundles";

const DEV_SERVER_FALLBACK_URL = "http://localhost:5173/assistant";

/**
 * The Cue instance this install is connected to.
 *
 * Each owner runs their own deployment (`cue-<name>.justcue.app`, provisioned
 * by HQ), so there is no such thing as a correct build-time default — the app
 * learns its instance when the owner connects, and remembers it. Until then it
 * serves the bundled SPA over `app://`, whose Connect screen collects it.
 *
 * `CUE_SERVER_URL` overrides for dev/QA, e.g.
 * `CUE_SERVER_URL=https://cue.example.com/assistant/`; empty forces the
 * bundled SPA.
 *
 * The trailing `/assistant/` suffix is deliberate (mirrors capacitor): the
 * SPA is mounted under `/assistant/`, and the SPA root needs the trailing
 * slash to avoid landing on the host's `/assistant/*` NotFound route.
 */
/**
 * Reader for the connected instance, injected by `index.ts` from persisted
 * settings. A DI seam rather than an import so this module stays free of
 * electron-store (and its `app.getPath` side effect at import time).
 *
 * Defaults to "not connected". Cue MUST NOT ship pointing at any real
 * deployment: a build with someone's instance baked in sends every other
 * install's owner to that instance. Each owner gets their own
 * (`cue-<name>.justcue.app`, provisioned by HQ) and connects to it once.
 */
let persistedSelfHostUrlReader: () => string | null = () => null;

/** Wire the persisted-instance reader. See `persistedSelfHostUrlReader`. */
export const setPersistedSelfHostUrlReader = (
  reader: () => string | null,
): void => {
  persistedSelfHostUrlReader = reader;
};

/**
 * Resolve the connected Cue instance's renderer URL, or `null` when there
 * isn't one yet — in which case the app loads its own bundled SPA, whose
 * Connect screen is how the owner names their instance.
 *
 * Order: `CUE_SERVER_URL` (dev/QA override; empty string forces the bundled
 * SPA) → the instance the owner connected to → none. Read at call time so a
 * fresh connection takes effect without a relaunch — the same property the
 * navigation guard, IPC sender guard, and window load all rely on.
 */
export const resolveSelfHostUrl = (): URL | null => {
  const raw = process.env.CUE_SERVER_URL;
  if (raw === "") return null;
  const candidate = raw ?? persistedSelfHostUrlReader();
  if (!candidate) return null;
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
};

/**
 * The self-host base WITHOUT a trailing slash, so auxiliary windows can append
 * `/<subpath>` (`/about`, `/conversations/<id>`, …) the same way they do for
 * the bundled `app://` base. Returns `null` when self-host is disabled.
 */
const selfHostRendererBase = (): string | null => {
  const url = resolveSelfHostUrl();
  if (!url) return null;
  return url.toString().replace(/\/+$/, "");
};

/**
 * Renderer-base URL for the packaged app. Auxiliary windows append
 * their own subpath (`/about`, future `/conversations/<id>`, etc.).
 *
 * The connected instance's origin (`https://…/assistant`) once there is one,
 * so the desktop app matches the phone; otherwise the bundled `app://vellum.ai`
 * origin, which serves the Connect screen.
 */
export const getRendererBaseProd = (): string =>
  selfHostRendererBase() ?? `${APP_PROTOCOL}://${APP_HOST}/assistant`;

/**
 * Back-compat alias, frozen at import. The connected instance is now resolved
 * at call time (it can be set while the app runs), so this snapshot is only
 * correct before a connection — prefer `getRendererBaseProd()`.
 *
 * @deprecated Call `getRendererBaseProd()` instead.
 */
export const RENDERER_BASE_PROD = getRendererBaseProd();

/**
 * Renderer-base URL in dev. Honors `VELLUM_DEV_URL` so the launcher
 * can point at whichever Vite-or-equivalent is up (standalone Vite
 * at :5173, or vel's edge proxy at :3000). Strips any trailing slash
 * so callers can append `/<subpath>` without producing `//`.
 */
export const getDevRendererBase = (): string =>
  (process.env.VELLUM_DEV_URL ?? DEV_SERVER_FALLBACK_URL).replace(/\/+$/, "");

/**
 * SPA-root URL the main BrowserWindow loads.
 *
 * Dev and prod resolve the root document differently. In dev the renderer
 * is served by Vite, whose dev server only serves the app when the request
 * path matches its configured `base` (`/assistant/`) exactly — a slashless
 * `/assistant` returns Vite's "did you mean `/assistant/`?" helper page
 * instead of the SPA. So the dev root carries the trailing slash. In prod
 * the `app://` protocol handler maps the slashless `/assistant` to
 * `index.html`, so `RENDERER_BASE_PROD` loads as-is (a trailing slash would
 * land on the `/assistant/*` NotFound route). Auxiliary windows append a
 * subpath (`/about`) to the base, which already matches Vite's `base`
 * prefix, so only the bare root needs this treatment.
 */
export const getRendererRootUrl = (isPackaged: boolean): string => {
  if (!isPackaged) return `${getDevRendererBase()}/`;
  // Self-host cloud: load the SPA root WITH a trailing slash so the remote
  // host serves the SPA index rather than its `/assistant/*` NotFound route
  // (mirrors capacitor's `server.url`). When self-host is disabled, the
  // `app://` protocol handler maps the slashless `/assistant` to index.html,
  // so the legacy base loads as-is.
  const selfHost = selfHostRendererBase();
  if (selfHost) return `${selfHost}/`;
  return getRendererBaseProd();
};
