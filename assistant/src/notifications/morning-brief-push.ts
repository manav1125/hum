/**
 * Morning Brief push — the daily ~7:30 notification that deep-links into
 * the Morning Brief surface (`/assistant/brief`, mobile-v3 frames 4+5).
 *
 * A small daemon-side daily job, patterned on `home/action-board-scheduler`:
 * a cheap minute-resolution tick that fires once per local day inside a
 * bounded window after the configured time. The notification itself goes
 * through `emitNotificationSignal()` (mandatory for all producers — see
 * notifications/AGENTS.md) so persistence, dedup, decision audit, and the
 * home-feed mirror all apply. The copy is composed deterministically from
 * the same helpers the `GET /brief/morning` route uses (`gatherOvernight`,
 * `pickAsk`) — counts come from real data, and an empty night honestly says
 * "All quiet overnight".
 *
 * Idempotence (no double-fire across daemon restarts) is two-layered:
 *   - in-memory: the last date key we fired for in this daemon run;
 *   - durable: the pipeline dedupe key `morning-brief:<dateKey>` — the
 *     notification events store enforces dedupe-key uniqueness, so a
 *     restarted daemon that re-emits for the same day is deduplicated at
 *     the event-store level before any delivery happens.
 *
 * iOS delivery: platform-hosted deployments ride the pipeline's
 * PlatformPushAdapter. Self-hosted deployments (daemon-local APNs creds +
 * push-device registry) get a direct APNs mirror here — the same
 * observation-layer transport extension `push-dispatch.ts` provides for
 * work-item/approval events — gated so it never doubles a successful
 * platform delivery.
 *
 * Timezone: "7:30" is evaluated in `notifications.morningBrief.timezone`
 * when set, else the daemon's local timezone (cloud daemons typically run
 * UTC — set the config for a correct local-morning send).
 */

import { getConfig } from "../config/loader.js";
import {
  type BriefAsk,
  gatherOvernight,
  type OvernightItem,
  pickAsk,
} from "../runtime/routes/morning-brief-routes.js";
import { getLogger } from "../util/logger.js";
import { isApnsConfigured } from "./apns-sender.js";
import { emitNotificationSignal } from "./emit-signal.js";
import { localClock } from "./local-clock.js";
import { sendBudgetedAlert } from "./push-dispatch.js";

export { localClock } from "./local-clock.js";

const log = getLogger("morning-brief-push");

/** In-app route the notification deep-links to. */
export const MORNING_BRIEF_PATH = "/assistant/brief";

/** Tick cadence — minute resolution so a "07:30" target is hit promptly. */
const TICK_INTERVAL_MS = 60_000;
/** Short delay before the first tick so it doesn't pile onto daemon startup. */
const STARTUP_DELAY_MS = 45_000;
/**
 * Fire window after the configured time. A daemon that was down at 7:30 and
 * comes back at 9:00 still sends the brief; one restarted at 9pm does not
 * send a stale "morning" brief at night.
 */
const FIRE_WINDOW_MINUTES = 3 * 60;

const DEFAULT_TIME_MINUTES = 7 * 60 + 30; // 07:30
/** Overnight lookback for the summary counts — matches the brief route default. */
const SINCE_HOURS = 24;

// ---------------------------------------------------------------------------
// Summary composition (pure)
// ---------------------------------------------------------------------------

export interface MorningBriefPushCopy {
  title: string;
  body: string;
}

/**
 * One honest line from the brief's own data: "3 finished overnight · 1 needs
 * your OK". Review-state overnight items and a pending approval both count as
 * "needs your OK" (they are disjoint sources: awaiting_review work items vs
 * pending tool confirmations). A review-kind ask older than the overnight
 * window still counts once, so the line never claims a quiet night while the
 * brief shows an ask. All-quiet gets the calm variant.
 */
export function composeMorningBriefCopy(input: {
  overnight: OvernightItem[];
  ask: BriefAsk | null;
}): MorningBriefPushCopy {
  const done = input.overnight.filter((o) => o.state === "done").length;
  const review = input.overnight.filter((o) => o.state === "review").length;

  let needsOk = review;
  if (input.ask?.kind === "approval") {
    needsOk += 1;
  } else if (input.ask?.kind === "review" && review === 0) {
    // The top awaiting-review item predates the overnight window — it still
    // needs the user, so the line must not read "all quiet".
    needsOk = 1;
  }

  const parts: string[] = [];
  if (done > 0) {
    parts.push(`${done} finished overnight`);
  }
  if (needsOk > 0) {
    parts.push(`${needsOk} need${needsOk === 1 ? "s" : ""} your OK`);
  }

  return {
    title: "Your morning brief is ready",
    body:
      parts.length > 0
        ? parts.join(" · ")
        : "All quiet overnight — your day's ready.",
  };
}

// ---------------------------------------------------------------------------
// Should-fire logic (pure)
// ---------------------------------------------------------------------------

/** Parse "HH:MM" to minutes-of-day; malformed input falls back to 07:30. */
export function parseBriefTime(raw: string | undefined): number {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw ?? "");
  if (!match) return DEFAULT_TIME_MINUTES;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Whether the brief should fire at `now`: inside [time, time + window) in the
 * effective timezone, and not already sent for that local date.
 */
