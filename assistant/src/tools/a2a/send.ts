/**
 * A2A outbound send tool (`a2a_send`).
 *
 * Model-facing counterpart to the inbound A2A channel: POSTs a JSON-RPC
 * `message/send` envelope to a peer agent's A2A endpoint — the exact wire
 * shape our own inbound endpoint (`gateway/src/http/routes/a2a-message-send.ts`
 * → the `integrations_a2a_rpc_post` data plane in
 * `runtime/routes/integrations/a2a.ts`) accepts, so a Cue can message a Cue.
 *
 * DORMANT BY DEFAULT: the tool is only surfaced when the environment
 * variable `CUE_A2A_OUTBOUND=1` is set. `getA2AOutboundToolsIfEnabled()`
 * (consumed by `tool-manifest.ts`) returns an empty array when the flag is
 * absent, so the tool is never registered and the model never sees it.
 * The execute path re-checks the flag as belt-and-suspenders.
 *
 * Auth: an optional bearer token is resolved from the credential store under
 * service "a2a-peer", field "token" (storage key `credential/a2a-peer/token`
 * via `credentialKey()`). When absent the request is sent unauthenticated —
 * the peer may reject, and that rejection is surfaced cleanly.
 *
 * Safety: the payload carries only the model-provided message text plus
 * generated ids — never credentials, tokens, or workspace paths. The bearer
 * token travels only in the Authorization header and is never echoed into
 * the tool result or logs. This is an outbound contact/send tool: the name
 * classifies as autonomy class "send" (see `permissions/autonomy-class.ts`,
 * `SEND_SEGMENTS`) and `defaultRiskLevel` is High, so it is never
 * auto-runnable by default.
 */

import {
  A2A_CONTENT_TYPE,
  A2A_VERSION,
  A2A_VERSION_HEADER,
} from "../../a2a/protocol-constants.js";
import { getConfig } from "../../config/loader.js";
import { getPublicBaseUrl } from "../../inbound/public-ingress-urls.js";
import { RiskLevel } from "../../permissions/types.js";
import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

const log = getLogger("a2a-send");

/** Env flag that gates registration AND execution of the tool. */
export const A2A_OUTBOUND_ENV_FLAG = "CUE_A2A_OUTBOUND";

/** Credential-store service/field for the outbound peer bearer token. */
export const A2A_PEER_CREDENTIAL_SERVICE = "a2a-peer";
export const A2A_PEER_CREDENTIAL_FIELD = "token";

/** Single attempt, 15s cap — no retry storm against a peer agent. */
export const A2A_SEND_TIMEOUT_MS = 15_000;

/** Default path of the Cue inbound A2A endpoint, appended when the
 * peer_url has no explicit path. */
const DEFAULT_MESSAGE_SEND_PATH = "/a2a/message:send";

/** Cap on how much of the peer's response body is echoed to the model. */
const MAX_ECHOED_BODY_CHARS = 2_000;

/** Read the gating flag at call time so tests can toggle it. */
export function isA2AOutboundEnabled(): boolean {
  return process.env[A2A_OUTBOUND_ENV_FLAG] === "1";
}

/**
 * Manifest hook: return the a2a outbound tools only when the env flag is
 * set. `tool-manifest.ts` spreads this into `explicitTools`, so when the
 * flag is absent the tool is simply never registered (true zero-surface).
 */
export function getA2AOutboundToolsIfEnabled(): ToolDefinition[] {
  return isA2AOutboundEnabled() ? [a2aSendTool] : [];
}

// ---------------------------------------------------------------------------
// Wire payload
// ---------------------------------------------------------------------------

/**
 * JSON-RPC `message/send` envelope — mirrors exactly what the inbound
 * gateway handler validates: `jsonrpc: "2.0"`, method `message/send`,
 * `params.message` with non-empty string `message_id`, role `user`,
 * `parts` array, optional `context_id`, and sender identity via
 * `params.metadata.senderId` (also sent as the `x-a2a-sender-id` header).
 */
export interface A2ASendEnvelope {
  jsonrpc: "2.0";
  id: string;
  method: "message/send";
  params: {
    message: {
      message_id: string;
      role: "user";
      parts: Array<{ kind: "text"; text: string }>;
      context_id?: string;
    };
    metadata?: { senderId: string };
  };
}

