/**
 * A2A inbound JSON-RPC endpoint:
 * - POST /a2a/message:send — `message/send`, `tasks/get`, `tasks/cancel` from a
 *   peer agent.
 *
 * The gateway owns the public transport surface. It gates on `a2a.enabled`
 * (mirrors the agent card), parses the JSON-RPC envelope, resolves the asserted
 * sender id (`x-a2a-sender-id` header or `params.metadata.senderId`) and the
 * raw `Authorization` header, then forwards all three to the assistant's
 * authenticated data plane (`integrations_a2a_rpc_post`, over IPC). That data
 * plane enforces **per-peer bearer auth** (the `peerToken` minted during the
 * invite handshake) plus the trusted-contact allowlist, performs the task-store
 * operation, and returns a spec **camelCase** JSON-RPC response — plus, for a
 * successful `message/send`, an `enqueue` directive.
 *
 * For `message/send`, the gateway then drives the agent run through the normal
 * inbound pipeline (`handleInbound`) with a `/deliver/a2a?taskId=…` reply
 * callback, so the eventual reply completes the task and is pushed back via the
 * A2A delivery adapter (streaming:false, push:true).
 *
 * The whole channel is gated by the `a2a-channel` feature flag / `a2a.enabled`
 * config (off by default): flag off ⇒ this endpoint 404s and nothing else runs.
 */

import type { ConfigFileCache } from "../../config-file-cache.js";
import type { GatewayConfig } from "../../config.js";
import { handleInbound } from "../../handlers/handle-inbound.js";
import { ipcCallAssistant } from "../../ipc/assistant-client.js";
import { getLogger } from "../../logger.js";
import type { A2aInboundEvent } from "../../types.js";

const log = getLogger("a2a-message-send");

const A2A_MESSAGE_SEND_PATH = "/a2a/message:send";

// ── JSON-RPC helpers ────────────────────────────────────────────────

/** JSON-RPC 2.0 error codes we emit at the transport boundary (subset). */
const JSONRPC = {
  ParseError: -32700,
  InvalidRequest: -32600,
  InternalError: -32603,
} as const;

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  httpStatus = 200,
): Response {
  return Response.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { status: httpStatus },
  );
}

/**
 * Result shape returned by the assistant's `integrations_a2a_rpc_post` data
 * plane (`handleA2ARpc`): the verbatim JSON-RPC response, plus an optional
 * `enqueue` directive present only for a successful `message/send`. The
 * `message` is the normalized internal A2A message (snake_case field names).
 */
interface A2ARpcRouteResult {
  response: unknown;
  enqueue?: {
    taskId: string;
    message: {
      message_id?: string;
      context_id?: string;
      parts?: Array<{ kind?: string; text?: string }>;
    };
    senderAssistantId: string;
  };
}

/** Join the text parts of an A2A message into a single content string. */
function extractText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const texts: string[] = [];
  for (const p of parts) {
    if (
      p &&
      typeof p === "object" &&
      (p as { kind?: unknown }).kind === "text" &&
      typeof (p as { text?: unknown }).text === "string"
    ) {
      texts.push((p as { text: string }).text);
    }
  }
  return texts.join("\n").trim();
}

/**
 * Resolve the asserted sender id: `x-a2a-sender-id` header wins, then
 * `params.metadata.senderId`. Self-asserted — the trust decision (per-peer
 * bearer + trusted-contact allowlist) is enforced downstream in the assistant.
 */
function resolveSenderId(params: unknown, req: Request): string | null {
  const headerId = req.headers.get("x-a2a-sender-id");
  if (headerId && headerId.trim()) return headerId.trim();

  if (params && typeof params === "object") {
    const metadata = (params as Record<string, unknown>).metadata;
    if (metadata && typeof metadata === "object") {
      const senderId = (metadata as Record<string, unknown>).senderId;
      if (typeof senderId === "string" && senderId.trim()) {
        return senderId.trim();
      }
    }
  }
  return null;
}

