/**
 * Cue self-host bootstrap.
 *
 * Lets the hosted SPA (served same-origin from the gateway) authenticate to a
 * self-hosted Cue gateway WITHOUT the Vellum Platform's token brokering. A
 * one-time `?cueToken=<actor JWT>` (optionally `&cueExp=<ms>`) seeds the
 * gateway-session token store and flips a persistent self-host flag. After
 * that, `isGatewayAuthEnabled()` reports true and the standard gateway-auth
 * short-circuit (`applyGatewayAuthShortCircuit`) boots straight into an
 * authenticated `self` session against `window.location.origin`.
 *
 * The token is minted out-of-band via `POST /v1/guardian/init` (see
 * deploy/README + the cue-render-selfhost memory).
 */

// Mirror of the gateway-session storage keys (kept in sync deliberately so this
// boot-time module has no import cycle with the auth layer).
const LS_TOKEN_KEY = "vellum:gw:token";
const LS_EXPIRES_KEY = "vellum:gw:expiresAt";
const LS_TOKEN_SOURCE_KEY = "vellum:gw:tokenSource";
const LS_SELF_HOST_FLAG = "cue:selfHost";

// The durable refresh credential: the long-lived (~30d) `actor_client_v1` JWT
// the user pasted. The gateway token store (`vellum:gw:token`) is treated as a
// short-lived derived slot the rest of the auth layer rotates and clears (on
// 401s, source mismatches, resume re-mints); persisting the actor token under
// its OWN key means a cleared gateway token can always be silently re-derived
// from it for the full life of the actor token, across app closes/reopens and
// SSE drops — instead of stranding the user on the Connect screen. We re-hydrate
// the gateway token slot from this on boot/resume whenever the slot is missing.
const LS_ACTOR_TOKEN_KEY = "cue:selfHost:actorToken";

/**
 * Cross-surface handoff contract for the Cue browser extension.
 *
 * To pair with a REMOTE instance, the extension presents the owner's signed-in
 * `actor_client_v1` session token to the gateway's `POST /v1/pair/session`. The
 * extension has no identity provider of its own; it reads that token straight
 * out of the open Cue tab's `localStorage` (it has `<all_urls>` + `scripting`
 * permission — see `clients/chrome-extension/background/session-token.ts`).
 *
 * This array is the SOURCE OF TRUTH for the keys the extension reads, in
 * preference order: the durable actor-token key first, then the active
 * gateway-token slot as a fallback for sessions seeded before the durable key
 * existed. The extension keeps its own copy of these strings (it cannot import
 * this module across the repo boundary); exporting them here makes the contract
 * explicit and gives `cue-self-host.test.ts` a hook to guard against a silent
 * rename that would break pairing. Keep the two in sync.
 *
 * The web app already "makes the token available" simply by persisting it under
 * these keys in self-host mode (`writeSelfHostToken`) and clearing it on
 * disconnect (`clearSelfHostMode`); no extra write is needed. The token never
 * leaves the machine except when the extension sends it to this same instance's
 * own HTTPS origin, on an explicit user Connect.
 */
export const EXTENSION_SESSION_TOKEN_LS_KEYS = [
  LS_ACTOR_TOKEN_KEY,
  LS_TOKEN_KEY,
] as const;

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d — matches actor_client_v1

/** True when this SPA has been put into self-hosted gateway mode. */
export function isSelfHostMode(): boolean {
  try {
    return localStorage.getItem(LS_SELF_HOST_FLAG) === "1";
  } catch {
    return false;
  }
}

/**
 * True when this build is the Cue self-host SPA (served same-origin from a
 * self-hosted gateway). Set at build time via `VITE_CUE_SELF_HOST=1` in the
 * deploy build command. Distinguishes the self-host deploy from the Vellum
 * Platform build (platform auth) and the Electron build (local lockfile), so
 * only this deploy shows the paste-token Connect screen on a fresh browser.
 */
