/**
 * MCP-backed connector reconciliation.
 *
 * Cue has two connector systems that historically did not know about each
 * other: native OAuth (the `oauth_connections` table) and MCP servers
 * (`mcp.servers` in config — Composio-backed toolkits like `composio_gmail`,
 * plus any native MCP servers). The capability/assessment layer read only
 * native OAuth, so on an instance whose accounts are all wired through MCP it
 * believed ZERO accounts were connected and told the model
 * "LINKED ACCOUNTS: none" — wrongly blocking tasks the agent could in fact do.
 *
 * This module maps enabled MCP servers to the same canonical provider strings
 * native OAuth uses ("google", "slack", …) so the two systems can be
 * reconciled into one honest connector view.
 *
 * ── `enabled` is NOT connection status (the over-claim this module now fixes) ─
 * An enabled Composio MCP server (`composio_gmail`) only means "Cue will route
 * to this server". That flag is set once at connect time and never cleared when
 * the underlying Composio OAuth connection dies — so it is INDEPENDENT of
 * whether the account actually authenticates. Reporting a provider as linked
 * purely because its server is `enabled` therefore over-claims: a `composio_
 * gmail` server sits `enabled: true` while Composio reports the connection
 * `initiated`/expired, and the model confidently tries Gmail and fails.
 *
 * So a Composio-backed provider is reconciled against the REAL per-toolkit
 * ACTIVE status (`composio-connection-status.ts`, a cheap cached snapshot of
 * Composio's `connected_accounts?statuses=ACTIVE`). Only a genuinely ACTIVE
 * toolkit backs a "linked account" claim; an enabled-but-inactive one is
 * surfaced separately as "needs attention" so the model verifies before
 * relying, and never appears in a hard linked-accounts list.
 *
 * ── Agent reach vs native pollability (load-bearing distinction) ──────────
 * A verified-connected MCP server means "the AGENT can act on this provider" —
 * it can call the provider's tools through the MCP/Composio proxy. It does NOT
 * mean "a native REST poller can authenticate": a native Gmail watcher polls
 * Google's API directly with a native OAuth access token, which an
 * MCP/Composio connection does not provide. Callers that need native
 * pollability (the watcher pre-poll gate) must therefore NOT treat MCP
 * coverage as a native credential. This module answers only the agent-reach
 * question; native pollability stays with `hasCredentialConnection`
 * (native-only) in `credential-health/credential-health-service.ts`.
 */

import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { composioToolkitStatus } from "./composio-connection-status.js";

const log = getLogger("mcp-connectors");

/**
 * Composio toolkit slug → canonical provider string (the same strings native
 * OAuth uses, so the two connector systems de-duplicate cleanly). All Google
 * surfaces collapse to a single "google" account; Microsoft surfaces collapse
 * to "outlook". Extend as new toolkits are commonly connected — an unmapped
 * `composio_<slug>` still surfaces as its slug (see `mcpServerKeyToProvider`),
 * so a newly connected app is never silently dropped.
 */
const TOOLKIT_PROVIDER: Readonly<Record<string, string>> = {
  gmail: "google",
  googlecalendar: "google",
  googledrive: "google",
  googlesheets: "google",
  googledocs: "google",
  google: "google",
  slack: "slack",
  slack_channel: "slack",
  github: "github",
  linear: "linear",
  airtable: "airtable",
  hubspot: "hubspot",
  notion: "notion",
  outlook: "outlook",
  onedrive: "outlook",
  office365: "outlook",
  discord: "discord",
  dropbox: "dropbox",
  asana: "asana",
  salesforce: "salesforce",
  figma: "figma",
  telegram: "telegram",
  todoist: "todoist",
};

/**
 * Map an MCP server key to the canonical provider account it backs, or null
 * when it backs no single provider account.
 *
 * Composio toolkit servers are keyed `composio_<toolkitslug>`. The bare
 * `composio` server is the remote tool workbench — a meta-connector, not a
 * specific linked account — so it maps to null. Non-Composio MCP servers only
 * count as a linked-account connector when the key clearly names a known
 * provider; generic tool servers (filesystem, memory, …) are not accounts and
 * must not pollute the linked-account view.
 */
export function mcpServerKeyToProvider(serverKey: string): string | null {
  const key = serverKey.trim().toLowerCase();
  if (!key || key === "composio") return null;
  if (key.startsWith("composio_")) {
    const slug = key.slice("composio_".length);
    if (!slug) return null;
    return TOOLKIT_PROVIDER[slug] ?? slug;
  }
  return TOOLKIT_PROVIDER[key] ?? null;
}

/**
 * The Composio toolkit slug an MCP server key backs, or null when the server
 * is not a per-toolkit Composio server (the bare `composio` workbench, or a
 * non-Composio native MCP server). Only Composio toolkit servers have a live
 * per-toolkit connection status to reconcile against.
 */
export function mcpServerKeyToComposioToolkit(serverKey: string): string | null {
  const key = serverKey.trim().toLowerCase();
  if (!key || key === "composio" || !key.startsWith("composio_")) return null;
  const slug = key.slice("composio_".length);
  return slug || null;
}

