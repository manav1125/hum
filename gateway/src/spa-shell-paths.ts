/**
 * SPA shell path allowlist for the self-hosted web client.
 *
 * The gateway serves the web build under `/assistant/*` (see `serveSpaAsset`
 * in index.ts), but the SPA's router also owns a handful of PRE-APP paths
 * outside that prefix — magic-link landings and onboarding entries minted by
 * HQ emails and older builds. Before this allowlist, a GET to
 * `/onboarding/welcome` fell through to the auth gate and rendered raw
 * `{"error":"Unauthorized"}` JSON in the browser (QA finding P1-7).
 *
 * These paths never map to real asset files — they always get `index.html`
 * so the client router can take over (it redirects them into their
 * `/assistant/*` homes). API surfaces (`/v1`, `/auth`, `/healthz`, …) are
 * untouched: only the exact roots and their subpaths listed here match.
 */

/** Pre-app client routes served the SPA shell (exact path or any subpath). */
export const SPA_SHELL_ROOTS = [
  "/onboarding",
  "/welcome",
  "/select-assistant",
  "/review-terms",
] as const;

/**
 * True when `pathname` is a pre-app SPA client route that should be served
 * the `index.html` shell (GET only — callers gate on method).
 */
export function isSpaShellPath(pathname: string): boolean {
  return SPA_SHELL_ROOTS.some(
    (root) => pathname === root || pathname.startsWith(`${root}/`),
  );
}
