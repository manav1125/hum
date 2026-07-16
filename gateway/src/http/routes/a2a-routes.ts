/**
 * A2A agent card discovery endpoint:
 * - GET /.well-known/agent-card.json — agent card for peer discovery
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ConfigFileCache } from "../../config-file-cache.js";
import { getWorkspaceDir } from "../../credential-reader.js";
import { getLogger } from "../../logger.js";

const log = getLogger("a2a-routes");

// ── A2A protocol constants (duplicated to avoid cross-package import) ──

const A2A_AGENT_CARD_PATH = "/.well-known/agent-card.json";
const A2A_VERSION = "1.0";

// ── Agent card builder ──────────────────────────────────────────────
//
// The card is served in the A2A JSON-RPC binding's **lowerCamelCase** wire
// form. The canonical serializer lives in the assistant package
// (`assistant/src/a2a/wire-format.ts` → `toWireCard`); this builder mirrors
// that exact shape. The gateway and assistant are separate packages, so the
// shape is intentionally duplicated rather than imported — keep the two in
// sync when either changes.

/** Wire-form (camelCase) agent card. */
type WireAgentCard = Record<string, unknown>;

/**
 * HTTP Bearer security scheme. Peers authenticate inbound A2A JSON-RPC calls
 * with the per-connection peer token from the invite handshake, presented as
 * `Authorization: Bearer <token>`.
 */
const A2A_BEARER_SECURITY_SCHEME = {
  bearer: {
    type: "http",
    scheme: "bearer",
    description:
      "Per-connection peer token exchanged during the A2A invite handshake.",
  },
};

function buildAgentCard(baseUrl: string, assistantName: string): WireAgentCard {
  const endpointUrl = `${baseUrl}/a2a/message:send`;
  return {
    protocolVersion: A2A_VERSION,
    name: assistantName,
    description: `${assistantName} — a Vellum AI assistant`,
    version: "1.0.0",
    url: endpointUrl,
    preferredTransport: "JSONRPC",
    additionalInterfaces: [{ url: endpointUrl, transport: "JSONRPC" }],
    capabilities: {
      streaming: false,
      pushNotifications: true,
      extendedAgentCard: false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "conversation",
        name: "General conversation",
        description: "Send a message and receive a response",
        tags: ["chat"],
      },
    ],
    securitySchemes: A2A_BEARER_SECURITY_SCHEME,
    security: [{ bearer: [] }],
  };
}

// ── Identity helpers ───────────────────────────────────────────────

function readAssistantName(): string {
  try {
    const wsDir = getWorkspaceDir();
    const identityPath = join(wsDir, "prompts", "IDENTITY.md");
    if (!existsSync(identityPath)) return "Vellum Assistant";
    const content = readFileSync(identityPath, "utf-8");
    const match = content.match(/\*\*Name:\*\*\s*(.+)/);
    return match?.[1]?.trim() || "Vellum Assistant";
  } catch {
    return "Vellum Assistant";
  }
}

// ── Route handler factory ──────────────────────────────────────────

export function createAgentCardHandler(configFile: ConfigFileCache) {
  return async (_req: Request): Promise<Response> => {
    const enabled = configFile.getBoolean("a2a", "enabled") ?? false;
    if (!enabled) {
      return Response.json(
        { error: "A2A channel is not enabled" },
        { status: 404 },
      );
    }

    const publicBaseUrl =
      configFile.getString("ingress", "publicBaseUrl") ?? "";
    if (!publicBaseUrl) {
      log.warn("Agent card requested but no public base URL configured");
      return Response.json(
        { error: "Public ingress URL not configured" },
        { status: 503 },
      );
    }

    const assistantName = readAssistantName();
    const card = buildAgentCard(publicBaseUrl, assistantName);

    return Response.json(card, {
      headers: { "Content-Type": "application/json" },
    });
  };
}

export { A2A_AGENT_CARD_PATH };
