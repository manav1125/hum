/**
 * Gateway proxy for the Learn surface (OpenMAIC).
 *
 * OpenMAIC runs as its own service (a Next.js app built with
 * `OPENMAIC_BASE_PATH=/learn`) and is mounted on the Cue origin here so the
 * web app can embed it in a plain same-origin iframe — no native webview, no
 * partner SSO handshake. Active only when `LEARN_UPSTREAM_URL` is set (the
 * self-host image that runs an OpenMAIC sidecar); a 404 no-op otherwise, so
 * platform/k8s deploys are unaffected.
 *
 * Two path families are proxied:
 *   - `/learn/*` → upstream `/learn/*` — pages, `_next` assets, and the API
 *     routes reached via basePath-aware code.
 *   - `/api/*` → upstream `/learn/api/*` — a compatibility shim: OpenMAIC's
 *     client code hardcodes absolute `/api/...` fetch paths that Next's
 *     basePath does not rewrite. The `/api/*` namespace has no other owner on
 *     the gateway origin (guarded by `learn-proxy.test.ts`).
 *
 * Auth: an iframe cannot attach the SPA's Bearer header, so the Learn page
 * first calls `POST /learn/cue-session` (edge auth) and the gateway answers
 * with an HttpOnly `cue_learn` cookie; every proxied request then requires
 * that cookie. The cookie is an HMAC over its own expiry, keyed by a secret
 * generated fresh per gateway process — nothing to store or rotate, and a
 * restart just means the Learn page re-mints on its next mount.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { getLogger } from "../../logger.js";

const log = getLogger("learn-proxy");

const COOKIE_NAME = "cue_learn";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Hop-by-hop / transport headers that must not be copied across the proxy.
 * content-encoding is deliberately NOT here: the upstream fetch runs with
 * decompress:false, so the body bytes stay compressed and the header must
 * travel with them.
 */
const STRIP_RESPONSE_HEADERS = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

function learnUpstreamUrl(): string | undefined {
  const raw = process.env.LEARN_UPSTREAM_URL?.trim();
  if (!raw) return undefined;
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

export function isLearnProxyConfigured(): boolean {
  return learnUpstreamUrl() !== undefined;
}

/**
 * Per-deployment secret the upstream sidecar requires on every request
 * (its OPENMAIC_ACCESS_SECRET middleware). The sidecar shares a private
 * network with other tenants' machines, so the gateway proves it is THE
 * fronting gateway; without the env the header is simply not sent (a
 * sidecar that doesn't enforce it doesn't need it).
 */
function learnUpstreamSecret(): string | undefined {
  const raw = process.env.LEARN_UPSTREAM_SECRET?.trim();
  return raw ? raw : undefined;
}

export function createLearnProxyHandler() {
  // Per-process secret: cookies die with the process, and the Learn page
  // re-mints one on every mount, so ephemerality costs one extra round trip
  // after a gateway restart and buys zero key management.
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

  /** POST /learn/cue-session — edge-authenticated; answers with the cookie. */
  function handleMintSession(req: Request): Response {
    if (!isLearnProxyConfigured()) {
      return Response.json(
        { error: "Learn is not configured" },
        { status: 404 },
      );
    }
    const expiresAtMs = Date.now() + SESSION_TTL_MS;
    const cookie = [
      `${COOKIE_NAME}=${expiresAtMs}.${sign(expiresAtMs)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      ...(isSecureRequest(req) ? ["Secure"] : []),
    ].join("; ");
    return new Response(null, {
      status: 204,
      headers: { "set-cookie": cookie },
    });
  }

  /**
   * Proxy one request to the OpenMAIC upstream. `upstreamPath` is the full
   * path on the upstream origin (already `/learn/...`-prefixed).
   */
  async function proxyTo(
    req: Request,
    upstreamPath: string,
    trusted = false,
  ): Promise<Response> {
    const base = learnUpstreamUrl();
    if (!base) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    // `trusted` marks a caller the gateway itself vouched for — today the
    // co-located daemon on the raw loopback socket (the Learn skill's course
    // reads). Everyone else needs the minted session cookie.
    if (!trusted && !isValidSessionCookie(readSessionCookie(req))) {
      // A top-level/iframe navigation gets sent back into the app, which
      // mints a fresh session on the Learn page; API calls get a plain 401.
      const wantsHtml = req.headers.get("accept")?.includes("text/html");
      if (req.method === "GET" && wantsHtml) {
        return new Response(null, {
          status: 302,
          headers: { location: "/assistant/learn" },
        });
      }
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const reqUrl = new URL(req.url);
    const upstreamUrl = `${base}${upstreamPath}${reqUrl.search}`;

    const headers = new Headers(req.headers);
    // The upstream Host comes from the target URL; tell OpenMAIC the public
    // origin so absolute URLs it builds (e.g. generation pollUrl) stay on the
    // Cue origin.
    headers.delete("host");
    headers.set("x-forwarded-host", reqUrl.host);
    headers.set("x-forwarded-proto", isSecureRequest(req) ? "https" : "http");
    // Never forward a caller-supplied copy of the sidecar's access header.
    headers.delete("x-openmaic-access");
    const secret = learnUpstreamSecret();
    if (secret) headers.set("x-openmaic-access", secret);
    // Compressed pass-through: with decompress:false below, upstream bytes
    // and their content-encoding header cross the proxy verbatim, so the
    // client's accept-encoding can be forwarded too. Without this every
    // /_next chunk crossed the public leg uncompressed (slow first load).
    // The session cookie is gateway business, not OpenMAIC's.
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
        // Streamed pass-through both ways: uploads in, SSE out. No timeout —
        // generation SSE streams are long-lived; the server-level request
        // timeout still bounds them.
        body:
          req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        redirect: "manual",
        // @ts-expect-error duplex is required for streamed bodies and
        // absent from the lib.dom RequestInit type; decompress is Bun's
        // switch to hand back raw (still-compressed) upstream bytes.
        duplex: "half",
        decompress: false,
      });
    } catch (err) {
      log.error({ err, upstreamPath }, "Learn upstream connection failed");
      return Response.json({ error: "Learn is unavailable" }, { status: 502 });
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

  /** /learn and /learn/* — pages, assets, and basePath-aware API routes. */
  function handleLearnPath(
    req: Request,
    subPath: string,
    trusted = false,
  ): Promise<Response> {
    return proxyTo(req, `/learn${subPath}`, trusted);
  }

  /** /api/* — the hardcoded-absolute-path shim (see module doc). */
  function handleApiShim(
    req: Request,
    subPath: string,
    trusted = false,
  ): Promise<Response> {
    return proxyTo(req, `/learn/api${subPath}`, trusted);
  }

  /**
   * OpenMAIC `public/` files referenced by absolute path (avatars, logos,
   * vendored scripts, the wordmark) — the same basePath blind spot as /api,
   * shimmed the same way. The set is enumerated in the route regex; a new
   * top-level public dir upstream needs a matching entry there.
   */
  function handlePublicAssetShim(
    req: Request,
    assetPath: string,
  ): Promise<Response> {
    return proxyTo(req, `/learn${assetPath}`);
  }

  return {
    handleMintSession,
    handleLearnPath,
    handleApiShim,
    handlePublicAssetShim,
  };
}
