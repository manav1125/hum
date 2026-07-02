/**
 * Direct channel delivery — bypasses the gateway HTTP proxy.
 *
 * Each channel that supports direct delivery registers its callback-URL
 * matcher and send logic here.  The gateway-client consults
 * `isDirectDelivery()` before falling back to the HTTP proxy path.
 *
 * Currently supported: WhatsApp, Telegram, Slack, A2A, SMS (Twilio).
 */

import type {
  ChannelDeliveryResult,
  ChannelReplyPayload,
} from "@vellumai/gateway-client";
import { ChannelDeliveryError } from "@vellumai/gateway-client/http-delivery";

import { getLogger } from "../../util/logger.js";
import { deliverA2AReply } from "./a2a/deliver.js";
import {
  sendSlackAssistantThreadStatus,
  sendSlackAttachments,
  sendSlackReaction,
  sendSlackReply,
  sendSlackTypingIndicator,
} from "./slack/send.js";
import {
  sendTelegramAttachments,
  sendTelegramReply,
  sendTelegramTypingIndicator,
} from "./telegram-bot/send.js";
import { sendSmsReply } from "./twilio-sms/send.js";
import { sendWhatsAppAttachments, sendWhatsAppReply } from "./whatsapp/send.js";

const log = getLogger("direct-delivery");

// ---------------------------------------------------------------------------
// Callback-URL matchers
// ---------------------------------------------------------------------------

function matchesPathname(callbackUrl: string, pathname: string): boolean {
  try {
    return new URL(callbackUrl).pathname === pathname;
  } catch {
    return callbackUrl.endsWith(pathname);
  }
}

function isWhatsAppCallback(callbackUrl: string): boolean {
  return matchesPathname(callbackUrl, "/deliver/whatsapp");
}

function isTelegramCallback(callbackUrl: string): boolean {
  return matchesPathname(callbackUrl, "/deliver/telegram");
}

function isSlackCallback(callbackUrl: string): boolean {
  try {
    return new URL(callbackUrl).pathname === "/deliver/slack";
  } catch {
    return callbackUrl.endsWith("/deliver/slack");
  }
}

function isA2ACallback(callbackUrl: string): boolean {
  return matchesPathname(callbackUrl, "/deliver/a2a");
}

function isSmsCallback(callbackUrl: string): boolean {
  return matchesPathname(callbackUrl, "/deliver/sms");
}

