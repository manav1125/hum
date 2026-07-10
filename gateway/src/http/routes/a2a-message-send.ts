/**
 * A2A inbound message endpoint:
 * - POST /a2a/message:send — JSON-RPC `message/send` from a peer agent.
 *
 * This is the counterpart to the agent card (`a2a-routes.ts`): the card
 * advertises this URL, and peers POST a JSON-RPC `message/send` here. The
 * gateway parses the envelope, asks the assistant to persist an inbound task
 * (ACL-gated on a trusted A2A contact), forwards the message through the normal
 * inbound pipeline with a `/deliver/a2a?taskId=…` reply callback, and returns
 * the submitted Task synchronously. The assistant runs the turn and pushes the
 * completed task to the requester's push URL (streaming:false, push:true).
 *
 * Sender identity is self-asserted (header `x-a2a-sender-id` or
 * `params.metadata.senderId`) and gated by the trusted-contact allowlist. A
 * cryptographic sender proof (signed token / mutual auth) is a follow-up; until
 * then the trust boundary is the invite-established contact list, and the whole
 * channel is gated by the `a2a-channel` feature flag (off by default).
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

/** JSON-RPC 2.0 error codes we use (subset). */
const JSONRPC = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
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
    // The advertised binding uses `message:send`; the JSON-RPC method name is
    // `message/send`. Accept either spelling defensively.
    if (body.method !== "message/send" && body.method !== "message:send") {
      return rpcError(
        rpcId,
        JSONRPC.MethodNotFound,
        `Unsupported method: ${String(body.method)}`,
      );
    }

    const params = (body.params ?? {}) as {
      message?: {
        message_id?: unknown;
        role?: unknown;
        parts?: unknown;
        context_id?: unknown;
      };
      configuration?: { pushNotificationConfig?: { url?: unknown } };
      metadata?: { senderId?: unknown };
    };
    const message = params.message;
    if (
      !message ||
      typeof message.message_id !== "string" ||
      !message.message_id ||
      (message.role !== "user" && message.role !== "agent") ||
      !Array.isArray(message.parts)
    ) {
      return rpcError(
        rpcId,
        JSONRPC.InvalidParams,
        "params.message must be a valid A2A message (message_id, role, parts)",
      );
    }

    // Sender identity: header wins, then message metadata. Self-asserted; the
    // trust decision is the assistant's trusted-contact ACL below.
    const senderAssistantId =
      req.headers.get("x-a2a-sender-id")?.trim() ||
      (typeof params.metadata?.senderId === "string"
        ? params.metadata.senderId.trim()
        : "");
    if (!senderAssistantId) {
      return rpcError(
        rpcId,
        JSONRPC.InvalidParams,
        "sender identity required (x-a2a-sender-id header or params.metadata.senderId)",
      );
    }

    const contextId =
      typeof message.context_id === "string" && message.context_id
        ? message.context_id
        : crypto.randomUUID();
    const pushUrl =
      typeof params.configuration?.pushNotificationConfig?.url === "string"
        ? params.configuration.pushNotificationConfig.url
        : undefined;
    const content = extractText(message.parts);

    // 1. Persist the inbound task (ACL-gated on a trusted A2A contact). The
    //    assistant returns the task id we embed in the reply callback.
    let taskId: string;
    try {
      const result = (await ipcCallAssistant("integrations_a2a_inbound_post", {
        senderAssistantId,
        message,
        contextId,
        ...(pushUrl ? { pushUrl } : {}),
      })) as { taskId?: unknown };
      if (!result || typeof result.taskId !== "string" || !result.taskId) {
        throw new Error("assistant did not return a task id");
      }
      taskId = result.taskId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A trusted-contact ACL rejection surfaces here as a thrown error.
      log.warn(
        { err: msg, senderAssistantId },
        "A2A inbound task creation failed",
      );
      return rpcError(
        rpcId,
        JSONRPC.InvalidRequest,
        `A2A message rejected: ${msg}`,
      );
    }

    // 2. Forward through the normal inbound pipeline. The reply is delivered
    //    directly by the assistant via /deliver/a2a?taskId=… (task completion +
    //    push), so this is fire-and-forget from the JSON-RPC caller's view.
    const event: A2aInboundEvent = {
      version: "v1",
      sourceChannel: "a2a",
      receivedAt: new Date().toISOString(),
      message: {
        content,
        conversationExternalId: contextId,
        externalMessageId: message.message_id,
      },
      actor: { actorExternalId: senderAssistantId },
      source: { updateId: message.message_id },
      raw: body,
    };

    try {
      const result = await handleInbound(config, event, {
        replyCallbackUrl: `${config.gatewayInternalBaseUrl}/deliver/a2a?taskId=${encodeURIComponent(taskId)}`,
      });
      if (result.rejected) {
        log.warn(
          { senderAssistantId, reason: result.rejectionReason },
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

    log.info({ taskId, senderAssistantId }, "A2A message accepted");
    // Return the submitted Task synchronously; the result is pushed later.
    return Response.json({
      jsonrpc: "2.0",
      id: rpcId,
      result: {
        id: taskId,
        context_id: contextId,
        status: { state: "submitted" },
      },
    });
  };
}

export { A2A_MESSAGE_SEND_PATH };
