import type { ConnectorStatus, ConnectorTool } from "@vellumai/ipc-contract";

import {
  connectorappsDisconnectPost,
  connectorappsGet,
} from "@/generated/daemon/sdk.gen";
import { isElectron } from "@/runtime/is-electron";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/** Whether the connectors control surface is available (desktop + configured). */
export async function connectorsAvailable(): Promise<boolean> {
  // The Electron bridge answers for a LOCAL connector daemon. A desktop app
  // pointed at a remote instance has no bridge, and answering "unavailable"
  // there hid the whole management surface — no Manage button, no detail
  // page — so a connector that authorized against the wrong account could
  // never be disconnected or inspected. The daemon serves the same list over
  // HTTP, so an install with an assistant selected can manage them too.
  if (isElectron() && window.vellum?.connectors) {
    return window.vellum.connectors.available();
  }
  return getSelectedAssistantId() !== null;
}

/** List connectors with this install's connection status. */
export async function listConnectors(): Promise<ConnectorStatus[]> {
  if (isElectron() && window.vellum?.connectors) {
    return window.vellum.connectors.list();
  }
  const assistantId = getSelectedAssistantId();
  if (!assistantId) return [];
  const { data } = await connectorappsGet({
    path: { assistant_id: assistantId },
    throwOnError: true,
  });
  // The daemon carries logo and health beyond this shape; the management
  // surface only needs identity and whether it is connected.
  return (data?.apps ?? []).map((app) => ({
    slug: app.slug,
    name: app.name,
    category: app.category,
    connected: app.connected,
  }));
}

/** Start connecting an app; returns the OAuth URL the user must open. */
export async function connectConnector(slug: string): Promise<string | null> {
  if (!isElectron() || !window.vellum?.connectors) return null;
  return window.vellum.connectors.connect(slug);
}

/**
 * Disconnect an app; returns the refreshed list.
 *
 * The Electron bridge talks to a LOCAL connector daemon, so on a desktop app
 * pointed at a remote instance it is simply absent — and disconnecting
 * silently did nothing at all, returning an empty list as though it had
 * worked. Fall back to the daemon's own endpoint, which is the only route a
 * remote install has. The refreshed list is not available on that path (the
 * daemon answers whether the disconnect happened), so callers re-read the
 * connector list rather than trusting a return value here.
 */
export async function disconnectConnector(
  slug: string,
): Promise<ConnectorStatus[]> {
  if (isElectron() && window.vellum?.connectors) {
    return window.vellum.connectors.disconnect(slug);
  }
  const assistantId = getSelectedAssistantId();
  if (!assistantId) return [];
  await connectorappsDisconnectPost({
    path: { assistant_id: assistantId },
    body: { slug },
    throwOnError: true,
  });
  return [];
}

/** Whether per-tool toggles are available (newer preloads only). */
export function toolTogglesSupported(): boolean {
  return isElectron() && typeof window.vellum?.connectors?.tools === "function";
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

/** The active assistant id, or null when nothing is selected yet. */
function getSelectedAssistantId(): string | null {
  return useResolvedAssistantsStore.getState().selectedAssistantId ?? null;
}
