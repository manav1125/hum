/**
 * Connector apps — the Composio-connectable app catalog for the onboarding
 * "connect your tools" grid and the command-center build-out tiles.
 *
 * GET  /v1/connector-apps          — searchable list of Composio-connectable
 *                                    apps with this install's connected state.
 * POST /v1/connector-apps/connect  — start a Composio OAuth connection for a
 *                                    toolkit; returns the redirect URL.
 *
 * The toolkit list is fetched server-side from Composio's API and cached in
 * the workspace (`connector-apps-cache.json`, 24h TTL). When Composio is
 * unreachable — or this install has no Composio credentials at all — the
 * route falls back to a static curated list of top apps so the onboarding
 * grid always renders. Connected state rides the same
 * `connectors.json` credentials (`composioApiKey` + per-install `userId`)
 * that `assistant/src/oauth/composio-oauth.ts` uses for the request proxy;
 * this module is the browse/connect control surface over that same identity.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { recordActiveComposioToolkits } from "../../capabilities/composio-connection-status.js";
import { selectOwnedAccounts } from "../../oauth/composio-account-ownership.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  type ConnectedAccountInfo,
  type ConnectorHealth,
  connectorHealthFor,
  kickHealthRefresh,
} from "./connector-health.js";
import { BadRequestError, InternalError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("connector-apps");

const COMPOSIO_BASE = "https://backend.composio.dev/api/v3";
/** Toolkit-catalog cache TTL — the list of connectable apps moves slowly. */
const CATALOG_TTL_MS = 24 * 60 * 60_000;
/** Connected-state memo TTL — short, so a finished OAuth shows up quickly. */
const CONNECTED_TTL_MS = 30_000;
const CACHE_FILENAME = "connector-apps-cache.json";

// ---------------------------------------------------------------------------
// Curated fallback — ~30 top apps, used when Composio's API is unavailable
// (or unconfigured). Slugs are Composio toolkit slugs.
// ---------------------------------------------------------------------------

export interface ConnectorApp {
  slug: string;
  name: string;
  category: string;
  /**
   * Brand logo URL for the app. From Composio's toolkit metadata
   * (`meta.logo`, served off `logos.composio.dev`) on the live path; the
   * curated fallback uses the same public CDN by slug. Optional — clients
   * must degrade to a monogram chip when missing or unloadable.
   */
  logoUrl?: string;
  /** Whether THIS install has an ACTIVE Composio connection for the app. */
  connected: boolean;
  /**
   * Verified health for connected apps — evidence of real authenticated
   * calls succeeding or failing (see `connector-health.ts`). Absent on
   * disconnected apps.
   */
  health?: ConnectorHealth;
}

/**
 * Composio's public logo CDN, keyed by toolkit slug. Used for the curated
 * fallback list (whose slugs are all Composio toolkit slugs), so fallback
 * logos match what the live catalog would return. The UI's `onError`
 * monogram fallback covers the case where the CDN itself is unreachable.
 */
const composioLogo = (slug: string): string =>
  `https://logos.composio.dev/api/${slug}`;

