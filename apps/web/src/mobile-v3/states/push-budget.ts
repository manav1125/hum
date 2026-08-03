/**
 * K2 · Push — the interruption budget, as a decision.
 *
 * Design drew three notifications on a lock screen and stated the rule under
 * them: "a correction that breaks quiet hours · one time-critical approval with
 * Send it inline · the 7:30 brief. THREE A DAY IS THE CEILING unless something
 * breaks."
 *
 * WHAT THIS FILE IS, AND WHAT IT IS NOT
 * ------------------------------------
 * It is the decision: given an intent, what tier is it, may it break quiet
 * hours, does it carry an inline action, and does the day's budget still have
 * room. It is pure and it is tested.
 *
 * It is NOT the delivery. Two paths exist in this app and only one of them can
 * see this code:
 *
 *   · **Local notifications** (`hooks/use-notification-intent-sync.ts` →
 *     `runtime/notifications.ts`) fire in the client from an SSE event. This
 *     module gates those, and that wiring is live.
 *   · **Remote APNs push** (`lib/push-notifications.ts`) is composed and sent
 *     BY THE DAEMON to a registered device token. It never enters the web
 *     client, so nothing here can cap it. Honouring the ceiling on that path
 *     is a daemon change; until it lands, a backgrounded phone can exceed the
 *     three design specified.
 *
 * That split is stated here rather than in a status doc because the next
 * person to read this file is the one who would otherwise assume the cap is
 * global.
 *
 * THE CAP MAY NOT HIDE AN EMERGENCY
 * ---------------------------------
 * "Unless something breaks" is not a footnote, it is the exemption that keeps
 * this from being a fail-closed filter. Corrections and time-critical
 * approvals are NEVER capped — they are counted, so the ledger stays honest,
 * but they are always delivered. Only the ambient tier (briefs, completions,
 * digests) is ever held back. A rule that could silently swallow "your payment
 * needs approval in 40 minutes" to protect a notification budget would be the
 * same class of mistake as a judgement about content suppressing a user's
 * item.
 */
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";

const LEDGER_KEY = "cue:push:ledger:v1";

/** Design's ceiling. */
export const PUSH_DAILY_CEILING = 3;

/**
 * The three tiers, in the order design drew them.
 *
 *  · `correction`  — Cue reporting its own error. First person, verbatim,
 *                    breaks quiet hours. The one thing that always gets through.
 *  · `time_critical` — a decision with a deadline attached. Carries an inline
 *                    action so it can be answered without unlocking.
 *  · `ambient`     — the 7:30 brief and everything like it. Capped.
 */
export type PushTier = "correction" | "time_critical" | "ambient";

export interface PushIntent {
  /** The daemon's event name, e.g. `work_item.needs_review`. */
  sourceEventName: string;
  title: string;
  body: string;
  /** Present when the intent is an approval that can be answered inline. */
  approval?: { actionLabel: string; deadlineAt?: number | null };
  /** Cue correcting itself. Overrides everything below it. */
  isSelfCorrection?: boolean;
}

