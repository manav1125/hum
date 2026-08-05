/**
 * Cross-surface withdrawal of guardian approval cards.
 *
 * A single guardian request is projected onto every surface it was delivered
 * to — the in-app card in the guardian's conversation, a Telegram message
 * with inline approve/reject buttons, etc. When the request reaches a
 * terminal status its cards must stop offering live actions on *all*
 * surfaces, not just the one the guardian acted on. This is the withdrawal
 * counterpart to the card *rendering* path
 * (`notifications/access-request-copy.ts` for in-app, the notification
 * adapters for channels): rendering projects `pending` onto each surface,
 * withdrawal projects the terminal status back onto each surface.
 *
 * Withdrawal preserves the card's information and removes only the live
 * affordances (it does not delete the message/card) so each surface keeps an
 * audit trail of what was decided.
 *
 * It is driven off `canonical_guardian_deliveries` — the per-request registry
 * of where each card was sent — so it stays correct as surfaces are added and
 * is agnostic to which surface originated the decision.
 *
 * Best-effort by contract: the request is already resolved (CAS committed)
 * before this runs, so a failed edit must never surface as a decision
 * failure. Every surface is attempted independently; one failure never blocks
 * the rest.
 */

import { markSurfaceCompleted } from "../daemon/conversation-surfaces.js";
import {
  type CanonicalRequestStatus,
  listCanonicalGuardianDeliveries,
} from "../memory/canonical-guardian-store.js";
import { withdrawTelegramApprovalCard } from "../messaging/providers/telegram-bot/withdraw.js";
import { approvalCardSurfaceId } from "../notifications/access-request-copy.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import {
  composeDecisionStatusLine,
  resolveDecisionStatusTimeZone,
} from "../runtime/channel-approval-types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("guardian-card-withdrawal");

/** The request fields withdrawal reads — structural subset of the store row. */
export interface WithdrawableGuardianRequest {
  id: string;
  kind: string;
}

/** The delivery fields withdrawal reads — structural subset of the store row. */
interface WithdrawableDelivery {
  destinationChannel: string;
  destinationConversationId: string | null;
  destinationChatId: string | null;
  destinationMessageId: string | null;
}

export interface WithdrawGuardianCardsParams {
  /** The request, already transitioned to its terminal status. */
  request: WithdrawableGuardianRequest;
  /** Terminal status to reflect on each card. */
  status: Exclude<CanonicalRequestStatus, "pending">;
  /**
   * Channel the decision originated on, when applicable.
   *
   * Only the in-app card's `ui_surface_complete` broadcast is origin-sensitive:
   * an in-app decision is already on screen with the resolver's own reply text,
   * so re-broadcasting the canonical status label would overwrite it
   * mid-session. The persisted completion is written regardless of origin.
   * Omit (e.g. the expiry sweep) to broadcast on every surface.
   */
  originChannel?: string;
  /**
   * True when the deciding flow delivers the resolver's own guardian-facing
   * reply on the origin channel (the resolver returned `guardianReplyText`).
   * Telegram's quoted status reply is suppressed only when the origin chat is
   * Telegram AND that richer reply is coming; most resolvers (tool grants,
   * tool approvals, questions) reply to the requester, not the guardian, so
   * without this flag the withdrawal's status reply is the only durable
   * outcome the guardian's chat gets.
   */
  hasOriginGuardianReply?: boolean;
}

/**
 * Withdraw a resolved request's approval cards across all delivery surfaces.
 * Never throws.
 */
