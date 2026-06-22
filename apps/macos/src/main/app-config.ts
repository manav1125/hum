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
 * Self-host cloud target — the same Render-hosted Cue SPA the iOS app loads
 * (see `apps/web/capacitor.config.ts`). When set, the packaged app loads its
 * renderer directly from this remote https origin instead of serving the
 * bundled snapshot via the `app://` scheme. This is the DEFAULT for Cue: the
 * remote SPA is the `VITE_CUE_SELF_HOST=1` build (connect-screen + durable
 * token auth), so the user signs in once and localStorage persists.
 *
 * Overridable via `CUE_SERVER_URL` (mirrors capacitor's pattern) once a custom
 * domain is set, e.g. `CUE_SERVER_URL=https://cue.example.com/assistant/`.
 * Set `CUE_SERVER_URL=` (empty) to fall back to the legacy bundle-serving
 * `app://` path + managed-platform proxy.
 *
 * The trailing `/assistant/` suffix is deliberate (mirrors capacitor): the
 * SPA is mounted under `/assistant/`, and the SPA root needs the trailing
 * slash to avoid landing on the host's `/assistant/*` NotFound route.
 */
const CUE_SELF_HOST_DEFAULT_URL = "https://cue-app-3yne.onrender.com/assistant/";

/**
 * Resolve the self-host cloud renderer URL, or `null` when self-host is
 * explicitly disabled (`CUE_SERVER_URL` set to empty). Read at call time so a
 * value injected mid-process stays authoritative — the same property the
 * navigation guard, IPC sender guard, and window load all rely on.
 */
export const resolveSelfHostUrl = (): URL | null => {
  const raw = process.env.CUE_SERVER_URL;
  // Unset → default to the pilot Render URL. Explicit empty string → opt out.
  if (raw === "") return null;
  try {
    return new URL(raw ?? CUE_SELF_HOST_DEFAULT_URL);
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
 * Defaults to the self-host cloud origin (`https://…/assistant`) so the
 * desktop app matches the phone. Falls back to the bundled `app://vellum.ai`
 * origin when self-host is disabled via `CUE_SERVER_URL=`.
 */
export const getRendererBaseProd = (): string =>
  selfHostRendererBase() ?? `${APP_PROTOCOL}://${APP_HOST}/assistant`;

/**
 * Back-compat alias. Historically a constant; now a getter result so it
 * reflects `CUE_SERVER_URL` at evaluation time. Kept as a binding for the
 * auxiliary-window modules that import it.
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