export function shouldFireNow(opts: {
  now: Date;
  time: string;
  timezone: string | null;
  lastSentDateKey: string | null;
}): { fire: boolean; dateKey: string } {
  const clock = localClock(opts.now, opts.timezone);
  const target = parseBriefTime(opts.time);
  const inWindow =
    clock.minutesOfDay >= target &&
    clock.minutesOfDay < target + FIRE_WINDOW_MINUTES;
  return {
    fire: inWindow && opts.lastSentDateKey !== clock.dateKey,
    dateKey: clock.dateKey,
  };
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

export interface MorningBriefSendResult {
  /** True when the pipeline accepted the signal (sent or deduplicated). */
  handled: boolean;
  deduplicated: boolean;
}

/**
 * Compose today's summary and emit it through the notification pipeline,
 * then mirror to daemon-local APNs devices when the platform channel didn't
 * deliver. Never throws.
 */
export async function sendMorningBriefPush(
  dateKey: string,
): Promise<MorningBriefSendResult> {
  const sinceMs = Date.now() - SINCE_HOURS * 60 * 60 * 1000;

  // Same helpers the GET /brief/morning route uses; both already degrade to
  // empty results on store failures, so the copy stays honest ("all quiet"
  // is only wrong if the stores themselves are down — acceptable for v1).
  const overnight = gatherOvernight(sinceMs);
  const ask = pickAsk();
  const copy = composeMorningBriefCopy({ overnight, ask });

  const deepLinkMetadata = {
    kind: "morning_brief",
    path: MORNING_BRIEF_PATH,
    dateKey,
  };

  // `assistant_tool` + requestedMessage = the decision engine's deterministic
  // pass-through: our verbatim copy survives (no LLM rewrite), medium urgency
  // keeps the vellum entry non-interruptive on desktop, and preferredChannels
  // adds the platform push surface for platform-hosted iOS.
  const result = await emitNotificationSignal({
    sourceEventName: "brief.morning_ready",
    sourceChannel: "assistant_tool",
    sourceContextId: `morning-brief:${dateKey}`,
    attentionHints: {
      requiresAction: false,
      urgency: "medium",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
    contextPayload: {
      requestedTitle: copy.title,
      requestedMessage: copy.body,
      preferredChannels: ["platform"],
      deepLinkMetadata,
    },
    dedupeKey: `morning-brief:${dateKey}`,
    throwOnError: false,
  });

  if (result.deduplicated) {
    log.info({ dateKey }, "Morning brief already sent today (dedupe)");
    return { handled: true, deduplicated: true };
  }
  if (!result.dispatched) {
    log.warn(
      { dateKey, reason: result.reason },
      "Morning brief signal not dispatched",
    );
    return { handled: false, deduplicated: false };
  }

  // Self-hosted iOS mirror: when the platform relay didn't actually deliver
  // (no platform credentials on self-host) but daemon-local APNs is
  // configured, page registered devices directly. Skipped when the platform
  // channel delivered, so platform-hosted phones never get a double push.
  //
  // The mirror goes through `sendBudgetedAlert`, so the same category and
  // quiet-hours gates apply as before and the brief now also counts against —
  // and can be held back by — design's three-a-day ceiling. It is the ambient
  // tier: the brief is exactly what the ceiling is for. Suppression only mutes
  // the device push; the in-app brief above already went through the pipeline.
  const platformDelivered = result.deliveryResults.some(
    (r) => r.channel === "platform" && r.status === "sent",
  );
  if (!platformDelivered && isApnsConfigured()) {
    await sendBudgetedAlert({
      intent: { sourceEventName: "brief.morning_ready" },
      category: "morningBrief",
      subjectKey: `brief:${dateKey}`,
      alert: {
        title: copy.title,
        body: copy.body,
        collapseId: `brief-${dateKey}`.slice(0, 64),
        threadId: "cue-morning-brief",
        data: deepLinkMetadata,
      },
    });
  }

  log.info(
    { dateKey, body: copy.body, platformDelivered },
    "Morning brief push sent",
  );
  return { handled: true, deduplicated: false };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let lastSentDateKey: string | null = null;
let tickInFlight = false;

async function tick(now: Date): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const config = getConfig().notifications.morningBrief;
    if (!config.enabled) return;

    const { fire, dateKey } = shouldFireNow({
      now,
      time: config.time,
      timezone: config.timezone,
      lastSentDateKey,
    });
    if (!fire) return;

    const result = await sendMorningBriefPush(dateKey);
    if (result.handled) {
      // Sent (or durably deduplicated — a prior daemon run already sent it):
      // don't retry until the next local day.
      lastSentDateKey = dateKey;
    }
  } catch (err) {
    // Failures log + skip; the next tick inside the window retries.
    log.warn({ err: String(err) }, "Morning brief tick failed");
  } finally {
    tickInFlight = false;
  }
}

/**
 * Start the daily Morning Brief push job. Returns a stop function. Timers
 * are unref'd and every failure is caught — this can never block daemon
 * startup or keep the process alive (assistant/CLAUDE.md startup rules).
 */
export function startMorningBriefScheduler(): () => void {
  const startupTimer = setTimeout(() => {
    void tick(new Date());
  }, STARTUP_DELAY_MS);

  const interval = setInterval(() => {
    void tick(new Date());
  }, TICK_INTERVAL_MS);

  startupTimer.unref?.();
  interval.unref?.();

  log.info("Morning brief push scheduler started");

  return () => {
    clearTimeout(startupTimer);
    clearInterval(interval);
  };
}