const CURATED_APPS: ReadonlyArray<Omit<ConnectorApp, "connected">> = [
  { slug: "gmail", name: "Gmail", category: "Email" },
  { slug: "googlecalendar", name: "Google Calendar", category: "Calendar" },
  { slug: "googledrive", name: "Google Drive", category: "Files" },
  { slug: "googledocs", name: "Google Docs", category: "Documents" },
  { slug: "googlesheets", name: "Google Sheets", category: "Documents" },
  { slug: "notion", name: "Notion", category: "Documents" },
  { slug: "slack", name: "Slack", category: "Messaging" },
  { slug: "discord", name: "Discord", category: "Messaging" },
  { slug: "telegram", name: "Telegram", category: "Messaging" },
  { slug: "outlook", name: "Outlook", category: "Email" },
  { slug: "onedrive", name: "OneDrive", category: "Files" },
  { slug: "dropbox", name: "Dropbox", category: "Files" },
  { slug: "github", name: "GitHub", category: "Developer" },
  { slug: "linear", name: "Linear", category: "Project management" },
  { slug: "jira", name: "Jira", category: "Project management" },
  { slug: "asana", name: "Asana", category: "Project management" },
  { slug: "trello", name: "Trello", category: "Project management" },
  { slug: "clickup", name: "ClickUp", category: "Project management" },
  { slug: "airtable", name: "Airtable", category: "Databases" },
  { slug: "hubspot", name: "HubSpot", category: "CRM" },
  { slug: "salesforce", name: "Salesforce", category: "CRM" },
  { slug: "intercom", name: "Intercom", category: "Support" },
  { slug: "zendesk", name: "Zendesk", category: "Support" },
  { slug: "zoom", name: "Zoom", category: "Meetings" },
  { slug: "calendly", name: "Calendly", category: "Calendar" },
  { slug: "stripe", name: "Stripe", category: "Payments" },
  { slug: "shopify", name: "Shopify", category: "Commerce" },
  { slug: "figma", name: "Figma", category: "Design" },
  { slug: "linkedin", name: "LinkedIn", category: "Social" },
  { slug: "reddit", name: "Reddit", category: "Social" },
] as const;

// ---------------------------------------------------------------------------
// Composio credentials — same `connectors.json` file the OAuth proxy path
// reads (`assistant/src/oauth/composio-oauth.ts`). Re-read per call so a
// connector-setup that lands mid-session takes effect without a restart.
// ---------------------------------------------------------------------------

interface ComposioCreds {
  apiKey: string;
  userId: string;
  catalog: Array<{ slug: string; auth_config_id?: string }>;
}

function readCreds(): ComposioCreds | null {
  const ws = process.env.VELLUM_WORKSPACE_DIR;
  if (!ws) return null;
  try {
    const raw = JSON.parse(
      readFileSync(join(ws, "connectors.json"), "utf8"),
    ) as {
      composioApiKey?: string;
      userId?: string;
      catalog?: Array<{ slug?: string; auth_config_id?: string }>;
    };
    if (!raw.composioApiKey || !raw.userId) return null;
    return {
      apiKey: raw.composioApiKey,
      userId: raw.userId,
      catalog: (raw.catalog ?? []).flatMap((c) =>
        c.slug ? [{ slug: c.slug, auth_config_id: c.auth_config_id }] : [],
      ),
    };
  } catch {
    return null;
  }
}

async function composio(
  creds: ComposioCreds,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${COMPOSIO_BASE}${path}`, {
    method,
    headers: {
      "x-api-key": creds.apiKey,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Composio ${method} ${path} -> ${res.status} ${detail.slice(0, 160)}`,
    );
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Toolkit catalog — Composio fetch with workspace-file + in-memory caching,
// curated fallback when unavailable.
// ---------------------------------------------------------------------------

type CatalogEntry = Omit<ConnectorApp, "connected">;

/**
 * Bump when the catalog entry shape gains fields (e.g. `logoUrl`) so a
 * pre-existing cache written by an older build is refetched instead of
 * serving shape-incomplete entries for up to the 24h TTL.
 */
const CACHE_VERSION = 2;

interface CatalogCacheFile {
  version?: number;
  fetchedAt: number;
  apps: CatalogEntry[];
}

let catalogMemo: CatalogCacheFile | null = null;

function cachePath(): string | null {
  const ws = process.env.VELLUM_WORKSPACE_DIR;
  return ws ? join(ws, CACHE_FILENAME) : null;
}

function readCatalogCache(): CatalogCacheFile | null {
  if (catalogMemo) return catalogMemo;
  const path = cachePath();
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as CatalogCacheFile;
    if (
      raw.version === CACHE_VERSION &&
      typeof raw.fetchedAt === "number" &&
      Array.isArray(raw.apps) &&
      raw.apps.length > 0
    ) {
      catalogMemo = raw;
      return raw;
    }
  } catch {
    // No cache yet — fall through.
  }
  return null;
}

