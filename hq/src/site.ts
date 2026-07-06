/**
 * Cue HQ — static serving for the marketing/commerce site (site/ at the
 * repo root). HQ is the production origin for the site: every non-API GET
 * falls through to this module, so /pricing, /redeem, /welcome, /signin,
 * /account and the landing page are all served from the same host the
 * commerce endpoints live on (no CORS, cookies just work).
 *
 * Clean URLs: /pricing → pricing.html, / → index.html. The Stripe checkout
 * redirect contract (README "Website integration contract") sends customers
 * to /checkout/success and /checkout/cancel — mapped here onto the designed
 * pages (welcome.html / pricing.html) so stripe.ts needs no changes.
 *
 * Env contract:
 *   HQ_SITE_DIR — absolute path to the site directory. Default: ../site
 *   relative to hq/ (i.e. the repo-root site/). Missing dir ⇒ every static
 *   lookup misses and the API's JSON 404 answers instead.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

/** Resolve the site directory (HQ_SITE_DIR, default repo-root site/). */
export function resolveSiteDir(): string {
  const fromEnv = process.env.HQ_SITE_DIR;
  if (fromEnv) {
    return isAbsolute(fromEnv) ? fromEnv : resolve(process.cwd(), fromEnv);
  }
  // hq/src/site.ts → hq/ → repo root → site/
  return resolve(import.meta.dir, "..", "..", "site");
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jsx": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".toml": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** Checkout-redirect contract → designed pages. */
const ALIASES: Record<string, string> = {
  "/": "index.html",
  "/checkout/success": "welcome.html",
  "/checkout/cancel": "pricing.html",
};

/**
 * Map a URL path to a file inside siteDir, or null.
 * Order: alias → exact file → clean URL (<path>.html).
 */
export function resolveSitePath(siteDir: string, urlPath: string): string | null {
  const aliased = ALIASES[urlPath];
  const rel = aliased ?? decodeURIComponent(urlPath).replace(/^\/+/, "");
  if (!rel) return null;
  // Traversal guard: the normalized path must stay inside siteDir.
  const abs = normalize(join(siteDir, rel));
  if (abs !== siteDir && !abs.startsWith(siteDir + "/")) return null;

  if (existsSync(abs) && statSync(abs).isFile()) return abs;
  if (!aliased && !rel.includes(".")) {
    const clean = `${abs}.html`;
    if (existsSync(clean) && statSync(clean).isFile()) return clean;
  }
  return null;
}

/**
 * Serve a GET/HEAD request from the site directory. Returns null when no
 * file matches (the caller answers with its JSON 404).
 */
export async function serveSite(
  siteDir: string,
  req: Request,
  urlPath: string,
): Promise<Response | null> {
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  const filePath = resolveSitePath(siteDir, urlPath);
  if (!filePath) return null;
  const file = Bun.file(filePath);
  return new Response(method === "HEAD" ? null : file, {
    headers: {
      "Content-Type": contentTypeFor(filePath),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": filePath.endsWith(".html")
        ? "no-cache"
        : "public, max-age=300",
    },
  });
}
