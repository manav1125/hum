import { buildSmsTransportMetadata } from "../../channels/transport-hints.js";
import type { GatewayConfig } from "../../config.js";
import type { ConfigFileCache } from "../../config-file-cache.js";
import type { CredentialCache } from "../../credential-cache.js";
import { StringDedupCache } from "../../dedup-cache.js";
import { handleInbound } from "../../handlers/handle-inbound.js";
import { getLogger } from "../../logger.js";
import { RejectionRateLimiter } from "../../rejection-rate-limiter.js";
import {
  resolveAssistant,
  isRejection,
} from "../../routing/resolve-assistant.js";
import { normalizeTwilioSmsWebhook } from "../../twilio/sms-normalize.js";
import { sendSmsReply, type SmsSendCaches } from "../../twilio/sms-send.js";
import { validateTwilioWebhookRequest } from "../../twilio/validate-webhook.js";
import {
  handleCircuitBreakerError,
  handleNewCommand,
  isNewCommand,
  processInboundResult,
} from "../../webhook-pipeline.js";
import { ROUTING_REJECTION_NOTICE } from "../../webhook-copy.js";

const log = getLogger("twilio-sms-webhook");

const rejectionLimiter = new RejectionRateLimiter();

/**
 * Empty TwiML response. Returning this (instead of a bare 200) tells Twilio
 * the webhook was handled without triggering an auto-reply; the actual reply
 * is delivered asynchronously via the Messages API once the assistant
 * finishes its turn.
 */
const EMPTY_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

const TWIML_HEADERS = { "Content-Type": "text/xml" };

function twimlOk(): Response {
  return new Response(EMPTY_TWIML, { status: 200, headers: TWIML_HEADERS });
}

/**
 * Twilio incoming-SMS webhook (`/webhooks/twilio/sms`).
 *
 * Mirrors the WhatsApp ingress flow: signature-validated form POST →
 * normalized `"sms"` GatewayInboundEvent → handleInbound (routing, text
 * verification intercept, trust classification) → runtime. Replies are
 * delivered by the daemon's direct-delivery path for `/deliver/sms`
 * (assistant/src/messaging/providers/index.ts) or, for gateway-owned
 * replies (rejections, /new, verification), by the gateway's own
 * `sendSmsReply`.
 */
export function createTwilioSmsWebhookHandler(
  config: GatewayConfig,
  caches?: { credentials?: CredentialCache; configFile?: ConfigFileCache },
) {
  // 24-hour TTL — Twilio Message SIDs are globally unique and never reused
  const dedupCache = new StringDedupCache(24 * 60 * 60_000);

  const smsSendCaches: SmsSendCaches | undefined =
    caches?.credentials && caches?.configFile
      ? { credentials: caches.credentials, configFile: caches.configFile }
      : undefined;

  const sendReplyBestEffort = (to: string, text: string, context: string) => {
    if (!smsSendCaches) return;
    sendSmsReply(to, text, smsSendCaches).catch((err) => {
      log.error({ err, to }, `Failed to send ${context} SMS`);
    });
  };

  const handler = async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? undefined;
    const tlog = traceId ? log.child({ traceId }) : log;

    // Method, payload-size, and X-Twilio-Signature validation — identical
    // to the voice webhook (fail-closed when no auth token is configured).
    const validation = await validateTwilioWebhookRequest(req, config, caches);
    if (validation instanceof Response) return validation;

    const normalized = normalizeTwilioSmsWebhook(validation.params);
    if (!normalized) {
      // Status callbacks, empty bodies, malformed payloads — acknowledge
      // silently so Twilio does not retry.
      return twimlOk();
    }

    const { event, messageSid, numMedia } = normalized;
    const from = event.message.conversationExternalId;

    // Dedup by Message SID — atomically reserve so concurrent retries are
    // blocked while the first request is still processing.
    if (!dedupCache.reserve(messageSid)) {
      tlog.info({ messageSid }, "Duplicate Twilio SMS Message SID, ignoring");
      return twimlOk();
    }

    tlog.info(
      {
        source: "sms",
        messageSid,
        from,
        ...(numMedia > 0 ? { numMedia } : {}),
      },
      "Twilio SMS webhook received",
    );

    // Resolve routing once so we can gate further operations on it
    const routing = resolveAssistant(config, from, from);

    // Handle /new command — reset conversation before it reaches the runtime
    if (isNewCommand(event.message.content)) {
      if (isRejection(routing)) {
        tlog.warn(
          { from, reason: routing.reason },
          "Routing rejected /new command",
        );
        sendReplyBestEffort(from, ROUTING_REJECTION_NOTICE, "/new rejection");
      } else {
        await handleNewCommand(
          config,
          event.sourceChannel,
          event.message.conversationExternalId,
          async (text) => {
            if (!smsSendCaches) return;
            await sendSmsReply(from, text, smsSendCaches);
          },
          tlog,
        );
      }

      dedupCache.mark(messageSid);
      return twimlOk();
    }

    if (isRejection(routing)) {
      tlog.warn(
        { from, reason: routing.reason },
        "Routing rejected inbound SMS message",
      );
      if (rejectionLimiter.shouldSend(from)) {
        sendReplyBestEffort(
          from,
          ROUTING_REJECTION_NOTICE,
          "routing rejection",
        );
      }
      dedupCache.mark(messageSid);
      return twimlOk();
    }

    try {
      const result = await handleInbound(config, event, {
        transportMetadata: buildSmsTransportMetadata(),
        replyCallbackUrl: `${config.gatewayInternalBaseUrl}/deliver/sms`,
        traceId,
        routingOverride: routing,
      });

      const processed = processInboundResult(
        result,
        dedupCache,
        messageSid,
        () => {
          if (rejectionLimiter.shouldSend(from)) {
            sendReplyBestEffort(
              from,
              ROUTING_REJECTION_NOTICE,
              "routing rejection",
            );
          }
        },
        tlog,
      );

      if (!processed.ok) {
        // Transient failure — return 500 so Twilio retries; the dedup cache
        // entry was unreserved by processInboundResult.
        return Response.json({ error: "Internal error" }, { status: 500 });
      }

      dedupCache.mark(messageSid);
      if (!processed.rejected && result.forwarded) {
        tlog.info(
          { status: "forwarded", messageSid },
          "SMS message forwarded to runtime",
        );
      }
      return twimlOk();
    } catch (err) {
      const cbResponse = handleCircuitBreakerError(
        err,
        dedupCache,
        messageSid,
        tlog,
      );
      if (cbResponse) return cbResponse;

      tlog.error({ err, messageSid }, "Failed to process inbound SMS message");
      dedupCache.unreserve(messageSid);
      return Response.json({ error: "Internal error" }, { status: 500 });
    }
  };

  return { handler, dedupCache };
}