export function isCueSelfHostDeploy(): boolean {
  try {
    const env = import.meta.env as Record<string, string | undefined>;
    if (env.VITE_CUE_SELF_HOST === "1") return true;
    // Safety net: every customer instance is served from a `*.justcue.app`
    // subdomain (HQ provisions the DNS), so that host is unambiguously a Cue
    // self-host deploy even when the web-dist was built without the flag.
    // Without this, a build missing VITE_CUE_SELF_HOST=1 falls through to the
    // Vellum-Platform auth — the "Vellum page" a cold visitor hit. The Vellum
    // platform lives on *.vellum.ai and HQ on justcue.ai, so neither matches.
    const host = window.location.hostname;
    if (host.endsWith(".justcue.app") || host.endsWith(".justcue.io")) {
      return true;
    }
    // Test/escape hatch: `?cueConnect=1` forces the Connect screen on any build
    // (e.g. a local dev server) without weakening anything — it only renders a
    // token-entry form, it does not grant access.
    return new URLSearchParams(window.location.search).has("cueConnect");
  } catch {
    return false;
  }
}

/**
 * True when a gateway token is stored AND still usable.
 *
 * Expiry matters here, not just presence. This answers "should we show the
 * Connect screen?", and an expired token is not a session — it is the exact
 * moment the user needs to sign in again. Treating a stale token as valid made
 * the app skip Connect and fall through to the Vellum-Platform welcome screen,
 * offering a "Log In" button that runs platform OAuth a single-tenant
 * self-host instance can't participate in. The result was a dead end with a
 * generic "Something went wrong", from which the user could not recover
 * without clearing storage by hand.
 *
 * A token whose expiry we cannot read is treated as usable: the gateway is the
 * real authority, and a malformed-but-accepted credential must not bounce a
 * signed-in user out to Connect.
 */
