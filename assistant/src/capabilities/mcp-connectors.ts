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
 * ── Agent reach vs native pollability (load-bearing distinction) ──────────
 * An enabled MCP server means "the AGENT can act on this provider" — it can
 * call the provider's tools through the MCP/Composio proxy. It does NOT mean
 * "a native REST poller can authenticate": a native Gmail watcher polls
 * Google's API directly with a native OAuth access token, which an
 * MCP/Composio connection does not provide. Callers that need native
 * pollability (the watcher pre-poll gate) must therefore NOT treat MCP
 * coverage as a native credential. This module answers only the agent-reach
 * question; native pollability stays with `hasCredentialConnection`
 * (native-only) in `credential-health/credential-health-service.ts`.
 */

import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";

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
 * The set of canonical provider strings reachable via an ENABLED MCP server.
 * Never throws: a config read error degrades to an empty set so callers fall
 * back to native-only rather than losing their whole connector view.
 */
export function listMcpConnectedProviders(): Set<string> {
  const providers = new Set<string>();
  try {
    const servers = getConfig().mcp?.servers;
    if (!servers) return providers;
    for (const [key, cfg] of Object.entries(servers)) {
      // `enabled` defaults to true in the schema; treat only an explicit
      // false as disabled so a defaults-applied or raw-shaped config both read
      // correctly.
      if (cfg?.enabled === false) continue;
      const provider = mcpServerKeyToProvider(key);
      if (provider) providers.add(provider);
    }
  } catch (err) {
    log.debug(
      { err: String(err) },
      "MCP server config unreadable for connector reconciliation",
    );
  }
  return providers;
}

/**
 * Whether an ENABLED MCP server covers this provider (agent-reach only — see
 * the module header on why this is NOT native pollability).
 */
export function isProviderMcpConnected(provider: string): boolean {
  return listMcpConnectedProviders().has(provider.trim().toLowerCase());
}
