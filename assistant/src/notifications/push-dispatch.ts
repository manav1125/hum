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
 *   - Budgeted: design's three-a-day ceiling and its three tiers
 *     (`push-budget.ts`) are enforced here, because this is the only layer
 *     that can see a remote push. Every send below — and the morning brief's,
 *     which routes through `sendBudgetedAlert` too — is decided and recorded
 *     before it leaves. Corrections and time-critical approvals are counted
 *     but never capped.
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
import {
  decidePush,
  type PushDecision,
  type PushIntent,
  tierFor,
} from "./push-budget.js";
import { readPushLedger, recordPushDecision } from "./push-budget-store.js";
import { listPushDevices, removePushDevice } from "./push-device-store.js";
import { type PushCategory, resolvePushGateInputs } from "./push-prefs.js";

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

/** True when the key is inside its throttle window. Records nothing. */
function isThrottled(key: string, now: number): boolean {
  const last = lastSentAt.get(key);
  return last !== undefined && now - last < THROTTLE_WINDOW_MS;
}

/** Mark the key as just sent. Called only when a push actually goes out. */
function recordThrottle(key: string, now: number): void {
  lastSentAt.set(key, now);
  pruneTracking();
}

/**
 * Decide, record and (if allowed) send. The single call every remote push in
 * this daemon makes — the work-item and approval mirrors below, and the
 * morning brief in `morning-brief-push.ts`.
 *
 * The order matters and is load-bearing:
 *
 *   1. The budget decision runs BEFORE any throttle or one-shot state is
 *      recorded, so a push held back by a preference, by quiet hours or by the
 *      ceiling does not burn the item's one chance to page later.
 *   2. The ledger row is written BEFORE the alert leaves, because a
 *      notification that fires and is not counted is how a ceiling of three
 *      becomes a floor of three.
 *   3. A suppressed push is still written to the ledger — with its tier and
 *      its reason. Suppression mutes a phone; the work item, the approval and
 *      the brief it mirrors are already persisted and already on the SSE
 *      stream, so nothing is lost by not ringing.
 *
 * Logs carry event metadata only — never a token, an address or a body.
 */
export async function sendBudgetedAlert(opts: {
  intent: PushIntent;
  category: PushCategory;
  /** Throttle/collapse key, e.g. `wi:<id>`. Never message content. */
  subjectKey: string;
  alert: ApnsAlert;
}): Promise<PushDecision> {
  const now = new Date();

  // Nothing to page: settle it before the budget is consulted, so a
  // deployment with no phone attached cannot fill the ledger with deliveries
  // that never left the building. A count of what Cue sent has to be a count
  // of what Cue sent.
  if (listPushDevices("ios").length === 0) {
    return {
      tier: tierFor(opts.intent),
      deliver: false,
      breaksQuietHours: false,
      reason: "No device is registered for push.",
      suppressedBecause: "no_devices",
      countToday: readPushLedger(now).delivered,
    };
  }

  const { categoryEnabled, quietNow } = resolvePushGateInputs(
    opts.category,
    now,
  );
  const ledger = readPushLedger(now);
  const decision = decidePush(opts.intent, ledger, {
    quietNow,
    categoryEnabled,
  });

  if (!decision.deliver) {
    recordPushDecision({
      dayKey: ledger.dayKey,
      decision,
      sourceEventName: opts.intent.sourceEventName,
      subjectKey: opts.subjectKey,
      now,
    });
    log.info(
      {
        category: opts.category,
        subjectKey: opts.subjectKey,
        tier: decision.tier,
        suppressedBecause: decision.suppressedBecause,
        deliveredToday: ledger.delivered,
      },
      "APNs push suppressed",
    );
    return decision;
  }

  recordPushDecision({
    dayKey: ledger.dayKey,
    decision,
    sourceEventName: opts.intent.sourceEventName,
    subjectKey: opts.subjectKey,
    now,
  });
  await sendAlertToAllDevices(opts.alert);
  return decision;
}

/**
 * Raw transport: fan an APNs alert out to every registered iOS device,
 * pruning tokens Apple reports invalid. Never throws.
 *
 * Not the entry point. Production senders go through `sendBudgetedAlert`
 * above, which is what applies design's tiers and the daily ceiling; a call
 * that reaches this function directly is a push nobody counted. Exported for
 * `sendBudgetedAlert` and for the delivery tests, and guarded by
 * `__tests__/push-budget-chokepoint.test.ts`.
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

      const now = Date.now();
      const throttleKey = `wi:${msg.workItemId}`;
      // Peeked, not recorded: a duplicate is dropped here without reaching the
      // budget, so repeats never inflate the day's suppressed count either.
      if (isThrottled(throttleKey, now)) return;

      // Lazy import: keeps this module import-light for the hub's dynamic
      // load and avoids a static hub → work-items edge.
      const { getWorkItem } = await import("../work-items/work-item-store.js");
      const title = getWorkItem(msg.workItemId)?.title ?? "a background task";

      const decision = await sendBudgetedAlert({
        // A completion, which design groups with the brief rather than with
        // the approval that has a clock on it — so it is ambient, and capped.
        intent: { sourceEventName: "work_item_completed" },
        category: "reviewReady",
        subjectKey: throttleKey,
        alert: {
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
        },
      });
      if (decision.deliver) recordThrottle(throttleKey, now);
      return;
    }

    if (msg.type === "confirmation_request") {
      if (!isApnsConfigured()) return;

      if (sentConfirmationRequestIds.has(msg.requestId)) return;

      const now = Date.now();
      const conversationKey = `conf-conv:${msg.conversationId ?? "unknown"}`;
      if (isThrottled(conversationKey, now)) return;

      const decision = await sendBudgetedAlert({
        // A tool call is blocked on this answer: design's tier 2. Counted
        // against the day, never capped by it.
        intent: { sourceEventName: "confirmation_request" },
        category: "needsYou",
        subjectKey: `conf:${msg.requestId}`,
        alert: {
          title: "Cue needs your approval",
          body: `Cue needs a decision: ${msg.toolName}`,
          collapseId: `conf-${msg.requestId}`.slice(0, 64),
          threadId: "cue-approvals",
          data: {
            kind: "confirmation_request",
            requestId: msg.requestId,
            toolName: msg.toolName,
            ...(msg.conversationId
              ? { conversationId: msg.conversationId }
              : {}),
          },
        },
      });
      if (decision.deliver) {
        // The one-shot and the throttle are spent only by a push that
        // actually went out, so a suppressed approval can still page once the
        // preference, the quiet window or the day changes.
        sentConfirmationRequestIds.add(msg.requestId);
        recordThrottle(conversationKey, now);
      }
    }
  } catch (err) {
    log.warn({ err: String(err) }, "push dispatch failed");
  }
}
