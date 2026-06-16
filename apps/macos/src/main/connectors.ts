import { readFileSync } from "node:fs";
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
const connectorsConfigPath = (): string =>
  join(
    homedir(),
    ".local/share/vellum/assistants/cue-local/.vellum/workspace/connectors.json",
  );

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
};
