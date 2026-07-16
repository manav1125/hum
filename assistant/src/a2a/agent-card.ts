/**
 * A2A v1.0 agent card builder.
 *
 * `buildAgentCard()` constructs a spec-compliant agent card from explicit
 * parameters. `getAgentCard()` is a convenience wrapper that reads the
 * assistant name and public base URL from workspace config.
 */

import { getConfig } from "../config/loader.js";
import { getAssistantName } from "../daemon/identity-helpers.js";
import { getPublicBaseUrl } from "../inbound/public-ingress-urls.js";
import { A2A_VERSION } from "./protocol-constants.js";
import type { AgentCard } from "./protocol-types.js";
import { toWireCard } from "./wire-format.js";

export interface BuildAgentCardParams {
  assistantName: string;
  assistantDescription?: string;
  baseUrl: string;
}

/**
 * HTTP Bearer security scheme advertised on the agent card. Peers authenticate
 * inbound `message/send`, `tasks/get`, and `tasks/cancel` calls with the
 * per-connection `peerToken` minted during the invite exchange (see
 * `peer-auth.ts`), presented as `Authorization: Bearer <token>`.
 */
export const A2A_BEARER_SECURITY_SCHEME = {
  bearer: {
    type: "http",
    scheme: "bearer",
    description:
      "Per-connection peer token exchanged during the A2A invite handshake.",
  },
} as const;

export function buildAgentCard(params: BuildAgentCardParams): AgentCard {
  return {
    protocol_version: A2A_VERSION,
    name: params.assistantName,
    description:
      params.assistantDescription ??
      `${params.assistantName} — a Cue AI assistant`,
    version: "1.0.0",
    supported_interfaces: [
      {
        url: `${params.baseUrl}/a2a/message:send`,
        protocol_binding: "JSONRPC",
        protocol_version: A2A_VERSION,
      },
    ],
    capabilities: {
      streaming: false,
      push_notifications: true,
      extended_agent_card: false,
    },
    default_input_modes: ["text/plain"],
    default_output_modes: ["text/plain"],
    skills: [
      {
        id: "conversation",
        name: "General conversation",
        description: "Send a message and receive a response",
        tags: ["chat"],
      },
    ],
    security_schemes: A2A_BEARER_SECURITY_SCHEME,
    security_requirements: [{ bearer: [] }],
  };
}

export function getAgentCard(): AgentCard {
  const config = getConfig();
  const assistantName = getAssistantName() ?? "Cue";
  const baseUrl = getPublicBaseUrl(config);

  return buildAgentCard({ assistantName, baseUrl });
}

/**
 * Build the agent card and serialize it to its spec-conformant camelCase wire
 * form. This is the shape that must be served at
 * `/.well-known/agent-card.json`.
 */
export function getAgentCardWire(): Record<string, unknown> {
  return toWireCard(getAgentCard());
}
