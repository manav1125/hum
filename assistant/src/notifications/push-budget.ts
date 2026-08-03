/**
 * K2 · Push — the interruption budget, daemon side.
 *
 * Design's v28 push spec (docs/design/handoff-2026-08-03-mobile/BRIEF-FOR-CODE.md
 * §5) drew three notifications on a lock screen and stated the rule under them:
 * "a correction that breaks quiet hours · one time-critical approval with Send
 * it inline · the 7:30 brief. THREE A DAY IS THE CEILING unless something
 * breaks."
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE CLIENT'S
 * -------------------------------------------------
 * The web client has the same decision in `apps/web/src/mobile-v3/states/
 * push-budget.ts`, where it gates *local* notifications fired from an SSE
 * event. That layer cannot see remote push: APNs alerts are composed and sent
 * from this process straight to a registered device token, and never enter the
 * web client at all. A backgrounded phone therefore only ever meets the
 * ceiling if the ceiling is enforced here.
 *
 * The two layers agree by test, not by hope:
 * `__tests__/push-budget-client-parity.test.ts` reads the client module and
 * asserts the ceiling, the tier names and both event lists are identical. Move
 * one and that test goes red.
 *
 * One deliberate divergence, pinned by the same test: the client currently
 * lets `time_critical` break quiet hours too. Design §5 grants that only to the
 * correction tier, so that is what this module does. Quiet hours are the
 * user's; a deadline of ours is not reason enough to take them.
 *
 * THE CAP MAY NOT HIDE AN EMERGENCY
 * ---------------------------------
 * "Unless something breaks" is the exemption that keeps this from being a
 * fail-closed filter. Corrections — Cue reporting its own error — and
 * time-critical approvals are never capped. They are counted, so the ledger
 * stays honest, but they are always delivered. Only the ambient tier (the
 * brief, completions, digests) is ever held back.
 *
 * A SUPPRESSED PUSH IS ACKNOWLEDGED, NOT DROPPED
 * ----------------------------------------------
 * Every decision this module makes is written to `push_budget_ledger`
 * (`push-budget-store.ts`) with its tier and its reason, delivered or not — so
 * "how noisy was I today" is answerable from real rows rather than a guess.
 * And every push this gates is a *mirror*: the work item, the approval and the
 * brief are already persisted and already on the SSE stream before the alert
 * is composed. Suppression mutes a phone; it never loses an item.
 */

/** Design's ceiling. Shared with the client — see the parity test. */
export const PUSH_DAILY_CEILING = 3;

/**
 * The three tiers, in the order design drew them.
 *
 *  · `correction`    — Cue reporting its own error. The one thing that always
 *                      gets through, quiet hours included.
 *  · `time_critical` — a decision with a deadline attached. Never capped;
 *                      still respects quiet hours.
 *  · `ambient`       — the 07:30 brief, completions, everything like them.
 *                      Capped.
 */
export type PushTier = "correction" | "time_critical" | "ambient";

/**
 * Event names that are Cue admitting a mistake. Kept byte-identical to the
 * client's list so an intent named on either side tiers the same way.
 */
export const CORRECTION_EVENTS = [
  "assistant.correction",
  "work_item.reversed",
  "arrival.unfiled",
  "run.failed",
] as const;

/** Event names that carry a decision with a clock on it. Client-identical. */
export const TIME_CRITICAL_EVENTS = [
  "guardian_action.requested",
  "work_item.needs_review",
  "approval.requested",
  "budget.hard_stop",
] as const;

/**
 * Daemon-native hub event names, which are not in the client's SSE vocabulary,
 * mapped onto the same three tiers.
 *
 * `work_item_completed` is ambient on purpose: it is a completion ("Cue
 * finished a task — ready for your review"), and design lists completions with
 * the brief, not with the approval that has a clock on it. It is also the bulk
 * of what production actually sends, so tiering it time-critical would have
 * made the ceiling decorative.
 */
export const DAEMON_SOURCE_TIERS: Readonly<Record<string, PushTier>> = {
  confirmation_request: "time_critical",
  work_item_completed: "ambient",
  "brief.morning_ready": "ambient",
};

export interface PushIntent {
  /** The event this push mirrors, e.g. `work_item_completed`. */
  sourceEventName: string;
  /** Present when the intent is an approval that can be answered inline. */
  approval?: { actionLabel: string; deadlineAt?: number | null };
  /** Cue correcting itself. Overrides everything below it. */
  isSelfCorrection?: boolean;
}

