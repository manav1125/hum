/**
 * Composio-backed OAuth connection.
 *
 * Bridges the existing `assistant oauth request --provider <X>` machinery (and
 * therefore every connector skill that uses it) onto the Composio connector
 * layer. When a provider has an ACTIVE Composio connection for the current
 * user, the authenticated request is made *through Composio's request proxy*
 * (`tools/execute/proxy`) — so the native managed-OAuth path (dead in this
 * fork, needs the hosted platform) is no longer required for connected apps.
 *
 * Why the proxy and not the raw token: Composio refreshes provider tokens
 * internally and only injects a live one on its own execute/proxy path. The
 * `data.access_token` it exposes on a connected account is frequently stale
 * and 401s when used directly. Routing through the proxy lets Composio attach
 * the current token (and handle refresh) so calls succeed reliably.
 *
 * Composio's connections are per-toolkit (gmail, googlecalendar, …) while the
 * native `google` provider spans Gmail/Calendar/People on one credential, so
 * requests are mapped to the right toolkit by host.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { recordActiveComposioToolkits } from "../capabilities/composio-connection-status.js";
import { getLogger } from "../util/logger.js";
import {
  type ComposioAccountRow,
  selectOwnedAccounts,
} from "./composio-account-ownership.js";
import type {
  OAuthConnection,
  OAuthConnectionRequest,
  OAuthConnectionResponse,
} from "./connection.js";
import {
  recordConnectorFailure,
  recordConnectorSuccess,
} from "./connector-health-store.js";

const log = getLogger("composio-oauth");

/**
 * Composio faults that are about CUE's credentials rather than the user's
 * connection: an API key missing a capability, a disabled feature, a plan
 * ceiling. These arrive on the same 4xx path as a genuinely broken
 * connection and read identically unless you look at the message.
 *
 * The distinction decides who gets asked to fix it. A user can reconnect
 * their Google account; they cannot grant our API key a scope it was minted
 * without. Anchored on the capability wording Composio uses so an ordinary
 * provider rejection ("invalid credentials", an expired grant) still counts
 * as connection-shaped and still marks the connector.
 */
export function isComposioInfrastructureFault(message: string): boolean {
  return (
    /proxy execute is not enabled/i.test(message) ||
    /create a new scoped api ?key/i.test(message) ||
    /not enabled for (?:this|your) (?:api ?key|organization|org|project)/i.test(
      message,
    ) ||
    /\bapi ?key\b[^.]{0,60}\b(?:lacks|missing|does not have)\b/i.test(message)
  );
}
const COMPOSIO_BASE = "https://backend.composio.dev/api/v3";
// The request proxy lives on the v3.1 surface. Exported for the connector
// health probe, which runs its liveness checks through the same proxy.
export const COMPOSIO_PROXY_URL =
  "https://backend.composio.dev/api/v3.1/tools/execute/proxy";
const CONN_ID_TTL_MS = 5 * 60_000;

/** Native provider key → candidate Composio toolkit slugs. */
const PROVIDER_TOOLKITS: Record<string, string[]> = {
  google: ["gmail", "googlecalendar"],
  gmail: ["gmail"],
  google_calendar: ["googlecalendar"],
  notion: ["notion"],
  slack: ["slack"],
  slack_channel: ["slack"],
  outlook: ["outlook"],
  github: ["github"],
  linear: ["linear"],
  airtable: ["airtable"],
  hubspot: ["hubspot"],
};

/**
 * The Composio toolkit slugs that could satisfy a native provider key, or an
 * empty array when the provider has no Composio route at all.
 *
 * Exported so callers that need to answer "can this provider authenticate?"
 * without making a network call (the watcher pre-poll gate) can consult the
 * cached ACTIVE-toolkit snapshot for the right slugs.
 */
export function composioToolkitsForProvider(provider: string): string[] {
  return PROVIDER_TOOLKITS[provider.trim().toLowerCase()] ?? [];
}

interface ComposioCreds {
  apiKey: string;
  userId: string;
}

let credsCache: ComposioCreds | null | undefined;

