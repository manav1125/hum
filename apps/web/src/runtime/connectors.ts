import type { ConnectorStatus, ConnectorTool } from "@vellumai/ipc-contract";

import { isElectron } from "@/runtime/is-electron";

/** Whether the connectors control surface is available (desktop + configured). */
export async function connectorsAvailable(): Promise<boolean> {
  if (!isElectron() || !window.vellum?.connectors) return false;
  return window.vellum.connectors.available();
}

/** List connectors with this install's connection status. */
export async function listConnectors(): Promise<ConnectorStatus[]> {
  if (!isElectron() || !window.vellum?.connectors) return [];
  return window.vellum.connectors.list();
}

/** Start connecting an app; returns the OAuth URL the user must open. */
export async function connectConnector(slug: string): Promise<string | null> {
  if (!isElectron() || !window.vellum?.connectors) return null;
  return window.vellum.connectors.connect(slug);
}

/** Disconnect an app; returns the refreshed list. */
export async function disconnectConnector(
  slug: string,
): Promise<ConnectorStatus[]> {
  if (!isElectron() || !window.vellum?.connectors) return [];
  return window.vellum.connectors.disconnect(slug);
}

/** Whether per-tool toggles are available (newer preloads only). */
export function toolTogglesSupported(): boolean {
  return (
    isElectron() && typeof window.vellum?.connectors?.tools === "function"
  );
}

/** List a connector's tools with enabled state. */
export async function listConnectorTools(
  slug: string,
): Promise<ConnectorTool[]> {
  if (!toolTogglesSupported()) return [];
  return window.vellum!.connectors!.tools!(slug);
}

/** Toggle a single tool on/off; returns the refreshed tool list. */
export async function setConnectorTool(
  slug: string,
  tool: string,
  enabled: boolean,
): Promise<ConnectorTool[]> {
  if (!toolTogglesSupported()) return [];
  return window.vellum!.connectors!.setTool!(slug, tool, enabled);
}