export function tierFor(intent: PushIntent): PushTier {
  if (intent.isSelfCorrection) return "correction";
  const name = intent.sourceEventName;
  if ((CORRECTION_EVENTS as readonly string[]).includes(name))
    return "correction";
  const native = DAEMON_SOURCE_TIERS[name];
  if (native === "correction") return "correction";
  if (intent.approval) return "time_critical";
  if ((TIME_CRITICAL_EVENTS as readonly string[]).includes(name))
    return "time_critical";
  if (native) return native;
  return "ambient";
}

/** The day so far, as counted from the ledger. */
export interface PushLedger {
  /** Local calendar day, `YYYY-MM-DD`, in the effective push timezone. */
  dayKey: string;
  delivered: number;
  /** Held back. Counted so "how noisy was I" stays answerable, honestly. */
  suppressed: number;
  /**
   * True when the counts could not be read (a DB failure). Ambient pushes are
   * held back in that case: an unknown count must not be spent as if it were
   * zero. Tiers 1 and 2 do not consult the count at all, so an outage can
   * never silence a correction or an approval.
   */
  unavailable?: boolean;
}

export type PushSuppressionReason =
  | "category_disabled"
  | "quiet_hours"
  | "daily_ceiling"
  | "ledger_unavailable"
  /**
   * No device is registered. Not a budget judgement — a transport fact, raised
   * by the sender before it consults the budget at all, so that a deployment
   * with no phone attached does not accumulate a ledger full of deliveries
   * that never happened.
   */
  | "no_devices";

export interface PushDecision {
  tier: PushTier;
  deliver: boolean;
  /** Delivered inside the quiet window because the tier earns it. */
  breaksQuietHours: boolean;
  /** Why, in one line. Recorded in the ledger and logged — never invented. */
  reason: string;
  /** Set only when `deliver` is false. */
  suppressedBecause: PushSuppressionReason | null;
  /** Delivered count AFTER this decision. Real, from the ledger. */
  countToday: number;
}

/**
 * Decide, without touching storage or the clock.
 *
 * `quietNow` and `categoryEnabled` come from the caller (push-prefs, reading
 * live config) rather than being re-derived here, so the ceiling, the
 * quiet-hours exemption and the tiering can each be asserted at any hour of any
 * day without stubbing a clock or a config file.
 */
export function decidePush(
  intent: PushIntent,
  ledger: PushLedger,
  options: { quietNow: boolean; categoryEnabled?: boolean },
): PushDecision {
  const tier = tierFor(intent);
  const { quietNow } = options;
  const categoryEnabled = options.categoryEnabled ?? true;

  // A category the user switched off is the user's decision, and it outranks
  // every tier including this one — the exemptions below are exemptions from
  // OUR budget, not licence to override a preference. (No correction rides a
  // push category today, so this costs the correction tier nothing.)
  if (!categoryEnabled) {
    return {
      tier,
      deliver: false,
      breaksQuietHours: false,
      reason: "You turned this kind of push off.",
      suppressedBecause: "category_disabled",
      countToday: ledger.delivered,
    };
  }

  if (tier === "correction") {
    // The exemption. Not a footnote — the whole reason the cap is safe to have.
    return {
      tier,
      deliver: true,
      breaksQuietHours: quietNow,
      reason: quietNow
        ? "I got something wrong — that breaks quiet hours."
        : "I got something wrong.",
      suppressedBecause: null,
      countToday: ledger.delivered + 1,
    };
  }

  if (quietNow) {
    return {
      tier,
      deliver: false,
      breaksQuietHours: false,
      reason: "Quiet hours — it will be in the next brief.",
      suppressedBecause: "quiet_hours",
      countToday: ledger.delivered,
    };
  }

  if (tier === "time_critical") {
    return {
      tier,
      deliver: true,
      breaksQuietHours: false,
      reason: "Time-critical: it needs an answer before it expires.",
      suppressedBecause: null,
      countToday: ledger.delivered + 1,
    };
  }

  if (ledger.unavailable) {
    return {
      tier,
      deliver: false,
      breaksQuietHours: false,
      reason: "Today's count is unreadable — holding this until it is.",
      suppressedBecause: "ledger_unavailable",
      countToday: ledger.delivered,
    };
  }

  if (ledger.delivered >= PUSH_DAILY_CEILING) {
    return {
      tier,
      deliver: false,
      breaksQuietHours: false,
      reason: `That's ${PUSH_DAILY_CEILING} today — the rest waits for the brief.`,
      suppressedBecause: "daily_ceiling",
      countToday: ledger.delivered,
    };
  }

  return {
    tier,
    deliver: true,
    breaksQuietHours: false,
    reason: "Within today's budget.",
    suppressedBecause: null,
    countToday: ledger.delivered + 1,
  };
}
