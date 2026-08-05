/**
 * Composio MCP server provisioning — derive this instance's connector tool
 * servers from its OWN `connectors.json`, and from nothing else.
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 * A Composio connection is only half of "the agent can use Gmail". The other
 * half is an MCP server entry in `mcp.servers`, because that is what actually
 * puts `GMAIL_*` tools on the wire. Nothing ever created those entries. The
 * owner's instance has eleven of them; every provisioned instance has ZERO,
 * because HQ writes `connectors.json` and stops. Verified on production
 * 2026-08-04: `cue-manav-prod` → 11 servers; a freshly provisioned instance →
 * 0, and the shipped image's `default-config.json` → 0 (which is correct — a
 * baked-in server would carry a baked-in identity).
 *
 * So a tester could finish a Gmail OAuth, see "connected" on the Connectors
 * page, and have an agent with no Gmail tools at all. That is the same defect
 * shape as `browser_*` tools that were named in the prompt but never
 * registered: a surface that reports success over an empty result.
 *
 * ── Why the daemon and not HQ ──────────────────────────────────────────────
 * HQ could write `mcp.servers` at provision time, but:
 *  · It only ever runs ONCE, at provision. Every instance that already exists
 *    — including every half-provisioned one — would stay broken forever.
 *  · The MCP server ids it would need are Composio resources that live inside
 *    the customer's OWN project, so HQ would have to mint them with a key it
 *    holds on the customer's behalf and then hand the ids across a boundary.
 *    Every hop is a chance to hand across the WRONG customer's ids.
 *  · The daemon already re-reads `connectors.json` per call and hot-reloads
 *    MCP on config change, and it already has a single choke point for "a
 *    connector became connected" (`recordActiveComposioToolkits`).
 *
 * Deriving in the daemon is also the strongest available isolation argument:
 * this module reads exactly one identity source — the instance's own
 * `connectors.json` — and takes NO identity parameter, so there is no argument
 * through which another tenant's `user_id` could be passed in.
 *
 * ── The shortcut this is built to make impossible ──────────────────────────
 * Copying a working `config.json` onto a new instance would point that
 * tester's agent at the owner's Gmail: a Composio MCP URL
 * (`…/v3/mcp/<server_id>?user_id=<user>`) and a tool-router URL
 * (`…/tool_router/<session_id>/mcp`) are bearer capabilities — holding the
 * string is holding the access. Two guards, both structural rather than
 * advisory:
 *
 *  1. IDENTITY REWRITE. Any URL this module writes has every identity query
 *     parameter stripped and re-set from the instance's own `userId`
 *     ({@link bindServerUrlToOwnUser}). A catalog entry carrying a foreign
 *     `?user_id=` cannot survive into config.
 *  2. OWNERSHIP PROOF. A `server_id` or tool-router `session_id` inherited
 *     from a file is used only after Composio confirms it under THIS
 *     instance's own project key — and, for the router, that the session's
 *     `config.user_id` is ours. Since d322c28f17 each customer holds a
 *     per-customer Composio project key, so a foreign id is not filtered out,
 *     it is invisible: the lookup 404s and the id is discarded.
 *
 * ── Fail open, never fail silent ───────────────────────────────────────────
 * Provisioning never throws into its caller and never blocks a turn. What it
 * does instead is leave a durable, honest report
 * (`composio-mcp-provision.json`) that records the real server count and every
 * failure — read by `GET /v1/connector-apps` so the Connectors surface can say
 * "connected, but no tools reached this instance yet" instead of implying
 * readiness it cannot back. Zero is reported as zero.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadRawConfig, saveRawConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("composio-mcp-provision");

const COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3.1";
/** Fallback base for a per-toolkit MCP URL when the API omits `mcp_url`. */
const MCP_URL_BASE = "https://backend.composio.dev/v3/mcp";
const REPORT_FILENAME = "composio-mcp-provision.json";
const REQUEST_TIMEOUT_MS = 10_000;