export interface QuietHours {
  /** Local hour the quiet window opens, e.g. 22. */
  startHour: number;
  /** Local hour it closes, e.g. 8. */
  endHour: number;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { startHour: 22, endHour: 8 };

export interface PushDecision {
  tier: PushTier;
  deliver: boolean;
  /** Delivered inside the quiet window because the tier earns it. */
  breaksQuietHours: boolean;
  /** The "Send it" affordance on the notification itself, or null. */
  inlineAction: string | null;
  /** Why, in one line. Surfaced in the ledger and in logs — never invented. */
  reason: string;
  /** Count AFTER this decision, for the "3 notifications today" line. */
  countToday: number;
}

/* ----------------------------- tiering ---------------------------------- */

/** Event names that are Cue admitting a mistake. */
const CORRECTION_EVENTS = [
  "assistant.correction",
  "work_item.reversed",
  "arrival.unfiled",
  "run.failed",
];

/** Event names that carry a decision with a clock on it. */
const TIME_CRITICAL_EVENTS = [
  "guardian_action.requested",
  "work_item.needs_review",
  "approval.requested",
  "budget.hard_stop",
];

export function tierFor(intent: PushIntent): PushTier {
  if (intent.isSelfCorrection) return "correction";
  if (CORRECTION_EVENTS.includes(intent.sourceEventName)) return "correction";
  if (intent.approval) return "time_critical";
  if (TIME_CRITICAL_EVENTS.includes(intent.sourceEventName))
    return "time_critical";
  return "ambient";
}

export function isQuietHour(date: Date, quiet: QuietHours): boolean {
  const hour = date.getHours();
  // A window that wraps midnight (22 → 8) is the normal case, so it is the one
  // handled first rather than the edge case bolted on afterwards.
  if (quiet.startHour === quiet.endHour) return false;
  if (quiet.startHour > quiet.endHour)
    return hour >= quiet.startHour || hour < quiet.endHour;
  return hour >= quiet.startHour && hour < quiet.endHour;
}

/* ------------------------------ ledger ---------------------------------- */

export interface PushLedger {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  delivered: number;
  /** Held back by the ceiling. Counted so "how noisy was I" stays answerable. */
  suppressed: number;
}

export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function readPushLedger(now = new Date()): PushLedger {
  const fresh: PushLedger = { day: dayKey(now), delivered: 0, suppressed: 0 };
  try {
    const raw = getLocalSetting(LEDGER_KEY, "");
    if (!raw) return fresh;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fresh;
    const led = parsed as Partial<PushLedger>;
    if (led.day !== fresh.day) return fresh; // a new day is a new budget
    return {
      day: fresh.day,
      delivered: typeof led.delivered === "number" ? led.delivered : 0,
      suppressed: typeof led.suppressed === "number" ? led.suppressed : 0,
    };
  } catch {
    return fresh;
  }
}

export function writePushLedger(ledger: PushLedger): void {
  try {
    setLocalSetting(LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    /* best-effort — a lost ledger costs at most one extra notification */
  }
}

/* ----------------------------- the decision ------------------------------ */

/**
 * Decide, without touching storage. `ledger` is the day so far.
 *
 * Pure so the ceiling, the quiet-hours exemption and the inline action can be
 * asserted at any hour of any day without stubbing a clock into a component.
 */
export function decidePush(
  intent: PushIntent,
  ledger: PushLedger,
  options: { now?: Date; quiet?: QuietHours } = {},
): PushDecision {
  const now = options.now ?? new Date();
  const quiet = options.quiet ?? DEFAULT_QUIET_HOURS;
  const tier = tierFor(intent);
  const quietNow = isQuietHour(now, quiet);

  const inlineAction = intent.approval?.actionLabel ?? null;

  if (tier === "correction") {
    return {
      tier,
      deliver: true,
      breaksQuietHours: quietNow,
      inlineAction,
      reason: quietNow
        ? "I got something wrong — that breaks quiet hours."
        : "I got something wrong.",
      countToday: ledger.delivered + 1,
    };
  }

  if (tier === "time_critical") {
    return {
      tier,
      deliver: true,
      breaksQuietHours: quietNow,
      inlineAction,
      reason: "Time-critical: it needs an answer before it expires.",
      countToday: ledger.delivered + 1,
    };
  }

  if (quietNow) {
    return {
      tier,
      deliver: false,
      breaksQuietHours: false,
      inlineAction: null,
      reason: "Quiet hours — it will be in the next brief.",
      countToday: ledger.delivered,
    };
  }

  if (ledger.delivered >= PUSH_DAILY_CEILING) {
    return {
      tier,
      deliver: false,
      breaksQuietHours: false,
      inlineAction: null,
      reason: `That's ${PUSH_DAILY_CEILING} today — the rest waits for the brief.`,
      countToday: ledger.delivered,
    };
  }

  return {
    tier,
    deliver: true,
    breaksQuietHours: false,
    inlineAction,
    reason: "Within today's budget.",
    countToday: ledger.delivered + 1,
  };
}

/**
 * Decide and record. The single call a delivery path makes.
 *
 * Records BEFORE the caller delivers, because a notification that fires and
 * is not counted is how a ceiling of three becomes a floor of three.
 */
export function decideAndRecordPush(
  intent: PushIntent,
  options: { now?: Date; quiet?: QuietHours } = {},
): PushDecision {
  const now = options.now ?? new Date();
  const ledger = readPushLedger(now);
  const decision = decidePush(intent, ledger, { ...options, now });
  writePushLedger({
    day: ledger.day,
    delivered: decision.deliver ? ledger.delivered + 1 : ledger.delivered,
    suppressed: decision.deliver ? ledger.suppressed : ledger.suppressed + 1,
  });
  return decision;
}

/**
 * The line design put on the lock screen itself. Real numbers only — it reads
 * the ledger, and says the honest thing when the day has been noisy.
 */
export function budgetLine(ledger: PushLedger): string {
  const n = ledger.delivered;
  const noun = n === 1 ? "notification" : "notifications";
  if (n > PUSH_DAILY_CEILING)
    return `${n} ${noun} today · over the usual ${PUSH_DAILY_CEILING}, because something broke`;
  return `${n} ${noun} today · that's the limit unless something breaks`;
}
