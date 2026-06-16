import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { net } from "electron";
import { z } from "zod";

import { handle } from "./ipc";
import log from "./logger";

/**
 * Third-party connectors, backed by Composio. The daemon wires each connector's
 * tools as an MCP server (mcp__composio_<slug>__*); this module is the
 * app-facing control surface — list connectors, see which are connected for
 * THIS install, and run the per-user connect/disconnect flow.
 *
 * Identity model: one Composio API key = the Cue app; `userId` = this install's
 * device id, so connected accounts are isolated per user and never shared.
 * The catalog + key + userId are written to the daemon workspace by the
 * connector-setup step and read here.
 */

const COMPOSIO_BASE = "https://backend.composio.dev/api/v3";

// Local assistant workspace (where the connector catalog is written). For a
// single local assistant this is deterministic; a multi-assistant build would
// resolve the active assistant id instead.
const workspaceDir = (): string =>
  join(homedir(), ".local/share/vellum/assistants/cue-local/.vellum/workspace");

const connectorsConfigPath = (): string =>
  join(workspaceDir(), "connectors.json");

/** The daemon's config.json — read/written for per-tool toggles (the
 *  config-watcher hot-reloads MCP on change, so toggles apply instantly). */
const daemonConfigPath = (): string => join(workspaceDir(), "config.json");

interface CatalogEntry {
  slug: string;
  name: string;
  category: string;
  auth_config_id: string;
  server_id: string;
  mcp_url: string;
}
interface ConnectorsConfig {
  composioApiKey: string;
  userId: string;
  catalog: CatalogEntry[];
}

const readConfig = (): ConnectorsConfig | null => {
  try {
    return JSON.parse(
      readFileSync(connectorsConfigPath(), "utf8"),
    ) as ConnectorsConfig;
  } catch {
    return null;
  }
};