/** Config key of the tool-router server — Composio's meta/discovery toolkit. */
export const TOOL_ROUTER_SERVER_KEY = "composio";

/** Config key for a per-toolkit Composio server (`composio_gmail`, …). */
export function toolkitServerKey(slug: string): string {
  return `composio_${slug}`;
}

/**
 * Query parameters that carry an identity into a Composio MCP URL. Every one
 * of these is stripped before we bind our own — a list rather than a single
 * `user_id` check because `connected_account_id` pins an account just as
 * hard, and Composio has spelled the same idea several ways over time.
 */
const IDENTITY_PARAMS: ReadonlySet<string> = new Set([
  "user_id",
  "userid",
  "connected_account_id",
  "connectedaccountid",
  "entity_id",
  "entityid",
  "user",
]);

/**
 * Re-bind an MCP server URL to THIS instance's user, discarding whatever
 * identity the URL arrived carrying.
 *
 * This is the guard that makes a copied `connectors.json` catalog inert: an
 * `mcp_url` of `…?user_id=someone-else` comes back out as
 * `…?user_id=<ours>`. It is deliberately total — it does not inspect whether
 * the inbound identity looks foreign, because "looks foreign" is a judgement
 * and this must not be one.
 *
 * Throws on a URL that will not parse; callers treat that as a resolution
 * failure and record it, rather than writing a half-formed server.
 */
