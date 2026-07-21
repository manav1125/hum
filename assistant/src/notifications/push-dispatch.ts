/**
 * Mobile remote-push dispatch — mirrors two attention-critical hub events
 * to registered APNs devices so the user's phone is alerted even when the
 * app is suspended and no SSE connection is alive:
 *
 *   - `work_item_completed` (status `awaiting_review`) — background work
 *     finished and needs the user's review.
 *   - `confirmation_request` — a tool call is blocked on an approval.
 *
 * This is an observation-layer transport mirror (invoked fire-and-forget
 * from `broadcastMessage` in runtime/assistant-event-hub.ts, alongside the
 * canonical-guardian side effect), not a notification *producer* — the
 * events it mirrors are already user-facing pushes on the SSE stream, so
 * they intentionally do not re-enter `emitNotificationSignal()`'s decision
 * pipeline. Foreground clients keep rendering them from SSE; this module
 * only extends delivery to devices that cannot hold a connection open.
 *
 * Guarantees:
 *   - Never throws and never blocks the caller (all failures are logged).
 *   - No-op when APNs is unconfigured or no devices are registered.
 *   - Preference-gated: per-category toggles + quiet hours from
 *     `notifications.push` config are enforced at send time (push-prefs.ts);
 *     work-item completions ride the `reviewReady` category and approval
 *     requests ride `needsYou`. Suppressed sends are logged, not deferred.
 *   - Throttled: at most one push per work item per minute, one push per
 *     confirmation requestId ever, and one confirmation push per
 *     conversation per minute (an agent turn can emit several approvals
 *     back-to-back; the first push gets the user into the app).
 *   - Tokens APNs reports as invalid are pruned from the registry.
 */

import type { ServerMessage } from "../daemon/message-protocol.js";
import { getLogger } from "../util/logger.js";
import {
  type ApnsAlert,
  isApnsConfigured,
  sendApnsAlert,
} from "./apns-sender.js";
import { listPushDevices, removePushDevice } from "./push-device-store.js";
import { checkPushGate, type PushCategory } from "./push-prefs.js";

const log = getLogger("push-dispatch");

const THROTTLE_WINDOW_MS = 60_000;

/** Bound the in-memory throttle maps; entries beyond this are pruned oldest-first. */
const MAX_TRACKED_KEYS = 1_000;

// lastSentAt per throttle key ("wi:<workItemId>" / "conf-conv:<conversationId>").
const lastSentAt = new Map<string, number>();
// Confirmation requestIds already pushed (each approval prompts at most once).
const sentConfirmationRequestIds = new Set<string>();

function pruneTracking(): void {
  if (lastSentAt.size > MAX_TRACKED_KEYS) {
    const cutoff = Date.now() - THROTTLE_WINDOW_MS;
    for (const [key, at] of lastSentAt) {
      if (at < cutoff) lastSentAt.delete(key);
    }
  }
  if (sentConfirmationRequestIds.size > MAX_TRACKED_KEYS) {
    sentConfirmationRequestIds.clear();
  }
}

/** True when the key is inside its throttle window; records the send otherwise. */
function shouldThrottle(key: string, now: number): boolean {
  const last = lastSentAt.get(key);
  if (last !== undefined && now - last < THROTTLE_WINDOW_MS) return true;
  lastSentAt.set(key, now);
  pruneTracking();
  return false;
}

/**
 * Category/quiet-hours gate (notifications.push config). Checked before any
 * throttle state is recorded so a suppressed push does not consume the
 * item's one-shot/throttle budget. Suppressions are logged (event metadata
 * only — never notification content beyond the category).
 */
function passesPushPrefs(category: PushCategory, itemId: string): boolean {
  const gate = checkPushGate(category);
  if (gate.allowed) return true;
  log.info(
    { category, itemId, reason: gate.reason },
    "APNs push suppressed by push preferences",
  );
  return false;
}

/**
 * Fan an APNs alert out to every registered iOS device, pruning tokens
 * Apple reports invalid. Shared by the hub-event mirrors below and the
 * morning-brief push job (`morning-brief-push.ts`). Never throws.
 */
export async function sendAlertToAllDevices(alert: ApnsAlert): Promise<void> {
  const devices = listPushDevices("ios");
  if (devices.length === 0) return;

  const results = await Promise.all(
    devices.map(async (device) => ({
      device,
      result: await sendApnsAlert(device.token, alert),
    })),
  );

  let sent = 0;
  for (const { device, result } of results) {
    if (result.ok) {
      sent += 1;
      continue;
    }
    if (result.tokenInvalid) {
      removePushDevice(device.token);
      log.info(
        { deviceId: device.id, reason: result.reason },
        "Pruned invalid APNs device token",
      );
    } else {
      log.warn(
        { deviceId: device.id, reason: result.reason, status: result.status },
        "APNs push delivery failed",
      );
    }
  }
  if (sent > 0) {
    log.info(
      { sent, total: devices.length, title: alert.title },
      "APNs push sent",
    );
  }
}

/**
 * Mirror a hub event to APNs devices when it is one of the two push-worthy
 * types. Fire-and-forget safe: never throws, never blocks meaningfully.
 */
export async function dispatchPushForServerMessage(
  msg: ServerMessage,
): Promise<void> {
  try {
    if (msg.type === "work_item_completed") {
      // Only review-ready completions page the user; `done` items were
      // auto-completed and `failed` runs surface in-app.
      if (msg.status !== "awaiting_review") return;
      if (!isApnsConfigured()) return;
      if (!passesPushPrefs("reviewReady", msg.workItemId)) return;

      const now = Date.now();
      if (shouldThrottle(`wi:${msg.workItemId}`, now)) return;

      // Lazy import: keeps this module import-light for the hub's dynamic
      // load and avoids a static hub → work-items edge.
      const { getWorkItem } = await import("../work-items/work-item-store.js");
      const title = getWorkItem(msg.workItemId)?.title ?? "a background task";

      await sendAlertToAllDevices({
        title: "Cue finished a task",
        body: `Cue finished: ${title} — ready for your review`,
        collapseId: `wi-${msg.workItemId}`.slice(0, 64),
        threadId: "cue-work-items",
        data: {
          kind: "work_item_completed",
          workItemId: msg.workItemId,
          ...(msg.result.conversationId
            ? { conversationId: msg.result.conversationId }
            : {}),
        },
      });
      return;
    }

    if (msg.type === "confirmation_request") {
      if (!isApnsConfigured()) return;
      if (!passesPushPrefs("needsYou", msg.requestId)) return;

      if (sentConfirmationRequestIds.has(msg.requestId)) return;
      sentConfirmationRequestIds.add(msg.requestId);

      const now = Date.now();
      const conversationKey = `conf-conv:${msg.conversationId ?? "unknown"}`;
      if (shouldThrottle(conversationKey, now)) return;

      await sendAlertToAllDevices({
        title: "Cue needs your approval",
        body: `Cue needs a decision: ${msg.toolName}`,
        collapseId: `conf-${msg.requestId}`.slice(0, 64),
        threadId: "cue-approvals",
        data: {
          kind: "confirmation_request",
          requestId: msg.requestId,
          toolName: msg.toolName,
          ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
        },
      });
    }
  } catch (err) {
    log.warn({ err: String(err) }, "push dispatch failed");
  }
}
