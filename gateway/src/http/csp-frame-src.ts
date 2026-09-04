/**
 * Serve-time injection of the deployment's Cue Design host into the SPA's
 * `frame-src` CSP directive.
 *
 * `apps/web/index.html` ships a static meta CSP whose `frame-src` allowlists
 * `https://*.justcue.app` so the Cue Design iframe (served from a
 * `design.<instance>.justcue.app` sibling subdomain) loads. That wildcard is
 * hardcoded: a self-host instance on a custom domain (e.g. `customer.com`,
 * design host `design.customer.com`) is NOT covered by it, so the framed
 * design surface is silently blocked by CSP (ERR_BLOCKED_BY_RESPONSE, nothing
 * in any server log — the frame request dies in the browser).
 *
 * The design host is a per-deployment value (`DESIGN_HOST`), so this can't be
 * baked at build time. When the gateway serves the shell it rewrites the
 * served HTML string: if `DESIGN_HOST` is set and its origin isn't already
 * covered by the existing `frame-src` list, it appends `https://<DESIGN_HOST>`
 * to that directive — and only that directive. It is a no-op when:
 *   - `DESIGN_HOST` is unset (platform/k8s deploys, and Manav's own instance
 *     before the design env is present), or
 *   - the host is already covered (e.g. `design.manav.justcue.app` matches the
 *     static `https://*.justcue.app` wildcard).
 *
 * Deliberately narrow: it touches nothing but the `frame-src` token list and
 * adds nothing but the single configured host. If the meta CSP or its
 * `frame-src` directive isn't found, the HTML is returned unchanged.
 */

/**
 * Whether a single `frame-src` source token already covers the given host's
 * `https://` origin. Handles exact hosts and the CSP host wildcard (`*.` per
 * CSP Level 2/3: matches one or more leading subdomain labels). Scheme-only
 * and keyword tokens (`'self'`, `'none'`, `data:`) never cover a cross-origin
 * host and return false.
 */
function frameSrcCovers(token: string, host: string): boolean {
  const m = /^https?:\/\/(.+)$/i.exec(token);
  if (!m) return false;
  // Strip any port and path — we only match on host.
  const pattern = m[1].toLowerCase().split("/")[0].split(":")[0];
  if (pattern.startsWith("*.")) {
    // `*.justcue.app` matches `a.justcue.app` and `a.b.justcue.app`, but not
    // bare `justcue.app`.
    return host.endsWith(pattern.slice(1));
  }
  return host === pattern;
}

// Group 1 captures everything up to and including the opening quote of the
// `content` attribute; group 2 is that quote; group 3 is the policy text up to
// the matching closing quote (via the `\2` backreference — the policy itself
// contains the *other* quote character in tokens like `'self'`, so a naive
// `[^"']*` would stop short there).
const CSP_META_RE =
  /(<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*\bcontent=(["']))([\s\S]*?)\2/i;
const FRAME_SRC_RE = /frame-src([^;]*)/i;

/**
 * Return `html` with the configured `DESIGN_HOST` origin added to the meta
 * CSP's `frame-src` directive, or unchanged if there's nothing to do. `host`
 * defaults to `process.env.DESIGN_HOST`.
 */
export function injectDesignFrameSrc(
  html: string,
  host: string | undefined = process.env.DESIGN_HOST,
): string {
  const designHost = host?.trim().toLowerCase();
  if (!designHost) return html;

  return html.replace(CSP_META_RE, (full, pre, quote, content) => {
    const fm = FRAME_SRC_RE.exec(content);
    if (!fm) return full;
    const tokens = fm[1].trim().split(/\s+/).filter(Boolean);
    if (tokens.some((t) => frameSrcCovers(t, designHost))) return full;
    const nextDirective = `frame-src ${[...tokens, `https://${designHost}`].join(" ")}`;
    return pre + content.replace(FRAME_SRC_RE, () => nextDirective) + quote;
  });
}
