/**
 * Withdraw a Telegram approval card when its underlying guardian request
 * resolves.
 *
 * Telegram bots cannot re-read a delivered message, so an edit that strips
 * the buttons and appends a status line in one pass (the in-app card shape)
 * is not available here. The closest faithful projection is:
 *
 *   1. Remove the inline keyboard in place (`editMessageReplyMarkup`), which
 *      preserves the card's text for the audit trail while dropping every
 *      live affordance.
 *   2. Post the terminal outcome as a silent reply quoting the card, so the
 *      message thread durably shows what was decided. The reply is skipped
 *      only when the deciding flow already delivers its own guardian-facing
 *      outcome message in this chat, where a second notice would read as a
 *      duplicate.
 *
 * Bot API wrappers differ on the "remove markup" form, so the edit tries the
 * explicit `null` first and falls back to an empty inline keyboard. "message
 * is not modified" means the keyboard is already gone and is treated as
 * success. A failed edit never deletes the message: withdrawal must preserve
 * the audit trail, and a tap on a leftover button already gets the stale
 * "already resolved" handling.
 */

import { composeDecisionStatusLine } from "../../../runtime/channel-approval-types.js";
import { getLogger } from "../../../util/logger.js";
import { callTelegramBotApi } from "./api.js";

const log = getLogger("telegram-withdraw");

const STATUS_GLYPH: Record<string, string> = {
  approved: "✅",
  denied: "❌",
  expired: "⌛",
  cancelled: "\u{1f6ab}",
};

export interface WithdrawTelegramApprovalCardParams {
  /** Telegram chat the approval message lives in. */
  chatId: string;
  /** Channel-native id of the approval message to withdraw. */
  messageId: string;
  /** Terminal status of the request (e.g. "approved", "denied", "expired"). */
  status: string;
  /**
   * Pre-composed shared status line ("Approved · by you · 14:02" /
   * "Expired · never answered — nothing was sent"). Wording is composed once
   * by the withdrawal orchestrator via `composeDecisionStatusLine` so every
   * surface says the same thing; this module contributes only the Telegram
   * glyph. When absent (older callers), composed here from `status`.
   */
  statusLine?: string;
  /**
   * Whether to post the quoted status reply. False when the decision's own
   * flow already delivers a guardian-facing outcome message in this chat.
   */
  postStatusReply: boolean;
}

/** Build the plain-text outcome line for the quoted status reply. */
function buildStatusText(status: string, statusLine?: string): string {
  const glyph = STATUS_GLYPH[status] ?? "";
  const line = statusLine ?? composeDecisionStatusLine(status);
  return glyph ? `${glyph} ${line}` : line;
}

/** True for the Bot API's "message is not modified" no-op edit rejection. */
function isNoOpMarkupError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("message is not modified");
}

/**
 * Remove the card's inline keyboard in place, keeping its text. Tries the
 * explicit `reply_markup: null` form first, then an empty inline keyboard.
 * Returns true when the keyboard is gone (including the already-cleared
 * no-op case); false when both edit forms failed.
 */
async function clearInlineKeyboard(
  chatId: string,
  messageId: number,
): Promise<boolean> {
  const basePayload = { chat_id: chatId, message_id: messageId };
  try {
    await callTelegramBotApi("editMessageReplyMarkup", {
      ...basePayload,
      reply_markup: null,
    });
    return true;
  } catch (primaryErr) {
    if (isNoOpMarkupError(primaryErr)) {
      return true;
    }
    try {
      await callTelegramBotApi("editMessageReplyMarkup", {
        ...basePayload,
        reply_markup: { inline_keyboard: [] },
      });
      return true;
    } catch (fallbackErr) {
      if (isNoOpMarkupError(fallbackErr)) {
        return true;
      }
      log.warn(
        { primaryErr, fallbackErr, chatId, messageId },
        "Failed to clear inline keyboard on resolved Telegram approval card",
      );
      return false;
    }
  }
}

/**
 * Project a resolved guardian request onto its Telegram approval card:
 * drop the inline keyboard in place and (unless suppressed) post a silent
 * reply quoting the card with the terminal outcome.
 *
 * Both steps are attempted independently, so a failed keyboard edit does not
 * lose the durable outcome notice. Throws only if the status reply send
 * fails, which the caller treats as non-fatal.
 */
export async function withdrawTelegramApprovalCard(
  params: WithdrawTelegramApprovalCardParams,
): Promise<void> {
  const parsedMessageId = Number(params.messageId);
  if (!Number.isFinite(parsedMessageId)) {
    log.warn(
      { chatId: params.chatId, messageId: params.messageId },
      "Skipping Telegram card withdrawal due to invalid message id",
    );
    return;
  }

  await clearInlineKeyboard(params.chatId, parsedMessageId);

  if (!params.postStatusReply) {
    return;
  }

  // Silent (no push) reply quoting the card. `allow_sending_without_reply`
  // keeps the outcome notice deliverable even if the card was deleted.
  await callTelegramBotApi("sendMessage", {
    chat_id: params.chatId,
    text: buildStatusText(params.status, params.statusLine),
    reply_parameters: {
      message_id: parsedMessageId,
      allow_sending_without_reply: true,
    },
    disable_notification: true,
  });
}
