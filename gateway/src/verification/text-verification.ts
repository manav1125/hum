/**
 * Gateway-owned text-channel verification intercept.
 *
 * Called from handleInbound before forwardToRuntime. When a message is a
 * bare verification code AND there is a pending/active session for this
 * channel, the gateway handles the entire flow:
 *
 *   1. Parse code from message content
 *   2. Check rate limits
 *   3. Hash + find matching session
 *   4. Verify identity binding (outbound sessions)
 *   5. Consume session (dual-write, atomic status guard)
 *   6. Apply side effects (guardian binding OR trusted contact upsert)
 *   7. Deliver deterministic reply
 *
 * The assistant NEVER sees verification code messages. Both success and
 * failure are short-circuited at the gateway.
 */

import { createGuardianBinding } from "../auth/guardian-bootstrap.js";
import { getLogger } from "../logger.js";

import {
  getExistingGuardianBinding,
  resolveCanonicalPrincipal,
  revokeExistingChannelGuardian,
} from "./binding-helpers.js";
import {
  extractEmailReplyBody,
  parseVerificationCode,
  hashVerificationSecret,
} from "./code-parsing.js";
import {
  findContactChannelByExternalUserId,
  upsertVerifiedContactChannel,
} from "./contact-helpers.js";
import { canonicalizeInboundIdentity } from "./identity.js";
import { checkIdentityMatch } from "./identity-match.js";
import {
  isRateLimited,
  recordInvalidAttempt,
  resetRateLimit,
} from "./rate-limit-helpers.js";
import {
  composeVerificationFailureReply,
  composeVerificationSuccessReply,
  deliverVerificationReply,
} from "./reply-delivery.js";
import {
  consumeSession,
  findSessionByHash,
  hasPendingOrActiveSession,
  retireSessionDisclosedInRoom,
} from "./session-helpers.js";

const log = getLogger("text-verification");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TextVerificationInterceptParams {
  sourceChannel: string;
  messageContent: string;
  actorExternalUserId: string;
  actorChatId: string;
  /**
   * Shape of the room the message arrived in, as reported by the channel's
   * normalizer: Slack `im` / `mpim` / `channel`, Telegram `private` / `group`
   * / `supergroup`, WhatsApp `private`. Absent on channels that have no rooms
   * (email), which is treated as one-to-one.
   */
  chatType?: string;
  actorDisplayName?: string;
  actorUsername?: string;
  replyCallbackUrl?: string;
  assistantId?: string;
}

export type TextVerificationResult =
  | { intercepted: false }
  | {
      intercepted: true;
      outcome: "verified" | "failed";
      trustClass: "guardian" | "trusted_contact";
      /** Reply text when replyCallbackUrl was unavailable (e.g. email channel). */
      pendingReplyText?: string;
    };

/**
 * Whether a normalized `chatType` describes a room that can hold people other
 * than the sender.
 *
 * An ALLOWLIST of one-to-one shapes, inverted — not a denylist of group
 * shapes. A channel that grows a new room type, or one whose normalizer stops
 * reporting a type, must read as multi-party rather than as a DM: the cost of
 * being wrong is a guardian binding handed to a room, against the cost of
 * telling one legitimate owner to try again in a DM.
 *
 * `undefined` is the one exception, and it means "this channel has no rooms"
 * (email). Channels that DO have rooms always report a type.
 *
 * Exported only so its tests assert THIS function rather than a re-declared
 * copy of it — a second copy would drift, and would drift silently in the
 * permissive direction.
 */
export function isMultiPartyRoom(chatType: string | undefined): boolean {
  if (chatType === undefined) return false;
  const ONE_TO_ONE = new Set(["im", "private", "direct"]);
  return !ONE_TO_ONE.has(chatType);
}

// ---------------------------------------------------------------------------
// Main intercept
// ---------------------------------------------------------------------------