export function bindServerUrlToOwnUser(
  mcpUrl: string,
  ownUserId: string,
): string {
  const own = ownUserId.trim();
  if (!own)
    throw new Error("refusing to build an MCP URL with an empty userId");
  const url = new URL(mcpUrl);
  for (const key of [...url.searchParams.keys()]) {
    if (IDENTITY_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.set("user_id", own);
  return url.toString();
}

// ---------------------------------------------------------------------------
// This instance's own identity — the single source, read fresh every time
// ---------------------------------------------------------------------------

export interface OwnComposioIdentity {
  /** Project-scoped Composio key seeded by HQ. Never logged, never returned. */
  apiKey: string;
  /** This install's Composio `user_id`. */
  userId: string;
  /**
   * Optional pre-seeded server catalog. Treated as a HINT ONLY: every id in
   * it is proved against our own project key before use.
   */
  catalog: Array<{ slug: string; serverId?: string; mcpUrl?: string }>;
  /** Optional pre-seeded tool-router session. Also a hint, also proved. */
  toolRouterSessionId?: string;
}

/**
 * Read the instance's own Composio identity from its own workspace.
 *
 * There is deliberately no parameter and no fallback: no template, no
 * constant, no environment default, no other instance. If this returns null,
 * nothing is provisioned and the report says why.
 */
export function readOwnComposioIdentity(): OwnComposioIdentity | null {
  const ws = process.env.VELLUM_WORKSPACE_DIR;
  if (!ws) return null;
  let raw: {
    composioApiKey?: unknown;
    userId?: unknown;
    catalog?: unknown;
    toolRouter?: unknown;
  };
  try {
    raw = JSON.parse(readFileSync(join(ws, "connectors.json"), "utf8")) as {
      composioApiKey?: unknown;
      userId?: unknown;
      catalog?: unknown;
      toolRouter?: unknown;
    };
  } catch {
    return null;
  }
  const apiKey =
    typeof raw.composioApiKey === "string" ? raw.composioApiKey : "";
  const userId = typeof raw.userId === "string" ? raw.userId.trim() : "";
  if (!apiKey || !userId) return null;

  const catalog: OwnComposioIdentity["catalog"] = [];
  if (Array.isArray(raw.catalog)) {
    for (const entry of raw.catalog) {
      if (entry === null || typeof entry !== "object") continue;
      const e = entry as {
        slug?: unknown;
        server_id?: unknown;
        mcp_url?: unknown;
      };
      if (typeof e.slug !== "string" || !e.slug) continue;
      catalog.push({
        slug: e.slug.trim().toLowerCase(),
        ...(typeof e.server_id === "string" && e.server_id
          ? { serverId: e.server_id }
          : {}),
        ...(typeof e.mcp_url === "string" && e.mcp_url
          ? { mcpUrl: e.mcp_url }
          : {}),
      });
    }
  }

  const router = raw.toolRouter;
  const sessionId =
    router !== null &&
    typeof router === "object" &&
    typeof (router as { sessionId?: unknown }).sessionId === "string"
      ? ((router as { sessionId: string }).sessionId as string)
      : undefined;

  return {
    apiKey,
    userId,
    catalog,
    ...(sessionId ? { toolRouterSessionId: sessionId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Durable report — what the surface reads so it can be honest about zero
// ---------------------------------------------------------------------------

export interface ComposioMcpProvisionReport {
  version: 1;
  /** Epoch ms of the last completed run. */
  lastRunAt: number;
  /** Composio MCP servers actually present in config after that run. */
  serverCount: number;
  /** Whether the meta/discovery tool-router server is configured. */
  toolRouterReady: boolean;
  /** Toolkit slugs that now have a server entry. */
  toolkits: string[];
  /**
   * Why nothing could be provisioned at all (`no_workspace`,
   * `no_composio_credentials`). Absent when provisioning was able to run.
   */
  blocked?: string;
  /** Per-target failures from the last run — never summarised away. */
  failures: Array<{ target: string; error: string }>;
  /** Tool-router session this instance minted, so a rerun reuses it. */
  toolRouterSessionId?: string;
}

let reportMemo: ComposioMcpProvisionReport | null = null;

function reportPath(): string | null {
  const ws = process.env.VELLUM_WORKSPACE_DIR;
  return ws ? join(ws, REPORT_FILENAME) : null;
}

/**
 * The last provisioning outcome, or null when provisioning has never run on
 * this instance. Null means "we do not know", NOT "everything is fine" —
 * callers must not render it as readiness.
 */
export function getComposioMcpProvisionReport(): ComposioMcpProvisionReport | null {
  if (reportMemo) return reportMemo;
  const path = reportPath();
  if (!path) return null;
  try {
    const raw = JSON.parse(
      readFileSync(path, "utf8"),
    ) as ComposioMcpProvisionReport;
    if (raw?.version === 1 && typeof raw.serverCount === "number") {
      reportMemo = {
        ...raw,
        toolkits: Array.isArray(raw.toolkits) ? raw.toolkits : [],
        failures: Array.isArray(raw.failures) ? raw.failures : [],
      };
      return reportMemo;
    }
  } catch {
    // No report yet, or an unreadable one — stays unknown.
  }
  return null;
}

function persistReport(report: ComposioMcpProvisionReport): void {
  reportMemo = report;
  const path = reportPath();
  if (!path) return;
  try {
    writeFileSync(path, JSON.stringify(report));
  } catch (err) {
    // Losing the report costs the surface its honesty about zero, so this is
    // a warn rather than a debug even though provisioning itself succeeded.
    log.warn({ err }, "composio MCP provision report write failed");
  }
}

// ---------------------------------------------------------------------------
// Composio API — always with THIS instance's own project key
// ---------------------------------------------------------------------------

interface Api {
  key: string;
  fetchImpl: typeof fetch;
}

async function composioApi(
  api: Api,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await api.fetchImpl(`${COMPOSIO_API_BASE}${path}`, {
    method,
    headers: {
      "x-api-key": api.key,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Status only. A Composio error body echoes the request, which can carry
    // credential material, and this string ends up in a workspace report.
    throw new Error(`composio ${method} ${path} -> ${res.status}`);
  }
  return res.json();
}

/**
 * Proof that a per-toolkit MCP server id belongs to THIS instance's project.
 *
 * Returns the server's own URL and tool count, or null when the id is not
 * visible under our key (a foreign or deleted id) or does not actually serve
 * the toolkit we asked about. Null means "discard the hint", never "use it
 * anyway".
 */
async function proveToolkitServerOwned(
  api: Api,
  serverId: string,
  slug: string,
): Promise<{ mcpUrl: string; toolCount: number } | null> {
  let body: {
    id?: unknown;
    mcp_url?: unknown;
    toolkits?: unknown;
    allowed_tools?: unknown;
  };
  try {
    body = (await composioApi(
      api,
      "GET",
      `/mcp/${encodeURIComponent(serverId)}`,
    )) as {
      id?: unknown;
      mcp_url?: unknown;
      toolkits?: unknown;
      allowed_tools?: unknown;
    };
  } catch {
    // 404/403 under our own project key is the expected shape for another
    // tenant's id. Not an error worth surfacing — it is the guard working.
    return null;
  }
  const toolkits = Array.isArray(body.toolkits)
    ? body.toolkits.filter((t): t is string => typeof t === "string")
    : [];
  if (!toolkits.some((t) => t.trim().toLowerCase() === slug)) return null;
  const mcpUrl =
    typeof body.mcp_url === "string" && body.mcp_url
      ? body.mcp_url
      : `${MCP_URL_BASE}/${serverId}`;
  const toolCount = Array.isArray(body.allowed_tools)
    ? body.allowed_tools.length
    : 0;
  return { mcpUrl, toolCount };
}

/**
 * Composio rejects MCP server names outside `^[a-zA-Z0-9- ]+$` / 4-30 chars,
 * and 409s on a duplicate. The random suffix means a run that died after
 * creating a server cannot wedge every later retry on a name clash.
 */
function serverNameForToolkit(slug: string): string {
  const safe = slug.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 16) || "app";
  return `cue-${safe}-${randomBytes(2).toString("hex")}`.slice(0, 30);
}

/** Resolve (hint → existing → create) a per-toolkit MCP server for a slug. */
async function resolveToolkitServer(
  api: Api,
  identity: OwnComposioIdentity,
  slug: string,
): Promise<{ mcpUrl: string; toolCount: number }> {
  // 1. A hint from our own connectors.json — used only once proved ours.
  const hinted = identity.catalog.find((c) => c.slug === slug)?.serverId;
  if (hinted) {
    const proved = await proveToolkitServerOwned(api, hinted, slug);
    if (proved) return proved;
    log.warn(
      { slug },
      "connectors.json names an MCP server this project cannot see — " +
        "discarding the hint and resolving under our own key",
    );
  }

  // 2. Anything this project already has for the toolkit. The key is
  //    project-scoped, so this list cannot contain another tenant's server.
  try {
    const listed = (await composioApi(
      api,
      "GET",
      `/mcp/servers?toolkits=${encodeURIComponent(slug)}&limit=10`,
    )) as {
      items?: Array<{
        id?: unknown;
        mcp_url?: unknown;
        allowed_tools?: unknown;
      }>;
    };
    const found = (listed.items ?? []).find((i) => typeof i.id === "string");
    if (found) {
      return {
        mcpUrl:
          typeof found.mcp_url === "string" && found.mcp_url
            ? found.mcp_url
            : `${MCP_URL_BASE}/${String(found.id)}`,
        toolCount: Array.isArray(found.allowed_tools)
          ? found.allowed_tools.length
          : 0,
      };
    }
  } catch (err) {
    log.debug(
      { err: String(err), slug },
      "mcp server list failed — will create",
    );
  }

  // 3. Create one. An ACTIVE toolkit always has an auth config already (the
  //    connect route creates it), so this is a lookup, not a create — if it
  //    is genuinely missing there is nothing to build a server on and the
  //    caller records the failure rather than inventing a config.
  const auth = (await composioApi(
    api,
    "GET",
    `/auth_configs?toolkit_slug=${encodeURIComponent(slug)}&limit=10`,
  )) as { items?: Array<{ id?: unknown }> };
  const authConfigId = (auth.items ?? []).find((i) => typeof i.id === "string")
    ?.id as string | undefined;
  if (!authConfigId) {
    throw new Error(`no auth config for toolkit "${slug}" in this project`);
  }

  const created = (await composioApi(api, "POST", "/mcp/servers", {
    name: serverNameForToolkit(slug),
    auth_config_ids: [authConfigId],
    managed_auth_via_composio: true,
  })) as { id?: unknown; mcp_url?: unknown; allowed_tools?: unknown };
  if (typeof created.id !== "string" || !created.id) {
    throw new Error(`composio created an MCP server with no id for "${slug}"`);
  }
  return {
    mcpUrl:
      typeof created.mcp_url === "string" && created.mcp_url
        ? created.mcp_url
        : `${MCP_URL_BASE}/${created.id}`,
    toolCount: Array.isArray(created.allowed_tools)
      ? created.allowed_tools.length
      : 0,
  };
}

/**
 * Resolve the tool-router session — the `composio` server that carries
 * `COMPOSIO_SEARCH_TOOLS` / `COMPOSIO_MULTI_EXECUTE_TOOL`.
 *
 * This one is not optional garnish: SOUL.md's `## Reach` section tells the
 * model those exact tool names are how it gets to Gmail/Calendar/Slack at
 * all. Without this server they are names in a prompt with nothing behind
 * them — the failure mode that had 77 turns answering "I don't have access
 * to your emails".
 *
 * A router URL carries no `user_id`: the session itself is the identity. So
 * an inherited session id is proved by asking Composio whose it is, and a
 * session belonging to anyone but us is discarded outright.
 */
async function resolveToolRouter(
  api: Api,
  identity: OwnComposioIdentity,
  hintedSessionId: string | undefined,
): Promise<{ url: string; sessionId: string; toolCount: number }> {
  if (hintedSessionId) {
    try {
      const body = (await composioApi(
        api,
        "GET",
        `/tool_router/session/${encodeURIComponent(hintedSessionId)}`,
      )) as {
        session_id?: unknown;
        mcp?: { url?: unknown };
        config?: { user_id?: unknown };
        tool_router_tools?: unknown;
      };
      const sessionUser =
        typeof body.config?.user_id === "string"
          ? body.config.user_id.trim()
          : "";
      if (sessionUser && sessionUser === identity.userId) {
        const url = typeof body.mcp?.url === "string" ? body.mcp.url : "";
        if (url) {
          return {
            url,
            sessionId: hintedSessionId,
            toolCount: Array.isArray(body.tool_router_tools)
              ? body.tool_router_tools.length
              : 0,
          };
        }
      } else {
        log.warn(
          "a tool-router session on this instance belongs to a different " +
            "user_id — discarding it and minting our own",
        );
      }
    } catch {
      // Not visible under our key, or gone. Mint a fresh one.
    }
  }

  const created = (await composioApi(api, "POST", "/tool_router/session", {
    user_id: identity.userId,
  })) as {
    session_id?: unknown;
    mcp?: { url?: unknown };
    tool_router_tools?: unknown;
  };
  const sessionId =
    typeof created.session_id === "string" ? created.session_id : "";
  const url = typeof created.mcp?.url === "string" ? created.mcp.url : "";
  if (!sessionId || !url) {
    throw new Error("composio tool-router session returned no id or url");
  }
  return {
    url,
    sessionId,
    toolCount: Array.isArray(created.tool_router_tools)
      ? created.tool_router_tools.length
      : 0,
  };
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/**
 * A newly written server entry. `maxTools` is set from the tool count the
 * server actually reports rather than left on the schema default of 20,
 * because the manager TRUNCATES silently past that cap — an agent quietly
 * missing half a toolkit's tools is exactly the class of defect this module
 * exists to stop.
 */
function buildServerEntry(
  url: string,
  toolCount: number,
): Record<string, unknown> {
  return {
    transport: { type: "streamable-http", url },
    enabled: true,
    // Matches the owner's working instance. Composio tools still pass through
    // the normal approval and outbound-send guards; this is the MCP-layer
    // default, not a bypass.
    defaultRiskLevel: "low",
    maxTools: Math.max(toolCount, 1),
  };
}

type RawServers = Record<string, Record<string, unknown>>;

function readServersFromRawConfig(raw: Record<string, unknown>): RawServers {
  const mcp = raw.mcp;
  if (mcp === null || typeof mcp !== "object") return {};
  const servers = (mcp as { servers?: unknown }).servers;
  if (
    servers === null ||
    typeof servers !== "object" ||
    Array.isArray(servers)
  ) {
    return {};
  }
  return servers as RawServers;
}

/** Composio-backed server keys currently in config — the honest count. */
function countComposioServers(servers: RawServers): {
  count: number;
  toolkits: string[];
  routerReady: boolean;
} {
  const keys = Object.keys(servers);
  const toolkits = keys
    .filter((k) => k.startsWith("composio_"))
    .map((k) => k.slice("composio_".length))
    .filter(Boolean)
    .sort();
  const routerReady = keys.includes(TOOL_ROUTER_SERVER_KEY);
  return {
    count: toolkits.length + (routerReady ? 1 : 0),
    toolkits,
    routerReady,
  };
}

let inFlight: Promise<ComposioMcpProvisionReport> | null = null;

/**
 * Ensure this instance has the MCP servers that make its own connected
 * Composio accounts reachable by the agent.
 *
 * Takes only toolkit slugs — there is no identity parameter, by design. The
 * `user_id` every URL is bound to comes from this instance's own
 * `connectors.json` and cannot be supplied by a caller.
 *
 * Never throws. Concurrent callers share one run.
 */
export function provisionComposioMcpServers(
  activeSlugs: Iterable<string>,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<ComposioMcpProvisionReport> {
  if (inFlight) return inFlight;
  inFlight = runProvision(activeSlugs, deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runProvision(
  activeSlugs: Iterable<string>,
  deps: { fetchImpl?: typeof fetch },
): Promise<ComposioMcpProvisionReport> {
  const failures: Array<{ target: string; error: string }> = [];

  const blocked = (reason: string): ComposioMcpProvisionReport => {
    const report: ComposioMcpProvisionReport = {
      version: 1,
      lastRunAt: Date.now(),
      serverCount: 0,
      toolRouterReady: false,
      toolkits: [],
      blocked: reason,
      failures,
    };
    persistReport(report);
    return report;
  };

  if (!process.env.VELLUM_WORKSPACE_DIR) {
    // No workspace to read an identity from and nowhere to write a report.
    // Returning quietly here is the one silent path, and it is unreachable
    // in a running daemon.
    return {
      version: 1,
      lastRunAt: Date.now(),
      serverCount: 0,
      toolRouterReady: false,
      toolkits: [],
      blocked: "no_workspace",
      failures,
    };
  }

  const identity = readOwnComposioIdentity();
  if (!identity) {
    log.warn(
      "no Composio credentials in this instance's connectors.json — no " +
        "connector MCP servers can be provisioned; connected apps will have " +
        "no tools behind them",
    );
    return blocked("no_composio_credentials");
  }

  const api: Api = { key: identity.apiKey, fetchImpl: deps.fetchImpl ?? fetch };

  let raw: Record<string, unknown>;
  try {
    raw = loadRawConfig();
  } catch (err) {
    failures.push({ target: "config", error: String(err) });
    return blocked("config_unreadable");
  }

  const servers = { ...readServersFromRawConfig(raw) };
  let mutated = false;

  // ── tool router ─────────────────────────────────────────────────────────
  // Provisioned whenever credentials exist, INCLUDING with zero connected
  // toolkits: it is how the model discovers and connects apps in the first
  // place, so a brand-new tester needs it before their first OAuth.
  const priorReport = getComposioMcpProvisionReport();
  let routerSessionId =
    priorReport?.toolRouterSessionId ?? identity.toolRouterSessionId;

  if (!servers[TOOL_ROUTER_SERVER_KEY]) {
    try {
      const router = await resolveToolRouter(api, identity, routerSessionId);
      servers[TOOL_ROUTER_SERVER_KEY] = buildServerEntry(
        router.url,
        router.toolCount,
      );
      routerSessionId = router.sessionId;
      mutated = true;
      log.info("provisioned the Composio tool-router MCP server");
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failures.push({ target: TOOL_ROUTER_SERVER_KEY, error });
      log.warn({ error }, "tool-router MCP provisioning failed");
    }
  }

  // ── per-toolkit servers ─────────────────────────────────────────────────
  const pending = [
    ...new Set(
      [...activeSlugs]
        .map((s) => (typeof s === "string" ? s.trim().toLowerCase() : ""))
        .filter((s) => s.length > 0),
    ),
  ].filter((slug) => !servers[toolkitServerKey(slug)]);

  for (const slug of pending) {
    try {
      const resolved = await resolveToolkitServer(api, identity, slug);
      servers[toolkitServerKey(slug)] = buildServerEntry(
        // The identity rewrite is applied HERE, on every path — hinted,
        // listed, and freshly created alike — so no resolution branch can
        // become the one that forgets.
        bindServerUrlToOwnUser(resolved.mcpUrl, identity.userId),
        resolved.toolCount,
      );
      mutated = true;
      log.info({ slug }, "provisioned a Composio toolkit MCP server");
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failures.push({ target: toolkitServerKey(slug), error });
      log.warn({ slug, error }, "toolkit MCP provisioning failed");
    }
  }

  if (mutated) {
    try {
      const mcp = (
        raw.mcp !== null &&
        typeof raw.mcp === "object" &&
        !Array.isArray(raw.mcp)
          ? (raw.mcp as Record<string, unknown>)
          : {}
      ) as Record<string, unknown>;
      mcp.servers = servers;
      // Every server's maxTools is its real tool count; the global cap
      // truncates the total just as silently, so raise it to fit. Only ever
      // upward — an operator who lowered it deliberately keeps their floor.
      const needed = Object.values(servers).reduce(
        (sum, s) => sum + (typeof s.maxTools === "number" ? s.maxTools : 20),
        0,
      );
      const current =
        typeof mcp.globalMaxTools === "number" ? mcp.globalMaxTools : 50;
      if (needed > current) mcp.globalMaxTools = needed;
      raw.mcp = mcp;
      saveRawConfig(raw);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failures.push({ target: "config", error });
      log.warn({ error }, "writing provisioned MCP servers to config failed");
      // The in-memory `servers` no longer reflects disk. Report what is
      // actually on disk rather than what we hoped to write.
      const onDisk = countComposioServers(
        readServersFromRawConfig(loadRawConfig()),
      );
      const report: ComposioMcpProvisionReport = {
        version: 1,
        lastRunAt: Date.now(),
        serverCount: onDisk.count,
        toolRouterReady: onDisk.routerReady,
        toolkits: onDisk.toolkits,
        failures,
        ...(routerSessionId ? { toolRouterSessionId: routerSessionId } : {}),
      };
      persistReport(report);
      return report;
    }
  }

  const summary = countComposioServers(servers);
  const report: ComposioMcpProvisionReport = {
    version: 1,
    lastRunAt: Date.now(),
    serverCount: summary.count,
    toolRouterReady: summary.routerReady,
    toolkits: summary.toolkits,
    failures,
    ...(routerSessionId ? { toolRouterSessionId: routerSessionId } : {}),
  };
  persistReport(report);

  if (mutated) {
    // Hot-reload so the tools appear without a restart. Lazily imported: this
    // module is reachable from the capability path and has no business
    // pulling the MCP manager in just to read a report.
    try {
      const { reloadMcpServers } =
        await import("../daemon/mcp-reload-service.js");
      const result = await reloadMcpServers();
      if (!result.success) {
        log.warn(
          { error: result.error },
          "MCP reload after provisioning failed",
        );
      }
    } catch (err) {
      log.warn({ err }, "MCP reload after provisioning could not run");
    }
  }

  return report;
}

/** Test hook: drop memoised state so the next read reloads from disk. */
export function resetComposioMcpProvisionForTest(): void {
  reportMemo = null;
  inFlight = null;
}
