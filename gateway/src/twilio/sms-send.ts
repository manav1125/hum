import { sendSmsMessage } from "@vellumai/twilio-client";

import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";
import { splitText } from "../util/split-text.js";

const log = getLogger("twilio-sms-send");

// Twilio Messages API accepts up to 1600 characters per message body.
const SMS_MAX_MESSAGE_LEN = 1600;

const SEND_TIMEOUT_MS = 15_000;

export type SmsSendCaches = {
  credentials: CredentialCache;
  configFile: ConfigFileCache;
};

type ResolvedSmsSendConfig = {
  accountSid: string;
  authToken: string;
  fromNumber: string;
};

/**
 * Resolve Twilio credentials + the assistant's own phone number using the
 * same chain as `webhook-sync.ts`: account SID from the credential vault
 * with a config-file fallback, auth token from the credential vault, and
 * the From number from `twilio.phoneNumber` in the config file.
 */
async function resolveSmsSendConfig(
  caches: SmsSendCaches,
): Promise<ResolvedSmsSendConfig | null> {
  const fromNumber = caches.configFile
    .getString("twilio", "phoneNumber")
    ?.trim();
  const accountSidFromCredentials = (
    await caches.credentials.get(credentialKey("twilio", "account_sid"))
  )?.trim();
  const accountSid =
    accountSidFromCredentials ||
    caches.configFile.getString("twilio", "accountSid")?.trim();
  const authToken = (
    await caches.credentials.get(credentialKey("twilio", "auth_token"))
  )?.trim();

  if (!fromNumber || !accountSid || !authToken) {
    log.warn(
      {
        hasFromNumber: !!fromNumber,
        hasAccountSid: !!accountSid,
        hasAuthToken: !!authToken,
      },
      "Cannot send SMS — Twilio configuration is incomplete",
    );
    return null;
  }

  return { accountSid, authToken, fromNumber };
}

/**
 * Send an outbound SMS reply via the Twilio Messages API, splitting text
 * into 1600-character bodies. Throws when Twilio configuration is missing
 * or the API rejects the send.
 */
export async function sendSmsReply(
  to: string,
  text: string,
  caches: SmsSendCaches,
): Promise<void> {
  const resolved = await resolveSmsSendConfig(caches);
  if (!resolved) {
    throw new Error("Twilio SMS is not configured");
  }

  const chunks = splitText(text, SMS_MAX_MESSAGE_LEN);
  for (const chunk of chunks) {
    await sendSmsMessage({
      accountSid: resolved.accountSid,
      authToken: resolved.authToken,
      fetchImpl,
      timeoutMs: SEND_TIMEOUT_MS,
      to,
      from: resolved.fromNumber,
      body: chunk,
    });
  }

  log.debug({ to, chunks: chunks.length }, "SMS reply sent");
}