function writeCatalogCache(apps: CatalogEntry[]): void {
  const next: CatalogCacheFile = {
    version: CACHE_VERSION,
    fetchedAt: Date.now(),
    apps,
  };
  catalogMemo = next;
  const path = cachePath();
  if (!path) return;
  try {
    writeFileSync(path, JSON.stringify(next));
  } catch (err) {
    log.warn({ err }, "connector-apps cache write failed");
  }
}

/** Parse a Composio /toolkits item defensively — skip anything malformed. */
function parseToolkitItem(item: unknown): CatalogEntry | null {
  if (typeof item !== "object" || item === null) return null;
  const t = item as {
    slug?: unknown;
    name?: unknown;
    meta?: { logo?: unknown; categories?: Array<{ name?: unknown }> };
  };
  if (typeof t.slug !== "string" || t.slug.length === 0) return null;
  const name =
    typeof t.name === "string" && t.name.length > 0 ? t.name : t.slug;
  const category =
    typeof t.meta?.categories?.[0]?.name === "string"
      ? (t.meta.categories[0].name as string)
      : "App";
  const logoUrl =
    typeof t.meta?.logo === "string" && t.meta.logo.length > 0
      ? t.meta.logo
      : composioLogo(t.slug);
  return { slug: t.slug, name, category, logoUrl };
}

/**
 * The toolkit catalog: fresh cache → Composio API (re-cache) → stale cache →
 * curated static list. Never throws.
 */
async function loadCatalog(
  creds: ComposioCreds | null,
): Promise<{ apps: CatalogEntry[]; source: "composio" | "curated" }> {
  const cached = readCatalogCache();
  if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
    return { apps: cached.apps, source: "composio" };
  }
  if (creds) {
    try {
      const data = (await composio(creds, "GET", "/toolkits?limit=500")) as {
        items?: unknown[];
      };
      const apps = (data.items ?? [])
        .map(parseToolkitItem)
        .filter((a): a is CatalogEntry => a !== null);
      if (apps.length > 0) {
        writeCatalogCache(apps);
        return { apps, source: "composio" };
      }
    } catch (err) {
      log.warn({ err }, "Composio toolkit fetch failed — using fallback");
    }
  }
  // Stale cache beats the static list; static list beats nothing.
  if (cached) return { apps: cached.apps, source: "composio" };
  return {
    apps: CURATED_APPS.map((a) => ({ ...a, logoUrl: composioLogo(a.slug) })),
    source: "curated",
  };
}

// ---------------------------------------------------------------------------
// Connected state — one connected_accounts call, briefly memoized. Beyond
// the slug set, keep each ACTIVE account's id (the health probe calls the
// Composio request proxy per connected-account id) and its `is_disabled`
// flag (the only trustworthy attention signal in the metadata itself).
// ---------------------------------------------------------------------------

let connectedMemo: {
  at: number;
  accounts: Map<string, ConnectedAccountInfo>;
} | null = null;

