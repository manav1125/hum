/**
 * Bus consumer for `notification_intent` SSE events.
 *
 * Turns daemon-pushed notification intents into local browser or
 * Capacitor notifications. Skips guardian-scoped notifications
 * (the web client does not participate in guardian binding) and
 * notifications targeting the conversation the user is actively
 * viewing (verified by both store state and URL pathname, since
 * `activeConversationId` persists across route changes).
 *
 * Acks every notification back to the daemon so delivery audit
 * trails stay consistent with the macOS client.
 *
 * References:
 * - EVENT_BUS.md — bus subscription contract
 * - runtime/notifications.ts — notification scheduling and ack API
 */

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { decideAndRecordPush } from "@/mobile-v3/states/push-budget";
import {
  extractConversationId,
  postLocalNotification,
  sendNotificationIntentAck,
} from "@/runtime/notifications";
import { useConversationStore } from "@/stores/conversation-store";

/**
 * Subscribes to `notification_intent` SSE events via the event bus
 * and schedules local notifications.
 *
 * @param assistantId — current assistant; `null` disables the subscription
 */
export function useNotificationIntentSync(assistantId: string | null): void {
  useBusSubscription("sse.event", (envelope) => {
    const event = envelope.message;
    if (event.type !== "notification_intent") return;

    // Guardian-scoped notifications are for devices bound to that
    // guardian identity. The web/Capacitor client does not participate
    // in guardian binding — skip to avoid leaking to unintended devices.
    if (event.targetGuardianPrincipalId) {
      if (assistantId && event.deliveryId) {
        void sendNotificationIntentAck(assistantId, event.deliveryId, true);
      }
      return;
    }

    // Suppress the banner when the user is already viewing the target
    // conversation. `activeConversationId` is never cleared on navigation,
    // so we also verify the URL matches the conversation route — otherwise
    // a stale id would suppress notifications on home/settings/etc.
    const metadataConversationId = extractConversationId(
      event.deepLinkMetadata,
    );
    if (
      metadataConversationId &&
      metadataConversationId ===
        useConversationStore.getState().activeConversationId &&
      window.location.pathname.startsWith("/assistant/conversations/")
    ) {
      if (assistantId && event.deliveryId) {
        void sendNotificationIntentAck(assistantId, event.deliveryId, true);
      }
      return;
    }

    // v28 · K2 — the interruption budget. Corrections and time-critical
    // approvals are always delivered (design: "unless something breaks", and a
    // cap that could swallow an expiring approval would be worse than noise);
    // only the ambient tier is held for the brief. See
    // `mobile-v3/states/push-budget.ts` for what this does and does not cover —
    // remote APNs pushes are composed by the daemon and never reach this code.
    const decision = decideAndRecordPush({
      sourceEventName: event.sourceEventName,
      title: event.title,
      body: event.body,
    });
    if (!decision.deliver) {
      // Acked, not dropped: the daemon's delivery audit records that this
      // device saw it, and the item itself is untouched and still in the app.
      if (assistantId && event.deliveryId) {
        void sendNotificationIntentAck(assistantId, event.deliveryId, true);
      }
      return;
    }

    void postLocalNotification({
      title: event.title,
      body: event.body,
      sourceEventName: event.sourceEventName,
      deliveryId: event.deliveryId,
      deepLinkMetadata: event.deepLinkMetadata,
      assistantId: assistantId ?? undefined,
    });
  });
}