export async function withdrawGuardianRequestCards(
  params: WithdrawGuardianCardsParams,
): Promise<void> {
  const { request, status, originChannel, hasOriginGuardianReply } = params;

  let deliveries: WithdrawableDelivery[];
  try {
    deliveries = listCanonicalGuardianDeliveries(request.id);
  } catch (err) {
    log.warn(
      { err, requestId: request.id },
      "Failed to list deliveries for card withdrawal",
    );
    return;
  }

  // One composed status line shared by every surface (design ruling 5):
  // "Approved · by you · 14:02" / "Denied · by you · 14:02" /
  // "Expired · never answered — nothing was sent". Surfaces add only their
  // own glyphs. Withdrawal runs immediately after the CAS resolution, so
  // `Date.now()` is the decision instant.
  const statusLine = composeDecisionStatusLine(status, {
    decidedAtMs: Date.now(),
    timeZone: resolveDecisionStatusTimeZone(),
  });

  for (const delivery of deliveries) {
    try {
      if (delivery.destinationChannel === "vellum") {
        withdrawVellumCard(request, delivery, statusLine, originChannel);
      } else if (delivery.destinationChannel === "telegram") {
        await withdrawTelegramCard(
          delivery,
          status,
          statusLine,
          originChannel,
          hasOriginGuardianReply ?? false,
        );
      }
      // Slack approval prompts are edited in place by the Slack callback
      // path when the decision originates there; a cross-surface Slack
      // withdrawal needs a slack withdraw module before it can be wired
      // here. WhatsApp direct delivery can't edit a message in place (it
      // would post a new one), so its stale clicks are left to the existing
      // "already resolved" reply.
    } catch (err) {
      log.warn(
        {
          err,
          requestId: request.id,
          channel: delivery.destinationChannel,
        },
        "Failed to withdraw guardian card on surface (non-fatal)",
      );
    }
  }
}

/**
 * Withdraw the in-app approval card so it stops offering live actions while
 * keeping its content.
 *
 * The completion is always persisted onto the card's `ui_surface` block. The
 * acting client's optimistic completion is in-memory only, so without this
 * write the conversation's history still carries an undecided card and
 * re-entering the conversation re-renders the raw button group.
 *
 * The `ui_surface_complete` broadcast is the only origin-sensitive half: when
 * the decision came from in-app, the acting client is already showing the
 * resolver's guardian-facing reply, and broadcasting the canonical status
 * label back would replace that richer summary mid-session.
 */
function withdrawVellumCard(
  request: WithdrawableGuardianRequest,
  delivery: WithdrawableDelivery,
  statusLine: string,
  originChannel: string | undefined,
): void {
  if (!delivery.destinationConversationId) {
    return;
  }
  const surfaceId = approvalCardSurfaceId(request.kind, request.id);
  if (!surfaceId) {
    return;
  }
  const summary = statusLine;
  markSurfaceCompleted(
    { conversationId: delivery.destinationConversationId },
    surfaceId,
    summary,
  );
  if (originChannel === "vellum") {
    return;
  }
  broadcastMessage({
    type: "ui_surface_complete",
    conversationId: delivery.destinationConversationId,
    surfaceId,
    summary,
  });
}

/**
 * Withdraw the Telegram approval card: remove its inline keyboard in place
 * and post a silent reply quoting the card with the terminal outcome.
 * Telegram bots cannot re-read a message, so the outcome rides a quoted
 * reply rather than an in-message edit; the card's own text is left
 * untouched for the audit trail.
 *
 * The status reply is suppressed only when the decision was made on Telegram
 * AND its flow delivers the resolver's own guardian-facing reply there
 * (`hasOriginGuardianReply`), where a second notice would read as a
 * duplicate. Most resolvers reply to the requester, not the guardian, so a
 * Telegram-origin decision usually still needs this reply as its durable
 * outcome. No-ops when the channel-native message id was not captured at
 * delivery time.
 */
async function withdrawTelegramCard(
  delivery: WithdrawableDelivery,
  status: CanonicalRequestStatus,
  statusLine: string,
  originChannel: string | undefined,
  hasOriginGuardianReply: boolean,
): Promise<void> {
  if (!delivery.destinationChatId || !delivery.destinationMessageId) {
    return;
  }
  await withdrawTelegramApprovalCard({
    chatId: delivery.destinationChatId,
    messageId: delivery.destinationMessageId,
    status,
    statusLine,
    postStatusReply: !(originChannel === "telegram" && hasOriginGuardianReply),
  });
}
