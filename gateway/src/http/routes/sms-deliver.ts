import type { GatewayConfig } from "../../config.js";
import type { ConfigFileCache } from "../../config-file-cache.js";
import type { CredentialCache } from "../../credential-cache.js";
import { getLogger } from "../../logger.js";
import { sendSmsReply, type SmsSendCaches } from "../../twilio/sms-send.js";
import { enforceLoopbackOnly } from "../loopback-guard.js";
import type { GetClientIp } from "../router.js";

const log = getLogger("sms-deliver");

/**
 * POST /deliver/sms — gateway-owned SMS reply egress.
 *
 * This is the SMS `replyCallbackUrl` target. The daemon never actually
 * POSTs here for agent replies — its direct-delivery matcher
 * (assistant/src/messaging/providers/index.ts) intercepts `/deliver/sms`
 * and calls the Twilio Messages API itself. This route exists for the
 * gateway's own callback-driven deliveries (text-verification replies from
 * gateway/src/verification/reply-delivery.ts POST to the callback URL).
 *
 * Loopback-only: the callback URL is always `gatewayInternalBaseUrl`
 * (http://127.0.0.1:<port>), so any non-local caller is rejected. Without
 * this guard an open relay would let anyone send SMS through the owner's
 * Twilio account.
 */
export function createSmsDeliverHandler(
  _config: GatewayConfig,
  caches?: { credentials?: CredentialCache; configFile?: ConfigFileCache },
) {
  const smsSendCaches: SmsSendCaches | undefined =
    caches?.credentials && caches?.configFile
      ? { credentials: caches.credentials, configFile: caches.configFile }
      : undefined;

  return async (req: Request, getClientIp: GetClientIp): Promise<Response> => {
    const guardResponse = enforceLoopbackOnly(
      req,
      getClientIp(),
      "sms-deliver",
    );
    if (guardResponse) return guardResponse;

    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    let body: { chatId?: unknown; text?: unknown };
    try {
      body = (await req.json()) as { chatId?: unknown; text?: unknown };
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : "";
    const text = typeof body.text === "string" ? body.text : "";

    if (!chatId || text.trim().length === 0) {
      return Response.json(
        { error: "chatId and text are required" },
        { status: 400 },
      );
    }

    if (!smsSendCaches) {
      return Response.json(
        { error: "Twilio SMS is not configured" },
        { status: 503 },
      );
    }

    try {
      await sendSmsReply(chatId, text, smsSendCaches);
      return Response.json({ ok: true });
    } catch (err) {
      log.error({ err, chatId }, "Failed to deliver SMS reply");
      return Response.json({ error: "SMS delivery failed" }, { status: 502 });
    }
  };
}
