import type { GatewayInboundEvent } from "../types.js";

/**
 * Twilio incoming-SMS webhook normalization.
 *
 * Twilio delivers incoming messages as a form-encoded POST with (at least)
 * `From`, `To`, `Body`, `MessageSid`, and `NumMedia` fields:
 * https://www.twilio.com/docs/messaging/guides/webhook-request
 *
 * The params arrive pre-parsed from `validateTwilioWebhookRequest` (which
 * also verified the X-Twilio-Signature).
 */

export interface NormalizedSmsMessage {
  event: GatewayInboundEvent;
  /** Twilio Message SID — globally unique, used for dedup. */
  messageSid: string;
  /** Number of MMS media items attached (media is not ingested in v1). */
  numMedia: number;
}

/**
 * Normalize a validated Twilio incoming-SMS webhook payload into a
 * GatewayInboundEvent.
 *
 * Returns null when required fields (From, MessageSid) are missing or when
 * the message carries neither text nor media.
 *
 * MMS media (NumMedia > 0) is not downloaded in v1; a bracketed notice is
 * appended to the message content so the assistant knows media was omitted.
 */
export function normalizeTwilioSmsWebhook(
  params: Record<string, string>,
): NormalizedSmsMessage | null {
  const from = params.From?.trim();
  const messageSid = params.MessageSid?.trim();
  if (!from || !messageSid) return null;

  const body = params.Body?.trim() ?? "";
  const numMedia = Number.parseInt(params.NumMedia ?? "0", 10) || 0;

  if (body.length === 0 && numMedia === 0) return null;

  let content = body;
  if (numMedia > 0) {
    const mediaNotice = `[The user attached ${numMedia} media item(s) (MMS) that could not be retrieved — media over SMS is not supported yet. Ask them to re-send via another channel if the content is important.]`;
    content = content.length > 0 ? `${content}\n\n${mediaNotice}` : mediaNotice;
  }

  return {
    messageSid,
    numMedia,
    event: {
      version: "v1",
      sourceChannel: "sms",
      receivedAt: new Date().toISOString(),
      message: {
        content,
        // The sender's E.164 number is both the conversation address and
        // the actor identity for 1:1 SMS threads.
        conversationExternalId: from,
        externalMessageId: messageSid,
      },
      actor: {
        actorExternalId: from,
        displayName: from,
      },
      source: {
        updateId: messageSid,
        messageId: messageSid,
        chatType: "private",
      },
      raw: { ...params },
    },
  };
}