// ── Handler factory ─────────────────────────────────────────────────

export function createA2AMessageSendHandler(
  config: GatewayConfig,
  configFile: ConfigFileCache,
) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Gate: the A2A channel must be enabled (mirrors the agent card).
    if (!(configFile.getBoolean("a2a", "enabled") ?? false)) {
      return Response.json(
        { error: "A2A channel is not enabled" },
        { status: 404 },
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return rpcError(null, JSONRPC.ParseError, "Invalid JSON");
    }

    const rpcId =
      typeof body.id === "string" || typeof body.id === "number"
        ? body.id
        : null;

    if (body.jsonrpc !== "2.0") {
      return rpcError(rpcId, JSONRPC.InvalidRequest, "Expected jsonrpc 2.0");
    }
    if (typeof body.method !== "string") {
      return rpcError(rpcId, JSONRPC.InvalidRequest, "Missing method");
    }

    // Sender identity + raw Authorization are forwarded to the data plane; it
    // authenticates (per-peer bearer + trusted-contact allowlist) and maps any
    // failure to a JSON-RPC error in the returned `response`.
    const senderAssistantId = resolveSenderId(body.params, req);
    const authorization = req.headers.get("authorization");

    let routeResult: A2ARpcRouteResult;
    try {
      routeResult = (await ipcCallAssistant("integrations_a2a_rpc_post", {
        rpc: { id: rpcId, method: body.method, params: body.params },
        senderAssistantId,
        authorization,
      })) as A2ARpcRouteResult;
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "A2A RPC data-plane call failed",
      );
      return rpcError(
        rpcId,
        JSONRPC.InternalError,
        "Failed to process message",
      );
    }

    // message/send: the data plane already authenticated the sender and created
    // the task. Forward through the normal inbound pipeline; the reply is
    // delivered directly by the assistant via /deliver/a2a?taskId=… (task
    // completion + push).
    if (routeResult.enqueue) {
      const enqueue = routeResult.enqueue;
      const message = enqueue.message;
      const content = extractText(message.parts);
      const contextId =
        typeof message.context_id === "string" && message.context_id
          ? message.context_id
          : crypto.randomUUID();
      const externalMessageId =
        typeof message.message_id === "string" && message.message_id
          ? message.message_id
          : enqueue.taskId;

      const event: A2aInboundEvent = {
        version: "v1",
        sourceChannel: "a2a",
        receivedAt: new Date().toISOString(),
        message: {
          content,
          conversationExternalId: contextId,
          externalMessageId,
        },
        actor: { actorExternalId: enqueue.senderAssistantId },
        source: { updateId: externalMessageId },
        raw: body,
      };

      try {
        const result = await handleInbound(config, event, {
          replyCallbackUrl: `${config.gatewayInternalBaseUrl}/deliver/a2a?taskId=${encodeURIComponent(enqueue.taskId)}`,
        });
        if (result.rejected) {
          log.warn(
            {
              senderAssistantId: enqueue.senderAssistantId,
              reason: result.rejectionReason,
            },
            "A2A inbound forward rejected by routing",
          );
          return rpcError(
            rpcId,
            JSONRPC.InvalidRequest,
            `A2A message rejected: ${result.rejectionReason ?? "not routable"}`,
          );
        }
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "A2A inbound forward failed",
        );
        return rpcError(
          rpcId,
          JSONRPC.InternalError,
          "Failed to process message",
        );
      }

      log.info(
        {
          taskId: enqueue.taskId,
          senderAssistantId: enqueue.senderAssistantId,
        },
        "A2A message accepted",
      );
    }

    // Relay the data plane's JSON-RPC response verbatim (spec camelCase task
    // for message/send + tasks/get + tasks/cancel; JSON-RPC error otherwise).
    return Response.json(routeResult.response, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

export { A2A_MESSAGE_SEND_PATH };