function parseSlackCallbackParams(callbackUrl: string): {
  channel?: string;
  threadTs?: string;
  messageTs?: string;
} {
  try {
    const url = new URL(callbackUrl);
    return {
      channel: url.searchParams.get("channel") ?? undefined,
      threadTs: url.searchParams.get("threadTs") ?? undefined,
      messageTs: url.searchParams.get("messageTs") ?? undefined,
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Per-channel direct delivery
// ---------------------------------------------------------------------------

async function deliverWhatsApp(
  payload: ChannelReplyPayload,
): Promise<ChannelDeliveryResult> {
  const { chatId, text, attachments, approval } = payload;

  if (text) {
    await sendWhatsAppReply(chatId, text, approval);
  } else if (approval) {
    await sendWhatsAppReply(
      chatId,
      approval.plainTextFallback || "Approval required",
      approval,
    );
  }

  if (attachments && attachments.length > 0) {
    const result = await sendWhatsAppAttachments(chatId, attachments);
    if (result.allFailed && !text) {
      throw new ChannelDeliveryError(
        502,
        `All ${result.failureCount} attachments failed to deliver`,
      );
    }
  }

  log.info({ chatId, hasText: !!text }, "WhatsApp reply delivered (direct)");
  return { ok: true };
}

async function deliverSms(
  payload: ChannelReplyPayload,
): Promise<ChannelDeliveryResult> {
  const { chatId, text, attachments, approval, chatAction } = payload;

  // SMS has no typing indicator — treat it as a successful no-op rather
  // than sending a spurious message.
  if (chatAction === "typing") {
    return { ok: true };
  }

  if (text) {
    await sendSmsReply(chatId, text, approval);
  } else if (approval) {
    await sendSmsReply(chatId, "", approval);
  }

  // Attachments cannot be delivered over SMS in v1 (MMS is future work).
  // Send a plain-text notice so the user knows content was withheld.
  if (attachments && attachments.length > 0) {
    const names = attachments
      .map((a) => a.filename ?? a.id)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    const notice =
      names.length > 0
        ? `${attachments.length} attachment(s) could not be delivered over SMS: ${names.join(", ")}. Ask for them on another channel.`
        : `${attachments.length} attachment(s) could not be delivered over SMS. Ask for them on another channel.`;
    try {
      await sendSmsReply(chatId, notice);
    } catch (err) {
      log.warn({ err, chatId }, "Failed to send SMS attachment notice");
    }
    if (!text && !approval) {
      throw new ChannelDeliveryError(
        502,
        `Attachments are not supported over SMS (${attachments.length} withheld)`,
      );
    }
  }

  log.info({ chatId, hasText: !!text }, "SMS reply delivered (direct)");
  return { ok: true };
}

async function deliverTelegram(
  payload: ChannelReplyPayload,
): Promise<ChannelDeliveryResult> {
  const { chatId, text, attachments, approval, chatAction } = payload;

  if (chatAction === "typing") {
    await sendTelegramTypingIndicator(chatId);
    log.debug({ chatId }, "Telegram typing indicator delivered (direct)");
    return { ok: true };
  }

  if (text) {
    await sendTelegramReply(chatId, text, approval);
  } else if (approval) {
    await sendTelegramReply(
      chatId,
      approval.plainTextFallback || "Approval required",
      approval,
    );
  }

  if (attachments && attachments.length > 0) {
    const result = await sendTelegramAttachments(chatId, attachments);
    if (result.allFailed && !text) {
      throw new ChannelDeliveryError(
        502,
        `All ${result.failureCount} attachments failed to deliver`,
      );
    }
  }

  log.info({ chatId, hasText: !!text }, "Telegram reply delivered (direct)");
  return { ok: true };
}

async function deliverSlack(
  callbackUrl: string,
  payload: ChannelReplyPayload,
): Promise<ChannelDeliveryResult> {
  const { chatId, text, attachments, chatAction, blocks } = payload;
  const params = parseSlackCallbackParams(callbackUrl);
  const threadTs = params.threadTs;

  // Emoji reaction
  if (payload.reaction) {
    await sendSlackReaction(
      chatId,
      payload.reaction.name,
      payload.reaction.messageTs,
      payload.reaction.action,
    );
    return { ok: true };
  }

  // Assistants API thread status
  if (payload.assistantThreadStatus) {
    const {
      channel,
      threadTs: statusThreadTs,
      status,
      loadingMessages,
    } = payload.assistantThreadStatus;
    await sendSlackAssistantThreadStatus(
      channel,
      statusThreadTs,
      status,
      loadingMessages,
    );
    return { ok: true };
  }

  // Typing indicator
  if (chatAction === "typing") {
    const placeholderTs = await sendSlackTypingIndicator(chatId, threadTs);
    log.debug({ chatId }, "Slack typing indicator delivered (direct)");
    return { ok: true, ts: placeholderTs };
  }

  // Text + blocks delivery
  let sentTs: string | undefined;
  if (text) {
    const result = await sendSlackReply(chatId, text, {
      threadTs,
      blocks: blocks as unknown[] | undefined,
      approval: payload.approval,
      useBlocks: payload.useBlocks,
      ephemeral: payload.ephemeral,
      user: payload.user,
      messageTs: payload.messageTs,
    });
    sentTs = result.ts;
  } else if (payload.approval) {
    const result = await sendSlackReply(
      chatId,
      payload.approval.plainTextFallback || "Approval required",
      {
        threadTs,
        approval: payload.approval,
      },
    );
    sentTs = result.ts;
  }

  // Attachments
  if (attachments && attachments.length > 0) {
    const result = await sendSlackAttachments(chatId, attachments, threadTs);
    if (result.allFailed && !text) {
      throw new ChannelDeliveryError(
        502,
        `All ${result.failureCount} attachments failed to deliver`,
      );
    }
  }

  log.info({ chatId, hasText: !!text }, "Slack reply delivered (direct)");
  return { ok: true, ts: sentTs };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true when the given callback URL targets a channel whose
 * outbound delivery is handled directly by the assistant (no gateway hop).
 */
export function isDirectDelivery(callbackUrl: string): boolean {
  return (
    isWhatsAppCallback(callbackUrl) ||
    isTelegramCallback(callbackUrl) ||
    isSlackCallback(callbackUrl) ||
    isA2ACallback(callbackUrl) ||
    isSmsCallback(callbackUrl)
  );
}

/**
 * Deliver a channel reply directly to the provider API, bypassing the
 * gateway HTTP proxy.  Callers MUST check `isDirectDelivery()` first.
 */
export async function deliverDirect(
  callbackUrl: string,
  payload: ChannelReplyPayload,
): Promise<ChannelDeliveryResult> {
  if (isWhatsAppCallback(callbackUrl)) {
    return deliverWhatsApp(payload);
  }
  if (isTelegramCallback(callbackUrl)) {
    return deliverTelegram(payload);
  }
  if (isSlackCallback(callbackUrl)) {
    return deliverSlack(callbackUrl, payload);
  }
  if (isA2ACallback(callbackUrl)) {
    return deliverA2AReply(callbackUrl, payload);
  }
  if (isSmsCallback(callbackUrl)) {
    return deliverSms(payload);
  }

  // Defensive — isDirectDelivery should have returned false.
  throw new Error(
    `deliverDirect called for unsupported callback: ${callbackUrl}`,
  );
}