async function connectedAccounts(
  creds: ComposioCreds | null,
): Promise<Map<string, ConnectedAccountInfo>> {
  if (!creds) return new Map();
  if (connectedMemo && Date.now() - connectedMemo.at < CONNECTED_TTL_MS) {
    return connectedMemo.accounts;
  }
  try {
    const data = (await composio(
      creds,
      "GET",
      `/connected_accounts?user_ids=${encodeURIComponent(creds.userId)}&statuses=ACTIVE&limit=100`,
    )) as {
      items?: Array<{
        id?: string;
        toolkit?: { slug?: string };
        is_disabled?: boolean;
        user_id?: unknown;
      }>;
    };
    // Verify ownership rather than trusting the `user_ids=` filter: every id
    // kept here is later used as `connected_account_id` on a Composio proxy
    // call (the health probe), so a foreign row must never survive.
    const accounts = new Map<string, ConnectedAccountInfo>();
    for (const item of selectOwnedAccounts(
      data.items ?? [],
      creds.userId,
      "connectorApps.connectedAccounts",
    )) {
      const slug = item.toolkit?.slug;
      if (!slug || typeof item.id !== "string" || accounts.has(slug)) continue;
      accounts.set(slug, {
        id: item.id,
        isDisabled: item.is_disabled === true,
      });
    }
    connectedMemo = { at: Date.now(), accounts };
    // Feed the cheap cached ACTIVE-status snapshot the capability layer reads
    // (this was a full statuses=ACTIVE fetch, so it is the authoritative set).
    recordActiveComposioToolkits(accounts.keys());
    return accounts;
  } catch (err) {
    log.warn({ err }, "connected_accounts fetch failed");
    return connectedMemo?.accounts ?? new Map();
  }
}