/**
 * Reconciled MCP connector view, split by how much we can honestly claim.
 *  · `verified`      — providers with POSITIVE evidence of a live connection:
 *                      a non-Composio native MCP server, or a Composio provider
 *                      whose backing toolkit(s) are known-ACTIVE and none are
 *                      known-broken. Safe to assert as a linked account.
 *  · `needsAttention`— providers configured via Composio but not confirmed
 *                      live: at least one backing toolkit is known-inactive
 *                      (enabled but `initiated`/expired), OR status is unknown
 *                      (cold cache). The model must verify before relying and
 *                      these must NOT read as guaranteed linked accounts.
 * The two sets are disjoint: a provider with any known-broken backing toolkit
 * goes to `needsAttention` even if another of its toolkits is active, because
 * the collapsed provider string cannot be trusted wholesale.
 */
export interface McpConnectorReconciliation {
  verified: Set<string>;
  needsAttention: Set<string>;
}

/**
 * Reconcile enabled MCP servers against real Composio connection status.
 * Never throws: a config read error degrades to empty sets so callers fall
 * back to native-only rather than losing their whole connector view.
 */
export function reconcileMcpConnectors(): McpConnectorReconciliation {
  const empty: McpConnectorReconciliation = {
    verified: new Set(),
    needsAttention: new Set(),
  };
  let servers: Record<string, { enabled?: boolean } | undefined>;
  try {
    servers = getConfig().mcp?.servers ?? {};
  } catch (err) {
    log.debug(
      { err: String(err) },
      "MCP server config unreadable for connector reconciliation",
    );
    return empty;
  }

  // Per-provider evidence tallies, then a single verdict per provider.
  const active = new Set<string>();
  const broken = new Set<string>();
  const seen = new Set<string>();

  for (const [key, cfg] of Object.entries(servers)) {
    // `enabled` defaults to true in the schema; treat only an explicit false as
    // disabled so a defaults-applied or raw-shaped config both read correctly.
    if (cfg?.enabled === false) continue;
    const provider = mcpServerKeyToProvider(key);
    if (!provider) continue;
    seen.add(provider);

    const toolkit = mcpServerKeyToComposioToolkit(key);
    if (!toolkit) {
      // Non-Composio native MCP server: a real local server with genuine
      // agent reach and no Composio dependency — count it as active evidence.
      active.add(provider);
      continue;
    }
    switch (composioToolkitStatus(toolkit)) {
      case "active":
        active.add(provider);
        break;
      case "broken":
        broken.add(provider);
        break;
      case "unknown":
        // No positive and no negative evidence — leaves the provider in
        // `seen` only, which resolves to needsAttention below.
        break;
    }
  }

  const verified = new Set<string>();
  const needsAttention = new Set<string>();
  for (const provider of seen) {
    if (active.has(provider) && !broken.has(provider)) verified.add(provider);
    else needsAttention.add(provider);
  }
  return { verified, needsAttention };
}

/**
 * The set of canonical providers with a VERIFIED live MCP connection — safe to
 * assert as linked accounts. Composio-backed providers appear only when their
 * toolkit is known-ACTIVE; an enabled-but-inactive or unknown-status provider
 * is excluded (see {@link listMcpAttentionProviders}). Never throws.
 */
export function listMcpConnectedProviders(): Set<string> {
  return reconcileMcpConnectors().verified;
}

/**
 * Providers configured through an enabled Composio server but NOT confirmed
 * live — the honest "may need reconnection, verify before relying" bucket.
 * Never throws.
 */
export function listMcpAttentionProviders(): Set<string> {
  return reconcileMcpConnectors().needsAttention;
}

/**
 * Whether the AGENT can act on this provider through MCP. True for a verified
 * live connection; also true when status is merely unknown (cold cache) so we
 * do not tell the user "nothing is connected" when we are simply unsure — but
 * FALSE once a backing toolkit is known-broken, since a Composio proxy call
 * against an inactive connection cannot authenticate. Agent-reach only — see
 * the module header on why this is NOT native pollability.
 */
export function isProviderMcpConnected(provider: string): boolean {
  const p = provider.trim().toLowerCase();
  const { verified, needsAttention } = reconcileMcpConnectors();
  if (verified.has(p)) return true;
  // In `needsAttention` only because a toolkit is known-broken? Not reachable.
  // In `needsAttention` because status is unknown (cold cache)? Treat as
  // reachable — we cannot confirm, and must not claim nothing is connected.
  if (needsAttention.has(p)) return !providerHasBrokenToolkit(p);
  return false;
}

/** Whether any enabled Composio toolkit backing this provider is known-broken. */
function providerHasBrokenToolkit(provider: string): boolean {
  let servers: Record<string, { enabled?: boolean } | undefined>;
  try {
    servers = getConfig().mcp?.servers ?? {};
  } catch {
    return false;
  }
  for (const [key, cfg] of Object.entries(servers)) {
    if (cfg?.enabled === false) continue;
    if (mcpServerKeyToProvider(key) !== provider) continue;
    const toolkit = mcpServerKeyToComposioToolkit(key);
    if (toolkit && composioToolkitStatus(toolkit) === "broken") return true;
  }
  return false;
}
