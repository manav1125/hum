/**
 * SMS outbound message orchestration.
 *
 * Sends replies via the Twilio Messages API
 * (POST /2010-04-01/Accounts/{sid}/Messages.json) using the same credential
 * resolution as the voice path (calls/twilio-config.ts): account SID and
 * phone number from config, auth token from the secure credential store.
 *
 * SMS is plain text only — no buttons, no rich formatting, no media in v1.
 * Approval prompts fall back to their plain-text form and are resolved by
 * the conversational approval engine when the user texts back.
 */

import type { ApprovalUIMetadata } from "@vellumai/gateway-client";
import { sendSmsMessage } from "@vellumai/twilio-client";

import { getTwilioConfig } from "../../../calls/twilio-config.js";
import { getLogger } from "../../../util/logger.js";

const log = getLogger("sms-send");

// Twilio Messages API accepts up to 1600 characters per message body.
const SMS_MAX_MESSAGE_LEN = 1600;

const SEND_TIMEOUT_MS = 15_000;

/**
 * Split text into chunks that respect the SMS body limit.
 * Tries to split on newlines first, then whitespace, then hard-cuts.
 */
function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx <= 0) splitIdx = remaining.lastIndexOf(" ", maxLen);
    if (splitIdx <= 0) splitIdx = maxLen;

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

async function sendSmsTextMessage(to: string, text: string): Promise<void> {
  const { accountSid, authToken, phoneNumber } = await getTwilioConfig();
  await sendSmsMessage({
    accountSid,
    authToken,
    timeoutMs: SEND_TIMEOUT_MS,
    to,
    from: phoneNumber,
    body: text,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function sendSmsReply(
  to: string,
  text: string,
  approval?: ApprovalUIMetadata,
): Promise<void> {
  let effectiveText = text;

  // SMS has no interactive buttons — deliver approvals as plain text. The
  // plainTextFallback already carries reply instructions the conversational
  // approval engine understands (e.g. reply "yes"/"no"); when the caller
  // supplied its own prompt text, append just the reply instructions.
  if (approval) {
    if (!effectiveText.trim()) {
      effectiveText =
        approval.plainTextFallback?.trim() ||
        'Approval required. Reply "yes" to approve or "no" to reject.';
    } else {
      effectiveText = `${effectiveText}\n\nReply "yes" to approve or "no" to reject.`;
    }
  }

  const chunks = splitText(effectiveText, SMS_MAX_MESSAGE_LEN);
  for (const chunk of chunks) {
    await sendSmsTextMessage(to, chunk);
  }

  log.debug(
    { to, chunks: chunks.length, hasApproval: !!approval },
    "SMS reply sent",
  );
}