/** Build the outbound JSON-RPC envelope. Exported for tests. */
export function buildA2ASendEnvelope(params: {
  message: string;
  contextId?: string;
  senderId?: string;
}): A2ASendEnvelope {
  return {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "message/send",
    params: {
      message: {
        message_id: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: params.message }],
        ...(params.contextId ? { context_id: params.contextId } : {}),
      },
      ...(params.senderId ? { metadata: { senderId: params.senderId } } : {}),
    },
  };
}

/**
 * Resolve the endpoint URL from the model-provided peer_url. A bare origin
 * (no path) gets the canonical Cue inbound path appended; an explicit path
 * is used verbatim. Exported for tests.
 */
export function resolveA2AEndpoint(peerUrl: string): URL {
  const url = new URL(peerUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`peer_url must be http(s), got ${url.protocol}`);
  }
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = DEFAULT_MESSAGE_SEND_PATH;
  }
  return url;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Injectable dependencies so tests can run without config/vault/network. */
export interface A2ASendDeps {
  fetchImpl?: typeof fetch;
  /** Resolve the outbound bearer token; undefined → send unauthenticated. */
  resolveBearerToken?: () => Promise<string | undefined>;
  /** Resolve our own sender identity for the peer's contact ACL. */
  resolveSenderId?: () => string | undefined;
}

