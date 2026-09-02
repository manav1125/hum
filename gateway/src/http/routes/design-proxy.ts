/**
 * Gateway proxy for the Cue Design surface (OpenDesign fork).
 *
 * Cue Design runs as its own sidecar service (the OpenDesign daemon serving
 * its API plus the static web export at the origin root). Its frontend has
 * hundreds of hardcoded absolute paths (`/api/...`, `/_next/...`,
 * `/artifacts/...`) and no basePath support, so unlike Learn it cannot be
 * mounted under a path prefix on the app origin. It gets its own hostname
 * instead: requests whose Host matches `DESIGN_HOST` are proxied whole-origin
 * to `DESIGN_UPSTREAM_URL` before the gateway's path router runs. Both envs
 * must be set (the self-host image that runs the sidecar); no-op otherwise, so
 * platform/k8s deploys are unaffected.
 *
 * Auth mirrors the Learn proxy's HMAC-cookie scheme with one twist: the
 * design surface is a different origin, so the cookie is minted on the APP
 * origin (`POST /design/cue-session`, edge auth) with
 * `Domain=<registrable parent of DESIGN_HOST>` — the browser then sends it on
 * the top-level navigation to the design host (same-site under SameSite=Lax).
 * The SPA mints before opening the surface; an unauthenticated HTML GET on
 * the design host is bounced to the app origin to re-mint.
 *
 * The sidecar itself runs with OPEN_DESIGN_DISABLE_API_AUTH=1 and is only
 * reachable over the private network from this gateway, which authenticates
 * every request — the exact trusted-reverse-proxy deployment the upstream
 * daemon documents.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { getLogger } from "../../logger.js";

const log = getLogger("design-proxy");

const COOKIE_NAME = "cue_design";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Hop-by-hop headers that must not cross the proxy (see learn-proxy). */
const STRIP_RESPONSE_HEADERS = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