function hasStoredGatewayToken(): boolean {
  try {
    const token = localStorage.getItem(LS_TOKEN_KEY);
    if (!token) return false;
    const expMs = readStoredExpiryMs() ?? decodeActorTokenExpMs(token) ?? null;
    if (expMs !== null && expMs <= Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * The persisted expiry stamp, normalised to epoch-MILLISECONDS.
 *
 * `writeSelfHostToken` stores this key in SECONDS (`Math.floor(expMs / 1000)`)
 * despite the `expiresAt` name. Reading it as milliseconds makes every stamp
 * look decades in the past, which marks even a freshly-issued token expired and
 * bounces the user back to the sign-in screen in a loop. Anything below the
 * year-2001 boundary in ms cannot be a real ms timestamp, so it is seconds.
 */
const MS_EPOCH_FLOOR = 1_000_000_000_000; // 2001-09-09 in ms

function readStoredExpiryMs(): number | null {
  try {
    const raw = localStorage.getItem(LS_EXPIRES_KEY);
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < MS_EPOCH_FLOOR ? n * 1000 : n;
  } catch {
    return null;
  }
}

/**
 * Decode a JWT's `exp` claim (seconds since epoch) to epoch-ms, or null when the
 * token is malformed / has no numeric `exp`. Pure base64url payload decode — no
 * signature verification (the gateway verifies; the client only needs the
 * expiry to decide whether the durable credential is still worth trusting).
 */
export function decodeActorTokenExpMs(token: string | null): number | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(payload);
    const claims = JSON.parse(json) as { exp?: unknown };
    const exp = claims.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
    return exp * 1000;
  } catch {
    return null;
  }
}

/** The durable pasted actor token, if one is stored. */
export function getStoredActorToken(): string | null {
  try {
    const durable = localStorage.getItem(LS_ACTOR_TOKEN_KEY);
    if (durable) return durable;
    // Migration for sessions seeded before the durable key existed: the pasted
    // actor token was only written to the gateway-token slot. Backfill the
    // durable key from it so the refresh credential survives the next gateway
    // clear without forcing a re-paste. Only in self-host mode — the local
    // (desktop) gateway slot holds a genuinely short-lived minted token, not a
    // durable actor token.
    if (isSelfHostMode()) {
      const legacy = localStorage.getItem(LS_TOKEN_KEY);
      if (legacy && legacy.split(".").length === 3) {
        try {
          localStorage.setItem(LS_ACTOR_TOKEN_KEY, legacy);
        } catch {
          // localStorage unavailable — fall through and return the value anyway
        }
        return legacy;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether the stored actor token is still usable as a refresh credential: it
 * exists and (when its `exp` is decodable) has not passed expiry. A token whose
 * `exp` we cannot decode is treated as valid — the gateway is the real
 * authority, and bouncing a present credential to the Connect screen on a parse
 * quirk is worse than letting the gateway reject it. Only a decodably-expired
 * token (or no token at all) is a hard sign-out.
 */
export function isStoredActorTokenValid(): boolean {
  const token = getStoredActorToken();
  if (!token) return false;
  const expMs = decodeActorTokenExpMs(token);
  if (expMs === null) return true;
  // 60s skew margin, mirroring gateway-session's isTokenExpired.
  return Date.now() < expMs - 60_000;
}

/**
 * Whether to render the Cue Connect screen instead of booting the router: a
 * self-host deploy with no stored gateway token.
 *
 * Gated on TOKEN PRESENCE, not the `cue:selfHost` flag. The auth layer clears
 * the token on a 401 (`clearGatewayToken`) but leaves the flag set, so a device
 * whose token expired or was revoked must still be able to re-connect — gating
 * on the flag would strand it on the old onboarding screen. A `?cueToken=` seed
 * runs in `bootstrapCueSelfHost()` before this check, so that path still boots
 * straight through to the authenticated session.
 */
export function shouldShowCueConnect(): boolean {
  return isCueSelfHostDeploy() && !hasStoredGatewayToken();
}

/**
 * The desktop app's own copy of the SPA is served from `app://`, so the
 * hostname test above can never see that the app is pointed at a self-host
 * instance. Ask the main process instead: it is the thing that actually holds
 * the connection.
 *
 * Without this the desktop app falls through to the Vellum-Platform welcome
 * screen and offers a "Log In" button that runs platform OAuth — an auth model
 * a single-tenant self-host instance does not participate in, so it can only
 * ever fail. A self-host desktop user must land on the Connect screen, which
 * signs them in by email.
 */
export async function isElectronSelfHostConnected(): Promise<boolean> {
  try {
    const connected = await globalThis.window?.vellum?.selfHost?.connected?.();
    return typeof connected === "string" && connected.trim().length > 0;
  } catch {
    return false;
  }
}

/** The instance the desktop app is connected to, for display. */
export async function connectedSelfHostInstance(): Promise<string | null> {
  try {
    const connected = await globalThis.window?.vellum?.selfHost?.connected?.();
    return typeof connected === "string" && connected.trim() ? connected : null;
  } catch {
    return null;
  }
}

/**
 * Async form of {@link shouldShowCueConnect} that also covers the desktop app.
 * Kept separate so the synchronous web path is unchanged.
 */
export async function shouldShowCueConnectAsync(): Promise<boolean> {
  if (shouldShowCueConnect()) return true;
  // Never override an existing session, and never hijack local-daemon mode:
  // this only fires when the main process reports a real self-host connection.
  if (hasStoredGatewayToken()) return false;
  if (await isElectronSelfHostConnected()) return true;

  // A FRESH desktop install, opened before the user has clicked their email
  // link. Every signal above is false here: the packaged origin is
  // `app://vellum.ai` and the bundle deliberately omits VITE_CUE_SELF_HOST
  // (setting it would kill the local-daemon path), so `isCueSelfHostDeploy()`
  // is false; there is no stored token; and nothing is connected yet. That left
  // the user on the Vellum welcome screen choosing between a "Log In" that runs
  // OAuth against an account they don't have and a hosting chooser whose Cue
  // Cloud option is disabled — a genuine dead end on first run.
  //
  // The `selfHost` bridge's presence is what makes this safe: only the Cue
  // desktop preload exposes it. An install that has local daemons is a
  // local-mode user and must keep the lockfile flow, so this is gated on there
  // being no local assistants either.
  return hasSelfHostBridge() && !hasLocalDaemonAssistants();
}

/**
 * True when the Cue desktop preload exposed its self-host bridge. Doubles as
 * the Electron check — the web build has no `window.vellum` at all — which is
 * why this module needs no import from the runtime layer.
 */
function hasSelfHostBridge(): boolean {
  try {
    return globalThis.window?.vellum?.selfHost != null;
  } catch {
    return false;
  }
}

/**
 * Whether the lockfile lists at least one LOCAL daemon assistant, i.e. this is
 * a local-mode install whose own flow must not be hijacked by the Connect
 * screen.
 *
 * Reads the lockfile's localStorage mirror directly and mirrors
 * `isLocalAssistant` rather than importing `@/lib/local-mode`: that module
 * imports FROM this one, so a normal import would close a cycle in a
 * boot-critical path. Same deliberate duplication as the storage keys above —
 * keep the predicate in sync with `local-mode.ts`.
 */
function hasLocalDaemonAssistants(): boolean {
  try {
    const raw = localStorage.getItem("vellum:local:lockfile");
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    const assistants = (parsed as { assistants?: unknown })?.assistants;
    if (!Array.isArray(assistants)) return false;
    return assistants.some((a) => {
      const entry = a as {
        cloud?: unknown;
        resources?: { gatewayPort?: unknown };
      };
      return entry?.cloud !== "vellum" && entry?.resources?.gatewayPort != null;
    });
  } catch {
    // Unreadable/corrupt lockfile: treat as "no local daemons" so a fresh
    // install still gets a way in rather than dead-ending again.
    return false;
  }
}

/**
 * Seed the gateway-session token store from a user-supplied value and flip the
 * self-host flag. Accepts either a raw actor JWT, or a full connect string/URL
 * containing `cueToken=<jwt>` (and optionally `cueExp=<ms>`) — so a user can
 * paste either the token or the whole link they were handed. Returns true on
 * success, false if no usable token could be parsed.
 */
export function seedCueToken(input: string): boolean {
  const raw = input.trim();
  if (!raw) return false;

  let token = raw;
  let expMs = 0;

  // If they pasted a URL or a `cueToken=...` query fragment, extract from it.
  if (raw.includes("cueToken=") || raw.includes("?") || raw.includes("://")) {
    try {
      const qs = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw;
      const params = new URLSearchParams(qs);
      const fromUrl = params.get("cueToken");
      if (fromUrl) {
        token = fromUrl;
        const e = Number(params.get("cueExp"));
        if (Number.isFinite(e) && e > 0) expMs = e;
      }
    } catch {
      // fall through and treat the whole string as the token
    }
  }

  // A bare JWT has three dot-separated segments. Reject obvious non-tokens so a
  // mistyped paste surfaces an error instead of seeding garbage.
  if (token.split(".").length !== 3) return false;

  writeSelfHostToken(token, expMs);
  return true;
}

/**
 * Persist the pasted actor token as both the durable refresh credential and the
 * active gateway-session token, and set the self-host flag.
 *
 * Expiry resolution: an explicit `cueExp` (from the connect link) wins; else the
 * token's own decoded `exp`; else the 30-day default. The actor token's real
 * `exp` is the source of truth for sign-out decisions (see
 * `isStoredActorTokenValid`), so deriving the stored expiry from it — rather
 * than always stamping a fresh 30d — keeps the gateway-token slot honest about
 * the credential's true remaining life.
 */
function writeSelfHostToken(token: string, explicitExpMs = 0): void {
  const decodedExpMs = decodeActorTokenExpMs(token);
  const expMs =
    explicitExpMs > 0
      ? explicitExpMs
      : decodedExpMs !== null
        ? decodedExpMs
        : Date.now() + DEFAULT_TTL_MS;
  const expSec = Math.floor(expMs / 1000);
  try {
    // Durable refresh credential — survives gateway-token clears (401s,
    // source-mismatch re-mints) so the session can always be re-derived.
    localStorage.setItem(LS_ACTOR_TOKEN_KEY, token);
    localStorage.setItem(LS_TOKEN_KEY, token);
    localStorage.setItem(LS_EXPIRES_KEY, String(expSec));
    localStorage.setItem(LS_TOKEN_SOURCE_KEY, window.location.origin);
    localStorage.setItem(LS_SELF_HOST_FLAG, "1");
  } catch {
    // localStorage unavailable — nothing more we can do
  }
}

/**
 * Re-hydrate the gateway-session token slot from the durable actor token when
 * the slot is missing/expired but the actor token is still valid. Idempotent;
 * returns true when a usable gateway token is in place afterwards.
 *
 * This is the recovery seam the auth layer calls on boot, app resume, and after
 * a 401 cleared the gateway token: instead of signing out, re-stamp the actor
 * token into the gateway slot so `getGatewayToken()` (and therefore the SSE /
 * runtime-proxy `Authorization` header) keep working for the life of the actor
 * token. A no-op outside self-host mode.
 */
export function rehydrateGatewayTokenFromActor(): boolean {
  if (!isSelfHostMode()) return false;
  if (!isStoredActorTokenValid()) return false;
  if (hasStoredGatewayToken()) return true;
  const token = getStoredActorToken();
  if (!token) return false;
  writeSelfHostToken(token);
  return true;
}

/** Clear self-host mode + the seeded token (e.g. on an explicit disconnect). */
export function clearSelfHostMode(): void {
  try {
    localStorage.removeItem(LS_SELF_HOST_FLAG);
    localStorage.removeItem(LS_ACTOR_TOKEN_KEY);
    localStorage.removeItem(LS_TOKEN_KEY);
    localStorage.removeItem(LS_EXPIRES_KEY);
    localStorage.removeItem(LS_TOKEN_SOURCE_KEY);
  } catch {
    // localStorage unavailable
  }
}

/**
 * Consume a one-time `?cueToken=` from the URL: seed the gateway-session token
 * store, flip the self-host flag, and strip the param so the credential never
 * lingers in the address bar or history. Idempotent; safe to call on every boot
 * (a no-op when no `cueToken` is present). Must run before the assistant
 * lifecycle first reads the gateway token.
 */
/**
 * True when this page load consumed a `?cueToken=` magic link. The param is
 * stripped from the URL immediately after seeding, so anything rendering later
 * (the desktop-handoff offer) can't detect it from `location` — it reads this.
 */
let seededFromMagicLink = false;
export function didSeedFromMagicLink(): boolean {
  return seededFromMagicLink;
}

export function bootstrapCueSelfHost(): void {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return;
  }
  const token = params.get("cueToken");
  if (!token) {
    // No fresh `?cueToken=` to seed — but a prior 401 may have cleared the
    // short-lived gateway-token slot while the durable actor token is still
    // valid. Re-stamp it before the boot gate (`shouldShowCueConnect`) reads
    // the slot, so a reopen re-enters the authenticated session instead of
    // bouncing to the Connect screen for the life of the actor token.
    rehydrateGatewayTokenFromActor();
    return;
  }

  // `accessTokenExpiresAt` is epoch-ms; an explicit `cueExp` wins, otherwise
  // `writeSelfHostToken` derives the expiry from the token's own `exp` claim.
  seededFromMagicLink = true;
  const expMsRaw = Number(params.get("cueExp"));
  const explicitExpMs =
    Number.isFinite(expMsRaw) && expMsRaw > 0 ? expMsRaw : 0;

  writeSelfHostToken(token, explicitExpMs);

  // Strip the credential params from the URL without a reload.
  params.delete("cueToken");
  params.delete("cueExp");
  try {
    const qs = params.toString();
    const next =
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
    window.history.replaceState(null, "", next);
  } catch {
    // history unavailable — harmless
  }
}