export async function tryTextVerificationIntercept(
  params: TextVerificationInterceptParams,
): Promise<TextVerificationResult> {
  const {
    sourceChannel,
    messageContent,
    actorExternalUserId,
    actorChatId,
    chatType,
    actorDisplayName,
    actorUsername,
    replyCallbackUrl,
    assistantId,
  } = params;

  // 1. Parse — only bare 6-digit numeric or 64-char hex codes are intercepted.
  //    For email, strip quoted reply content first so the code isn't buried
  //    under signatures and quoted thread text.
  const effectiveContent =
    sourceChannel === "email"
      ? extractEmailReplyBody(messageContent)
      : messageContent;
  const code = parseVerificationCode(effectiveContent);
  if (code === undefined) {
    return { intercepted: false };
  }

  // 2. Fast guard — is there any pending session for this channel?
  const hasSessions = await hasPendingOrActiveSession(sourceChannel);
  if (!hasSessions) {
    return { intercepted: false };
  }

  const canonicalUserId =
    canonicalizeInboundIdentity(sourceChannel, actorExternalUserId) ??
    actorExternalUserId;

  // 3. Rate limit check
  if (isRateLimited(sourceChannel, canonicalUserId, actorChatId)) {
    log.info(
      { sourceChannel, actorExternalUserId: canonicalUserId },
      "Verification attempt rate-limited",
    );
    const pendingReplyText = await replyWithFailure(
      replyCallbackUrl,
      actorChatId,
      assistantId,
      "The verification code is invalid or has expired.",
    );
    return {
      intercepted: true,
      outcome: "failed",
      trustClass: "guardian",
      pendingReplyText,
    };
  }

  // 4. Hash + find session
  const challengeHash = hashVerificationSecret(code);
  const session = await findSessionByHash(sourceChannel, challengeHash);

  if (!session) {
    await recordInvalidAttempt(sourceChannel, canonicalUserId, actorChatId);
    log.info(
      { sourceChannel, actorExternalUserId: canonicalUserId },
      "Verification code did not match any pending session",
    );
    const pendingReplyText = await replyWithFailure(
      replyCallbackUrl,
      actorChatId,
      assistantId,
      "The verification code is invalid or has expired.",
    );
    return {
      intercepted: true,
      outcome: "failed",
      trustClass: "guardian",
      pendingReplyText,
    };
  }

  // 4b. Lane guard — a code pasted into a room with other people in it.
  //
  // Redeeming here would bind the assistant to a shared room and, for a
  // guardian session, hand guardianship to whoever pasted it. But the more
  // pressing problem is that the code has now been shown to everyone
  // present, so it must not merely be refused — it must be retired, or any
  // observer can carry it to a DM and redeem it there themselves.
  //
  // The reply deliberately does not say a valid code was seen: that would
  // tell a room full of people that the string someone just pasted is live.
  // It reads as an ordinary failure, matching the anti-oracle handling of
  // an identity mismatch below.
  if (isMultiPartyRoom(chatType)) {
    await retireSessionDisclosedInRoom(session.id);
    log.warn(
      { sourceChannel, sessionId: session.id, chatType },
      "Verification code was pasted into a multi-party room; session retired without binding",
    );
    const pendingReplyText = await replyWithFailure(
      replyCallbackUrl,
      actorChatId,
      assistantId,
      "The verification code is invalid or has expired.",
    );
    return {
      intercepted: true,
      outcome: "failed",
      trustClass: "guardian",
      pendingReplyText,
    };
  }

  // 5. Identity binding check (outbound sessions)
  if (!checkIdentityMatch(session, canonicalUserId, actorChatId)) {
    await recordInvalidAttempt(sourceChannel, canonicalUserId, actorChatId);
    log.info(
      { sourceChannel, sessionId: session.id },
      "Verification identity mismatch (anti-oracle: same error as invalid code)",
    );
    const pendingReplyText = await replyWithFailure(
      replyCallbackUrl,
      actorChatId,
      assistantId,
      "The verification code is invalid or has expired.",
    );
    return {
      intercepted: true,
      outcome: "failed",
      trustClass:
        session.verificationPurpose === "trusted_contact"
          ? "trusted_contact"
          : "guardian",
      pendingReplyText,
    };
  }

  // 6. Consume session (atomic — only the first consumer wins)
  const consumed = await consumeSession(
    session.id,
    canonicalUserId,
    actorChatId,
  );
  if (!consumed) {
    log.warn(
      { sessionId: session.id },
      "Session already consumed by concurrent request",
    );
    const pendingReplyText = await replyWithFailure(
      replyCallbackUrl,
      actorChatId,
      assistantId,
      "The verification code is invalid or has expired.",
    );
    return {
      intercepted: true,
      outcome: "failed",
      trustClass:
        session.verificationPurpose === "trusted_contact"
          ? "trusted_contact"
          : "guardian",
      pendingReplyText,
    };
  }

  // Reset rate limits on success
  await resetRateLimit(sourceChannel, canonicalUserId, actorChatId);

  const trustClass: "guardian" | "trusted_contact" =
    session.verificationPurpose === "trusted_contact"
      ? "trusted_contact"
      : "guardian";

  // 7. Apply side effects
  if (trustClass === "guardian") {
    await applyGuardianSideEffects({
      sourceChannel,
      canonicalUserId,
      actorChatId,
      actorDisplayName,
      actorUsername,
    });
  } else {
    await applyTrustedContactSideEffects({
      sourceChannel,
      canonicalUserId,
      actorChatId,
      actorDisplayName,
      actorUsername,
    });
  }

  // 8. Deliver success reply
  const successReplyText = composeVerificationSuccessReply(trustClass);
  let pendingReplyText: string | undefined;
  if (replyCallbackUrl) {
    await deliverVerificationReply({
      replyCallbackUrl,
      chatId: actorChatId,
      text: successReplyText,
      assistantId,
    });
  } else {
    pendingReplyText = successReplyText;
  }

  log.info(
    {
      sourceChannel,
      actorExternalUserId: canonicalUserId,
      trustClass,
      sessionId: session.id,
    },
    "Text verification succeeded",
  );

  return {
    intercepted: true,
    outcome: "verified",
    trustClass,
    pendingReplyText,
  };
}

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