const readCreds = (): ComposioCreds | null => {
  if (credsCache !== undefined) return credsCache;
  const ws = process.env.VELLUM_WORKSPACE_DIR;
  try {
    const raw = JSON.parse(
      readFileSync(join(ws ?? "", "connectors.json"), "utf8"),
    ) as { composioApiKey?: string; userId?: string };
    credsCache =
      raw.composioApiKey && raw.userId
        ? { apiKey: raw.composioApiKey, userId: raw.userId }
        : null;
  } catch {
    credsCache = null;
  }
  return credsCache;
};

const composioGet = async (
  creds: ComposioCreds,
  path: string,
): Promise<unknown> => {
  const res = await fetch(`${COMPOSIO_BASE}${path}`, {
    headers: { "x-api-key": creds.apiKey },
  });
  if (!res.ok) throw new Error(`Composio GET ${path} -> ${res.status}`);
  return res.json();
};

const connIdCache = new Map<string, { id: string; at: number }>();

/** Active connected-account ID for a toolkit, or null. */
const connectionIdForToolkit = async (
  creds: ComposioCreds,
  toolkit: string,
): Promise<string | null> => {
  const cached = connIdCache.get(toolkit);
  if (cached && Date.now() - cached.at < CONN_ID_TTL_MS) return cached.id;
  try {
    const data = (await composioGet(
      creds,
      `/connected_accounts?user_ids=${encodeURIComponent(creds.userId)}` +
        `&toolkit_slugs=${toolkit}&statuses=ACTIVE&limit=1`,
    )) as { items?: Array<{ id: string } & ComposioAccountRow> };
    // Verify, don't assume: this id becomes `connected_account_id` on a proxy
    // call that reads real user data, so a row we cannot prove is ours must
    // never reach it. See `selectOwnedAccounts`.
    const owned = selectOwnedAccounts(
      data.items ?? [],
      creds.userId,
      `connectionIdForToolkit:${toolkit}`,
    );
    const id = owned[0]?.id;
    if (!id) return null;
    connIdCache.set(toolkit, { id, at: Date.now() });
    return id;
  } catch (err) {
    log.warn({ err, toolkit }, "Composio connection lookup failed");
    return null;
  }
};

interface ComposioProxyResponse {
  data?: unknown;
  status?: number;
  headers?: Record<string, string>;
}

/**
 * Make an authenticated upstream request through Composio's request proxy.
 * Composio attaches the live provider token to the call, so this succeeds
 * even when the raw stored token has rotated.
 */