const composio = async (
  cfg: ConnectorsConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> => {
  const res = await net.fetch(`${COMPOSIO_BASE}${path}`, {
    method,
    headers: {
      "x-api-key": cfg.composioApiKey,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Composio ${method} ${path} -> ${res.status}`);
  }
  return res.json();
};

export interface ConnectorStatus {
  slug: string;
  name: string;
  category: string;
  connected: boolean;
}

const ACTIVE = new Set(["ACTIVE", "INITIATED"]);

/** List connectors with this install's connection status. */
const listConnectors = async (): Promise<ConnectorStatus[]> => {
  const cfg = readConfig();
  if (!cfg) return [];
  // One call: all of this user's connected accounts, then match per toolkit.
  let connectedSlugs = new Set<string>();
  try {
    const data = (await composio(
      cfg,
      "GET",
      `/connected_accounts?user_ids=${encodeURIComponent(cfg.userId)}&limit=100`,
    )) as { items?: Array<{ toolkit?: { slug?: string }; status?: string }> };
    connectedSlugs = new Set(
      (data.items ?? [])
        .filter((c) => c.status === "ACTIVE")
        .map((c) => c.toolkit?.slug ?? "")
        .filter(Boolean),
    );
  } catch (err) {
    log.warn(`[connectors] status fetch failed: ${String(err)}`);
  }
  return cfg.catalog.map((c) => ({
    slug: c.slug,
    name: c.name,
    category: c.category,
    connected: connectedSlugs.has(c.slug),
  }));
};

/** Start a connection for a connector; returns the OAuth URL for the user. */
const connectConnector = async (slug: string): Promise<string | null> => {
  const cfg = readConfig();
  const entry = cfg?.catalog.find((c) => c.slug === slug);
  if (!cfg || !entry) return null;
  const res = (await composio(cfg, "POST", "/connected_accounts", {
    auth_config: { id: entry.auth_config_id },
    connection: { user_id: cfg.userId },
  })) as { redirect_url?: string };
  return res.redirect_url ?? null;
};

/** Disconnect a connector (delete this user's active connection for it). */
const disconnectConnector = async (slug: string): Promise<void> => {
  const cfg = readConfig();
  if (!cfg) return;
  const data = (await composio(
    cfg,
    "GET",
    `/connected_accounts?user_ids=${encodeURIComponent(cfg.userId)}&limit=100`,
  )) as {
    items?: Array<{ id: string; toolkit?: { slug?: string }; status?: string }>;
  };
  const matches = (data.items ?? []).filter(
    (c) => c.toolkit?.slug === slug && ACTIVE.has(c.status ?? ""),
  );
  for (const m of matches) {
    await composio(cfg, "DELETE", `/connected_accounts/${m.id}`).catch(
      (err: unknown) =>
        log.warn(`[connectors] disconnect ${m.id}: ${String(err)}`),
    );
  }
};

// --- Per-tool toggles (write daemon config → config-watcher hot-reloads) ------

export interface ConnectorTool {
  slug: string;
  name: string;
  enabled: boolean;
}

const prettyToolName = (slug: string, toolkitSlug: string): string => {
  const prefix = toolkitSlug.toUpperCase() + "_";
  const bare = slug.startsWith(prefix) ? slug.slice(prefix.length) : slug;
  return bare
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
};

interface DaemonConfig {
  mcp?: {
    servers?: Record<string, { allowedTools?: string[]; maxTools?: number }>;
  };
}

const readDaemonConfig = (): DaemonConfig | null => {
  try {
    return JSON.parse(readFileSync(daemonConfigPath(), "utf8")) as DaemonConfig;
  } catch {
    return null;
  }
};

/** All of a connector's tools, each marked enabled per the daemon allowlist. */
const listConnectorTools = async (slug: string): Promise<ConnectorTool[]> => {
  const cfg = readConfig();
  if (!cfg) return [];
  let all: Array<{ slug: string }> = [];
  try {
    const data = (await composio(
      cfg,
      "GET",
      `/tools?toolkit_slug=${encodeURIComponent(slug)}&limit=100`,
    )) as { items?: Array<{ slug: string }> };
    all = data.items ?? [];
  } catch (err) {
    log.warn(`[connectors] tools fetch failed for ${slug}: ${String(err)}`);
    return [];
  }
  const daemon = readDaemonConfig();
  const server = daemon?.mcp?.servers?.[`composio_${slug}`];
  // No allowlist set yet → treat the current daemon set as "all enabled".
  const allowed = server?.allowedTools;
  return all
    .map((t) => ({
      slug: t.slug,
      name: prettyToolName(t.slug, slug),
      enabled: allowed ? allowed.includes(t.slug) : true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

/** Toggle one tool on/off for a connector; writes the daemon allowlist so the
 *  config-watcher hot-reloads that MCP server (no restart). */
const setConnectorToolEnabled = async (
  slug: string,
  toolSlug: string,
  enabled: boolean,
): Promise<void> => {
  const path = daemonConfigPath();
  let d: {
    mcp?: {
      servers?: Record<string, { allowedTools?: string[]; maxTools?: number }>;
    };
  };
  try {
    d = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    log.warn(`[connectors] read daemon config failed: ${String(err)}`);
    return;
  }
  const key = `composio_${slug}`;
  const server = d.mcp?.servers?.[key];
  if (!server) return;
  const current = new Set(server.allowedTools ?? []);
  if (enabled) current.add(toolSlug);
  else current.delete(toolSlug);
  server.allowedTools = [...current];
  server.maxTools = Math.max(current.size, 1);
  writeFileSync(path, JSON.stringify(d, null, 2));
};

/** Whether connectors are configured on this install at all. */
const connectorsAvailable = (): boolean => readConfig() !== null;

export const installConnectorsIpc = (): void => {
  handle("vellum:connectors:available", z.tuple([]), () =>
    connectorsAvailable(),
  );
  handle("vellum:connectors:list", z.tuple([]), () => listConnectors());
  handle("vellum:connectors:connect", z.tuple([z.string()]), ([slug]) =>
    connectConnector(slug),
  );
  handle(
    "vellum:connectors:disconnect",
    z.tuple([z.string()]),
    async ([slug]): Promise<ConnectorStatus[]> => {
      await disconnectConnector(slug);
      return listConnectors();
    },
  );
  handle(
    "vellum:connectors:tools",
    z.tuple([z.string()]),
    ([slug]): Promise<ConnectorTool[]> => listConnectorTools(slug),
  );
  handle(
    "vellum:connectors:setTool",
    z.tuple([z.string(), z.string(), z.boolean()]),
    async ([slug, tool, enabled]): Promise<ConnectorTool[]> => {
      await setConnectorToolEnabled(slug, tool, enabled);
      return listConnectorTools(slug);
    },
  );
};