async function defaultResolveBearerToken(): Promise<string | undefined> {
  try {
    const token = await getSecureKeyAsync(
      credentialKey(A2A_PEER_CREDENTIAL_SERVICE, A2A_PEER_CREDENTIAL_FIELD),
    );
    return token || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Our sender identity, matching the invite-flow convention: self-hosted
 * daemons identify as their public base URL (see `acceptA2AInvite` in
 * `daemon/handlers/config-a2a.ts`, which registers the acceptor with
 * `assistantId: localGatewayUrl`).
 */
function defaultResolveSenderId(): string | undefined {
  try {
    return getPublicBaseUrl(getConfig());
  } catch {
    return undefined;
  }
}

function truncate(text: string, max = MAX_ECHOED_BODY_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

export async function executeA2ASend(
  input: Record<string, unknown>,
  context: ToolContext,
  deps: A2ASendDeps = {},
): Promise<ToolExecutionResult> {
  // Belt-and-suspenders: even if something registered the tool while the
  // flag is off, refuse to execute.
  if (!isA2AOutboundEnabled()) {
    return {
      content: `a2a_send is disabled on this deployment (set ${A2A_OUTBOUND_ENV_FLAG}=1 to enable outbound agent-to-agent messaging).`,
      isError: true,
    };
  }

  const peerUrlRaw = input.peer_url;
  if (typeof peerUrlRaw !== "string" || !peerUrlRaw.trim()) {
    return {
      content: '"peer_url" is required and must be a non-empty string.',
      isError: true,
    };
  }
  const message = input.message;
  if (typeof message !== "string" || !message.trim()) {
    return {
      content: '"message" is required and must be a non-empty string.',
      isError: true,
    };
  }
  const contextId = input.context_id;
  if (contextId !== undefined && typeof contextId !== "string") {
    return {
      content: '"context_id" must be a string when provided.',
      isError: true,
    };
  }

  let endpoint: URL;
  try {
    endpoint = resolveA2AEndpoint(peerUrlRaw.trim());
  } catch (err) {
    return {
      content: `Invalid peer_url: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  const resolveBearerToken =
    deps.resolveBearerToken ?? defaultResolveBearerToken;
  const resolveSenderId = deps.resolveSenderId ?? defaultResolveSenderId;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const senderId = resolveSenderId();
  const bearerToken = await resolveBearerToken();

  const envelope = buildA2ASendEnvelope({
    message,
    ...(typeof contextId === "string" && contextId ? { contextId } : {}),
    ...(senderId ? { senderId } : {}),
  });

  const headers: Record<string, string> = {
    "Content-Type": A2A_CONTENT_TYPE,
    [A2A_VERSION_HEADER]: A2A_VERSION,
    ...(senderId ? { "x-a2a-sender-id": senderId } : {}),
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
  };

  // One attempt, bounded by the 15s timeout (and the turn's abort signal).
  const timeoutSignal = AbortSignal.timeout(A2A_SEND_TIMEOUT_MS);
  const signal = context.signal
    ? AbortSignal.any([timeoutSignal, context.signal])
    : timeoutSignal;

  let response: Response;
  try {
    response = await fetchImpl(endpoint.href, {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
      signal,
    });
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    const reason = isTimeout
      ? `peer did not respond within ${A2A_SEND_TIMEOUT_MS / 1000}s`
      : err instanceof Error
        ? err.message
        : String(err);
    log.warn({ peer: endpoint.origin, reason }, "a2a_send delivery failed");
    return {
      content: JSON.stringify({
        delivered: false,
        peer: endpoint.origin,
        error: reason,
      }),
      isError: true,
    };
  }

  const bodyText = await response.text().catch(() => "");
  let body: Record<string, unknown> | undefined;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    body = undefined;
  }

  // JSON-RPC error from the peer (may arrive with HTTP 200).
  const rpcError = body?.error as
    { code?: unknown; message?: unknown } | undefined;
  if (rpcError && typeof rpcError === "object") {
    return {
      content: JSON.stringify({
        delivered: false,
        peer: endpoint.origin,
        httpStatus: response.status,
        peerError: {
          code: typeof rpcError.code === "number" ? rpcError.code : undefined,
          message:
            typeof rpcError.message === "string"
              ? truncate(rpcError.message)
              : undefined,
        },
      }),
      isError: true,
    };
  }

  if (!response.ok) {
    return {
      content: JSON.stringify({
        delivered: false,
        peer: endpoint.origin,
        httpStatus: response.status,
        error: truncate(bodyText || response.statusText || "request failed"),
      }),
      isError: true,
    };
  }

  // Success: surface the peer's JSON-RPC result compactly. A Cue peer
  // returns { id, context_id, status: { state } } (the submitted Task).
  const result = body?.result as
    | {
        id?: unknown;
        context_id?: unknown;
        status?: { state?: unknown };
      }
    | undefined;

  const summary = {
    delivered: true,
    peer: endpoint.origin,
    messageId: envelope.params.message.message_id,
    ...(result && typeof result.id === "string" ? { taskId: result.id } : {}),
    ...(result && typeof result.context_id === "string"
      ? { contextId: result.context_id }
      : {}),
    ...(result && typeof result.status?.state === "string"
      ? { taskState: result.status.state }
      : {}),
    ...(result === undefined && bodyText
      ? { peerResponse: truncate(bodyText) }
      : {}),
  };

  log.info(
    { peer: endpoint.origin, taskId: summary.taskId },
    "a2a_send delivered",
  );
  return { content: JSON.stringify(summary), isError: false };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const a2aSendTool = {
  name: "a2a_send",
  description:
    "Send a message to a peer agent over the A2A (agent-to-agent) protocol. " +
    "POSTs a JSON-RPC message/send request to the peer's A2A endpoint. " +
    "peer_url may be a bare origin (the standard /a2a/message:send path is " +
    "appended) or a full endpoint URL. The message text is sent verbatim — " +
    "never include credentials, secrets, or local file paths. Pass context_id " +
    "to continue an existing conversation with the peer. Returns a compact " +
    "delivery summary including any task id the peer opened.",
  category: "network",
  executionTarget: "sandbox",
  // Outbound contact/send action: High risk so it always requires approval
  // by default; the tool name also classifies as autonomy class "send"
  // (never auto-runnable under autonomy policy).
  defaultRiskLevel: RiskLevel.High,

  input_schema: {
    type: "object",
    properties: {
      peer_url: {
        type: "string",
        description:
          "The peer agent's A2A endpoint. A bare origin (https://peer.example.com) targets /a2a/message:send; a URL with a path is used as-is.",
      },
      message: {
        type: "string",
        description: "The message text to send to the peer agent.",
      },
      context_id: {
        type: "string",
        description:
          "Optional A2A context id to continue an existing conversation thread with the peer.",
      },
    },
    required: ["peer_url", "message"],
    additionalProperties: false,
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeA2ASend(input, context);
  },
} satisfies ToolDefinition;