function designUpstreamUrl(): string | undefined {
  const raw = process.env.DESIGN_UPSTREAM_URL?.trim();
  if (!raw) return undefined;
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function designHost(): string | undefined {
  const raw = process.env.DESIGN_HOST?.trim().toLowerCase();
  return raw || undefined;
}

/**
 * The cookie Domain: the design host minus its first label, so a cookie set
 * on the app origin (`justcue.ai`) also reaches `design.justcue.ai`. A
 * single-label DESIGN_HOST (no dot) gets no Domain attribute — host-only
 * cookies are the only safe fallback there.
 */
function cookieDomain(): string | undefined {
  const host = designHost();
  if (!host) return undefined;
  const dot = host.indexOf(".");
  if (dot === -1) return undefined;
  return host.slice(dot + 1);
}

export function isDesignProxyConfigured(): boolean {
  return designUpstreamUrl() !== undefined && designHost() !== undefined;
}

/** Whether this request is addressed to the design hostname. */
export function isDesignHostRequest(req: Request): boolean {
  const host = designHost();
  if (!host) return false;
  const reqHost = (
    req.headers.get("x-forwarded-host") ?? req.headers.get("host")
  )
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (!reqHost) return false;
  // Strip a port if present (host header may carry one on dev setups).
  const bare = reqHost.startsWith("[")
    ? reqHost
    : (reqHost.split(":")[0] ?? reqHost);
  return bare === host;
}

export function createDesignProxyHandler() {
  // Per-process secret; same trade as learn-proxy — cookies die with the
  // process and the SPA re-mints on the next launch of the surface.
  const secret = randomBytes(32);

  function sign(expiresAtMs: number): string {
    return createHmac("sha256", secret)
      .update(String(expiresAtMs))
      .digest("hex");
  }

  function isValidSessionCookie(value: string | undefined): boolean {
    if (!value) return false;
    const dot = value.indexOf(".");
    if (dot === -1) return false;
    const expiresAtMs = Number(value.slice(0, dot));
    if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) return false;
    const expected = Buffer.from(sign(expiresAtMs));
    const actual = Buffer.from(value.slice(dot + 1));
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  function readSessionCookie(req: Request): string | undefined {
    const header = req.headers.get("cookie");
    if (!header) return undefined;
    for (const part of header.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === COOKIE_NAME) return rest.join("=");
    }
    return undefined;
  }

  function isSecureRequest(req: Request): boolean {
    if (req.headers.get("x-forwarded-proto") === "https") return true;
    return new URL(req.url).protocol === "https:";
  }

  /**
   * POST /design/cue-session — edge-authenticated, on the APP origin; answers
   * with the parent-domain cookie plus the design surface URL so the SPA can
   * navigate without re-deriving the hostname.
   */
  function handleMintSession(req: Request): Response {
    if (!isDesignProxyConfigured()) {
      return Response.json(
        { error: "Design is not configured" },
        { status: 404 },
      );
    }
    const expiresAtMs = Date.now() + SESSION_TTL_MS;
    const domain = cookieDomain();
    const secure = isSecureRequest(req);
    const cookie = [
      `${COOKIE_NAME}=${expiresAtMs}.${sign(expiresAtMs)}`,
      "Path=/",
      ...(domain ? [`Domain=${domain}`] : []),
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      ...(secure ? ["Secure"] : []),
    ].join("; ");
    return Response.json(
      { url: `${secure ? "https" : "http"}://${designHost()}/` },
      { headers: { "set-cookie": cookie } },
    );
  }

  /**
   * Whole-origin proxy for requests addressed to the design hostname. The
   * path crosses verbatim — the sidecar serves the app at its origin root.
   */
  async function handleDesignHost(req: Request): Promise<Response> {
    const base = designUpstreamUrl();
    if (!base) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    if (!isValidSessionCookie(readSessionCookie(req))) {
      // A top-level navigation bounces to the app origin (registrable parent
      // of the design host), where the SPA mints a fresh session and returns.
      const wantsHtml = req.headers.get("accept")?.includes("text/html");
      const parent = cookieDomain();
      if (req.method === "GET" && wantsHtml && parent) {
        const scheme = isSecureRequest(req) ? "https" : "http";
        return new Response(null, {
          status: 302,
          headers: { location: `${scheme}://${parent}/assistant/design` },
        });
      }
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const reqUrl = new URL(req.url);
    const upstreamUrl = `${base}${reqUrl.pathname}${reqUrl.search}`;

    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.set("x-forwarded-host", reqUrl.host);
    headers.set("x-forwarded-proto", isSecureRequest(req) ? "https" : "http");
    // The session cookie is gateway business, not the sidecar's.
    const cookieHeader = req.headers.get("cookie");
    if (cookieHeader) {
      const remaining = cookieHeader
        .split(";")
        .map((c) => c.trim())
        .filter((c) => !c.startsWith(`${COOKIE_NAME}=`));
      if (remaining.length > 0) headers.set("cookie", remaining.join("; "));
      else headers.delete("cookie");
    }

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        // Streamed both ways: uploads in, generation SSE out. No timeout —
        // the server-level request timeout bounds long streams.
        body:
          req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        redirect: "manual",
        // @ts-expect-error duplex is required for streamed bodies and absent
        // from lib.dom types; decompress is Bun's raw-bytes pass-through
        // switch (see learn-proxy).
        duplex: "half",
        decompress: false,
      });
    } catch (err) {
      log.error(
        { err, path: reqUrl.pathname },
        "Design upstream connection failed",
      );
      return Response.json({ error: "Design is unavailable" }, { status: 502 });
    }

    const responseHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      if (!STRIP_RESPONSE_HEADERS.has(key)) responseHeaders.append(key, value);
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  /**
   * GET /design/skills — read-only catalog bridge for the Skills tab.
   *
   * Unlike the whole-origin host proxy, this lives on the APP origin: the Cue
   * SPA fetches it same-origin with its Bearer edge token (the route is
   * edge-authed at registration), and the gateway fetches the sidecar's
   * design-skill catalog server-side over the private network. Read-only —
   * the design skills are display cards in Cue's unified Skills tab, never
   * installed or removed from here. 404s (harmlessly) when design isn't
   * configured, which the tab treats as "no design skills".
   */
  async function handleSkillsList(_req: Request): Promise<Response> {
    const base = designUpstreamUrl();
    if (!base) {
      return Response.json({ skills: [] }, { status: 200 });
    }
    let upstream: Response;
    try {
      upstream = await fetch(`${base}/api/skills`, {
        headers: { origin: `https://${designHost()}` },
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      log.error({ err }, "Design skills upstream failed");
      // Fail-open to an empty list: a design-side outage must not error the
      // Skills tab, only omit its Design section.
      return Response.json({ skills: [] }, { status: 200 });
    }
    if (!upstream.ok) {
      return Response.json({ skills: [] }, { status: 200 });
    }
    const body = await upstream.text();
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  return { handleMintSession, handleDesignHost, handleSkillsList };
}