/** Test hook: drop the module memos so a test starts from a clean slate. */
export function resetConnectorAppsMemosForTest(): void {
  connectedMemo = null;
  catalogMemo = null;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleListConnectorApps({ queryParams = {} }: RouteHandlerArgs) {
  const creds = readCreds();
  const [{ apps, source }, accounts] = await Promise.all([
    loadCatalog(creds),
    connectedAccounts(creds),
  ]);

  // Stale-while-revalidate health: never block the list on probes — kick a
  // single-flight, TTL-bounded background sweep and serve what's cached.
  // `?refreshHealth=1` shortens the TTL to a 30s cooldown for an on-demand
  // re-check (clients poll the list to pick up landed results).
  if (creds && accounts.size > 0) {
    const force =
      queryParams.refreshHealth === "1" || queryParams.refreshHealth === "true";
    kickHealthRefresh(creds.apiKey, accounts, force);
  }

  const query = (queryParams.query ?? "").trim().toLowerCase();
  const filtered = query
    ? apps.filter(
        (a) =>
          a.name.toLowerCase().includes(query) ||
          a.slug.toLowerCase().includes(query) ||
          a.category.toLowerCase().includes(query),
      )
    : apps;

  return {
    configured: creds !== null,
    source,
    apps: filtered.map((a) => {
      const account = accounts.get(a.slug);
      return {
        ...a,
        connected: account !== undefined,
        ...(account !== undefined
          ? { health: connectorHealthFor(a.slug, account) }
          : {}),
      };
    }),
  };
}

/** Resolve an auth config for a toolkit: install catalog → existing → create. */
async function resolveAuthConfigId(
  creds: ComposioCreds,
  slug: string,
): Promise<string> {
  const fromCatalog = creds.catalog.find(
    (c) => c.slug === slug && c.auth_config_id,
  )?.auth_config_id;
  if (fromCatalog) return fromCatalog;

  try {
    const existing = (await composio(
      creds,
      "GET",
      `/auth_configs?toolkit_slug=${encodeURIComponent(slug)}&limit=10`,
    )) as { items?: Array<{ id?: string }> };
    const id = existing.items?.find((i) => i.id)?.id;
    if (id) return id;
  } catch (err) {
    log.warn({ err, slug }, "auth_configs lookup failed — will try create");
  }

  const created = (await composio(creds, "POST", "/auth_configs", {
    toolkit: { slug },
    auth_config: { type: "use_composio_managed_auth" },
  })) as { auth_config?: { id?: string }; id?: string };
  const id = created.auth_config?.id ?? created.id;
  if (!id) throw new Error(`Composio auth_config create returned no id`);
  return id;
}

async function handleConnectConnectorApp({ body = {} }: RouteHandlerArgs) {
  const slug = (body as { slug?: unknown }).slug;
  if (typeof slug !== "string" || slug.trim().length === 0) {
    throw new BadRequestError("slug is required");
  }
  const creds = readCreds();
  if (!creds) {
    throw new BadRequestError(
      "Connectors are not configured on this instance — Composio credentials are missing. " +
        "You can connect channels from the Channels page, or add tools any time later.",
    );
  }
  try {
    const authConfigId = await resolveAuthConfigId(creds, slug.trim());
    const res = (await composio(creds, "POST", "/connected_accounts", {
      auth_config: { id: authConfigId },
      connection: { user_id: creds.userId },
    })) as { redirect_url?: string };
    if (!res.redirect_url) {
      throw new Error("Composio returned no redirect_url");
    }
    // A new connection is starting — drop the memo so the next list reflects
    // it as soon as Composio marks it ACTIVE.
    connectedMemo = null;
    return { redirectUrl: res.redirect_url };
  } catch (err) {
    log.warn({ err, slug }, "connector connect failed");
    throw new InternalError(
      `Couldn't start the ${slug} connection — try again, or add it later from Connectors.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Route definitions (shared HTTP + IPC)
// ---------------------------------------------------------------------------

const connectorHealthSchema = z
  .object({
    status: z
      .enum(["ok", "attention", "unknown"])
      .describe(
        "Verified health verdict: 'ok' = a real authenticated call " +
          "succeeded recently; 'attention' = the provider rejected the " +
          "connection (or it's disabled) — reconnect; 'unknown' = linked " +
          "but no recent evidence either way.",
      ),
    lastSuccessAt: z
      .string()
      .optional()
      .describe("ISO time of the last successful call."),
    lastErrorAt: z
      .string()
      .optional()
      .describe("ISO time of the last connection-shaped failure."),
    lastError: z.string().optional().describe("Human-readable last failure."),
    checkedAt: z
      .string()
      .optional()
      .describe("ISO time the active liveness probe last ran for this app."),
  })
  .describe(
    "Health signal for a connected app, combining passive call outcomes " +
      "with a cached liveness probe. Absent on disconnected apps.",
  );

const connectorAppSchema = z.object({
  slug: z.string(),
  name: z.string(),
  category: z.string(),
  logoUrl: z
    .string()
    .optional()
    .describe(
      "Brand logo URL (Composio toolkit metadata or the public Composio " +
        "logo CDN for curated fallbacks). Clients render a monogram chip " +
        "when missing or when the image fails to load.",
    ),
  connected: z.boolean(),
  health: connectorHealthSchema.optional(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listConnectorApps",
    endpoint: "connector-apps",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List Composio-connectable apps",
    description:
      "Return the catalog of Composio-connectable apps with this install's " +
      "connected state. Server-side cached (24h); falls back to a static " +
      "curated list when Composio is unavailable or unconfigured.",
    tags: ["connectors"],
    queryParams: [
      {
        name: "query",
        schema: { type: "string" },
        description: "Case-insensitive filter over name, slug, and category.",
      },
      {
        name: "refreshHealth",
        schema: { type: "string" },
        description:
          "Pass '1' to request an on-demand background health re-probe " +
          "(cooldown-limited). The response still returns immediately with " +
          "cached health — poll the list to pick up fresh results.",
      },
    ],
    responseBody: z.object({
      configured: z.boolean(),
      source: z.enum(["composio", "curated"]),
      apps: z.array(connectorAppSchema),
    }),
    handler: handleListConnectorApps,
  },
  {
    operationId: "connectConnectorApp",
    endpoint: "connector-apps/connect",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Start a Composio OAuth connection",
    description:
      "Initiate a Composio OAuth connection for a toolkit slug; returns the " +
      "redirect URL the user must open to finish authorizing.",
    tags: ["connectors"],
    requestBody: z.object({
      slug: z.string().describe("Composio toolkit slug (e.g. 'gmail')"),
    }),
    responseBody: z.object({ redirectUrl: z.string() }),
    handler: handleConnectConnectorApp,
  },
];