const proxyRequest = async (
  creds: ComposioCreds,
  connectedAccountId: string,
  args: {
    endpoint: string;
    method: string;
    body?: unknown;
    headers?: Array<{ name: string; value: string; type: "header" | "query" }>;
    signal?: AbortSignal;
  },
): Promise<ComposioProxyResponse> => {
  const res = await fetch(COMPOSIO_PROXY_URL, {
    method: "POST",
    headers: {
      "x-api-key": creds.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      connected_account_id: connectedAccountId,
      endpoint: args.endpoint,
      method: args.method.toUpperCase(),
      ...(args.body !== undefined ? { body: args.body } : {}),
      ...(args.headers && args.headers.length
        ? { parameters: args.headers }
        : {}),
    }),
    signal: args.signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Composio proxy ${args.method} ${args.endpoint} -> ${res.status} ${detail.slice(0, 200)}`,
    );
  }
  return (await res.json()) as ComposioProxyResponse;
};

/** Which active toolkits Composio has for this user (cached briefly). */
const activeToolkits = async (creds: ComposioCreds): Promise<Set<string>> => {
  try {
    const data = (await composioGet(
      creds,
      `/connected_accounts?user_ids=${encodeURIComponent(creds.userId)}&statuses=ACTIVE&limit=100`,
    )) as {
      items?: Array<{ toolkit?: { slug?: string } } & ComposioAccountRow>;
    };
    const slugs = selectOwnedAccounts(
      data.items ?? [],
      creds.userId,
      "activeToolkits",
    )
      .map((c) => c.toolkit?.slug ?? "")
      .filter(Boolean);
    // Feed the cheap cached ACTIVE-status snapshot the capability layer reads
    // (this was a full statuses=ACTIVE fetch, so it is the authoritative set).
    recordActiveComposioToolkits(slugs);
    return new Set(slugs);
  } catch {
    return new Set();
  }
};

/**
 * Build the Composio proxy `endpoint` + `parameters` for an OAuth request.
 *
 * Encoding rules (both learned the hard way against the live proxy):
 *  - Query goes in the endpoint URL, encoded with `encodeURIComponent`
 *    (spaces → "%20"). `URLSearchParams` uses "+", which the proxy re-encodes
 *    to a literal "%2B" and corrupts values like Gmail's `q=is:unread in:inbox`.
 *  - Header/query params use `{name, value, type}` — the field is `type`, NOT
 *    `in`; sending `in` makes the proxy 400 on any request carrying a header.
 *  - The Authorization header is dropped: Composio injects the live token, and
 *    a caller-supplied Authorization would override it.
 *
 * Exported (and pure) so the encoding contract can be unit-tested.
 */
export function buildProxyArgs(
  req: OAuthConnectionRequest,
  fallbackBaseUrl?: string,
): {
  endpoint: string;
  params: Array<{ name: string; value: string; type: "header" | "query" }>;
} {
  // A native connection carries its host from the provider seed, so callers
  // built against it pass only a path — the Gmail client asks for "/profile"
  // and nothing else. On the proxy path there is no such default, so an absent
  // baseUrl produced the bare endpoint "/profile", which Composio resolved
  // against Google's web root and returned an HTML 404 for. The fallback
  // restores the host those callers assume.
  const base = (req.baseUrl ?? fallbackBaseUrl ?? "").replace(/\/$/, "");
  const queryPairs: string[] = [];
  for (const [k, v] of Object.entries(req.query ?? {})) {
    for (const item of Array.isArray(v) ? v : [v]) {
      queryPairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(item)}`);
    }
  }
  const endpoint =
    base + req.path + (queryPairs.length ? `?${queryPairs.join("&")}` : "");
  const params = Object.entries(req.headers ?? {})
    .filter(([k]) => k.toLowerCase() !== "authorization")
    .map(([name, value]) => ({ name, value, type: "header" as const }));
  return { endpoint, params };
}

/**
 * Upstream API host per toolkit, used only when the caller did not supply one.
 *
 * These mirror the `baseUrl` on the matching native provider seed, so a client
 * written against a native connection behaves identically through the proxy.
 * Keep them in sync with `oauth/seed-providers.ts`.
 */
const TOOLKIT_BASE_URLS: Record<string, string> = {
  gmail: "https://gmail.googleapis.com/gmail/v1/users/me",
  googlecalendar: "https://www.googleapis.com/calendar/v3",
};

/** Pick the toolkit for a Google request by host (Gmail vs Calendar vs People). */
const pickGoogleToolkit = (req: OAuthConnectionRequest): string => {
  const where = `${req.baseUrl ?? ""} ${req.path}`.toLowerCase();
  if (where.includes("calendar")) return "googlecalendar";
  return "gmail"; // gmail, people/contacts ride the gmail connection
};

class ComposioOAuthConnection implements OAuthConnection {
  readonly id: string;
  readonly provider: string;
  readonly accountInfo: string | null = "composio";
  private readonly creds: ComposioCreds;
  private readonly toolkits: string[];

  constructor(provider: string, creds: ComposioCreds, toolkits: string[]) {
    this.id = `composio:${provider}`;
    this.provider = provider;
    this.creds = creds;
    this.toolkits = toolkits;
  }

  private toolkitFor(req?: OAuthConnectionRequest): string {
    if (this.toolkits.length === 1) return this.toolkits[0];
    if (this.provider === "google" && req) return pickGoogleToolkit(req);
    return this.toolkits[0];
  }