async function applyGuardianSideEffects(params: {
  sourceChannel: string;
  canonicalUserId: string;
  actorChatId: string;
  actorDisplayName?: string;
  actorUsername?: string;
}): Promise<void> {
  const {
    sourceChannel,
    canonicalUserId,
    actorChatId,
    actorDisplayName,
    actorUsername,
  } = params;

  // Check for binding conflict — another user already holds guardian
  const existing = await getExistingGuardianBinding(sourceChannel);
  if (existing?.externalUserId && existing.externalUserId !== canonicalUserId) {
    log.warn(
      {
        sourceChannel,
        existingGuardian: existing.externalUserId,
        newActor: canonicalUserId,
      },
      "Guardian binding conflict: another user already holds this channel",
    );
    // Still upsert the contact channel so the sender is a known contact,
    // but skip guardian binding creation.
    await upsertVerifiedContactChannel({
      sourceChannel,
      externalUserId: canonicalUserId,
      externalChatId: actorChatId,
      displayName: actorDisplayName,
      username: actorUsername,
    });
    return;
  }

  // Revoke existing binding (same-user re-verification)
  await revokeExistingChannelGuardian(sourceChannel);

  // Resolve canonical principal — unify all channel bindings
  const canonicalPrincipal = await resolveCanonicalPrincipal(canonicalUserId);

  // Determine display name — preserve existing if user is re-verifying
  const existingContact = await findContactChannelByExternalUserId(
    sourceChannel,
    canonicalUserId,
  );
  const displayName = existingContact?.displayName?.trim().length
    ? existingContact.displayName
    : (actorDisplayName ?? actorUsername ?? canonicalUserId);

  // Create guardian binding (dual-writes to both DBs)
  await createGuardianBinding({
    channel: sourceChannel,
    externalUserId: canonicalUserId,
    deliveryChatId: actorChatId,
    guardianPrincipalId: canonicalPrincipal,
    displayName,
    verifiedVia: "challenge",
  });
}

async function applyTrustedContactSideEffects(params: {
  sourceChannel: string;
  canonicalUserId: string;
  actorChatId: string;
  actorDisplayName?: string;
  actorUsername?: string;
}): Promise<void> {
  const {
    sourceChannel,
    canonicalUserId,
    actorChatId,
    actorDisplayName,
    actorUsername,
  } = params;

  // Preserve existing display name if available
  const existingContact = await findContactChannelByExternalUserId(
    sourceChannel,
    canonicalUserId,
  );
  const displayName = existingContact?.displayName?.trim().length
    ? existingContact.displayName
    : (actorDisplayName ?? actorUsername ?? canonicalUserId);

  await upsertVerifiedContactChannel({
    sourceChannel,
    externalUserId: canonicalUserId,
    externalChatId: actorChatId,
    displayName,
    username: actorUsername,
  });
}

// ---------------------------------------------------------------------------
// Reply helpers
// ---------------------------------------------------------------------------

async function replyWithFailure(
  replyCallbackUrl: string | undefined,
  chatId: string,
  assistantId: string | undefined,
  reason: string,
): Promise<string | undefined> {
  const text = composeVerificationFailureReply(reason);
  if (!replyCallbackUrl) return text;
  await deliverVerificationReply({
    replyCallbackUrl,
    chatId,
    text,
    assistantId,
  });
  return undefined;
}