  async request(req: OAuthConnectionRequest): Promise<OAuthConnectionResponse> {
    const toolkit = this.toolkitFor(req);
    const connId = await connectionIdForToolkit(this.creds, toolkit);
    if (!connId) {
      throw new Error(
        `Composio has no active "${toolkit}" connection for this user. Connect it in Cue → Connectors.`,
      );
    }
    const { endpoint, params } = buildProxyArgs(
      req,
      TOOLKIT_BASE_URLS[toolkit],
    );
    let resp: ComposioProxyResponse;
    try {
      resp = await proxyRequest(this.creds, connId, {
        endpoint,
        method: req.method,
        body: req.body,
        headers: params,
        signal: req.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Passive health signal: a proxy-level failure is USUALLY
      // connection-shaped (Composio couldn't complete an authenticated call
      // for this toolkit). It is not when Composio rejected US — a key
      // without proxy-execute, a disabled feature, a plan limit. Recording
      // that against the connection puts "Needs attention" on a connector
      // that is perfectly healthy and sends the user to Reconnect, which
      // cannot possibly fix our own credential. Leave the connection's
      // record alone and make the noise where an operator will see it.
      if (isComposioInfrastructureFault(message)) {
        log.error(
          { toolkit, message },
          "Composio rejected Cue's own API key — connector health left " +
            "untouched; this needs an operator, not a user reconnect",
        );
        throw err;
      }
      recordConnectorFailure(toolkit, message);
      throw err;
    }
    const status = resp.status ?? 200;
    // Passive health signal: 401/403 from the provider means the stored
    // connection is broken; any other provider verdict proves the connection
    // authenticated (even a 404 had to get past auth to be a 404).
    if (status === 401 || status === 403) {
      recordConnectorFailure(
        toolkit,
        `Provider rejected the connection (HTTP ${status}) — reconnect to fix`,
      );
    } else {
      recordConnectorSuccess(toolkit);
    }
    return {
      status,
      headers: resp.headers ?? {},
      body: resp.data ?? null,
    };
  }

  /**
   * The raw-token escape hatch is not supported on the Composio path: Composio
   * owns token refresh and only injects a live token on its proxy/execute
   * surface (the token it exposes is frequently stale). Callers that need a
   * bare token must use a native BYO connection instead. In practice every
   * connector skill goes through `request()`, so this is not hit.
   */
  async withToken<T>(_fn: (token: string) => Promise<T>): Promise<T> {
    throw new Error(
      `Raw access tokens are not available for the Composio-backed "${this.provider}" connection. ` +
        `Use request() (Composio injects the live token on its proxy), or connect a BYO OAuth app for raw-token access.`,
    );
  }
}

/**
 * Build a Composio-backed connection for a provider when Composio has an
 * active connection for it; otherwise null (caller falls back to native).
 */
export async function composioConnectionFor(
  provider: string,
): Promise<OAuthConnection | null> {
  const creds = readCreds();
  if (!creds) return null;
  const candidates = PROVIDER_TOOLKITS[provider];
  if (!candidates) return null;
  const active = await activeToolkits(creds);
  const usable = candidates.filter((t) => active.has(t));
  if (usable.length === 0) return null;
  log.info({ provider, toolkits: usable }, "Using Composio for OAuth provider");
  return new ComposioOAuthConnection(provider, creds, usable);
}

/**
 * Auth headers for a Composio-hosted MCP endpoint, or undefined for any other
 * host.
 *
 * Composio's MCP endpoint rejects an unauthenticated POST with 401 "API key or
 * valid JWT Bearer token is required in headers", and the auto-provisioned
 * server entries carry no headers at all — so every Composio MCP server on an
 * instance fails to connect, while the proxy path beside it works because it
 * sends this same key. The visible symptom is a connector that reads
 * "connected" in the list and reports an auth error the moment a chat tries to
 * use it, which is expensive: an agent whose tools answer 401 will keep
 * re-deriving how it is connected. One tester spent 2.5M tokens doing that.
 *
 * Read at connect time rather than written into the server entry on purpose.
 * The key already lives in `connectors.json`; persisting a second copy into
 * config would go stale on rotation and hand back the identical silent 401,
 * with the added charm of being wrong in a file nobody thinks to look at.
 */
export function composioMcpAuthHeaders(
  url: string,
): Record<string, string> | undefined {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
  if (host !== "backend.composio.dev" && !host.endsWith(".composio.dev")) {
    return undefined;
  }
  const creds = readCreds();
  return creds ? { "x-api-key": creds.apiKey } : undefined;
}
