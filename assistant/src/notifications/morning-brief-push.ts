/**
 * Morning Brief push — the daily ~7:30 notification that deep-links into
 * the Morning Brief surface (`/assistant/brief`, mobile-v3 frames 4+5).
 *
 * A small daemon-side daily job, patterned on `home/action-board-scheduler`:
 * a cheap minute-resolution tick that fires once per local day inside a
 * bounded window after the configured time. The notification itself goes
 * through `emitNotificationSignal()` (mandatory for all producers — see
 * notifications/AGENTS.md) so persistence, dedup, decision audit, and the
 * home-feed mirror all apply.
 *
 * **The push IS the sentence** (design v44 N2). It is composed from exactly the
 * payload `GET /brief/morning` returns — `buildMorningBrief` itself, not a
 * parallel assembly of the same helpers — so the notification and the ritual
 * slot at the top of Today are one door saying one thing: *"While you slept,
 * Cue finished four things."* / *"One needs you before 10:30."* An empty night
 * honestly says "All quiet overnight." with no second line, because a push that
 * only ever arrives with news teaches the owner that silence means broken.
 * And if the figures cannot be computed the push does not fire at all — a
 * serif sentence is not licence to be vague.
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
  buildMorningBrief,
  type OvernightItem,
} from "../runtime/routes/morning-brief-routes.js";
import { getLogger } from "../util/logger.js";
import { listWorkItems } from "../work-items/work-item-store.js";
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
  /**
   * Line one — the sentence, and the thing actually worth waking someone for.
   *
   * It goes in the notification's TITLE because that is the first line an
   * owner reads; the app's own name already sits above it, so nothing is lost
   * by giving the position to the sentence instead of to "Your morning brief
   * is ready", which was a system report about a system report.
   */
  title: string;
  /**
   * Line two — the one ask beneath it, or `""` on a quiet night.
   *
   * Design's ruling is explicit that the quiet night has **no subtitle**: "All
   * quiet overnight." is the whole push. Empty rather than a filler line,
   * because a second line that says nothing is exactly the padding the one-door
   * rule exists to remove.
   */
  body: string;
}

/**
 * The same word list the slot spells its counts from
 * (`apps/web/src/mobile-v3/today/ritual-slot.ts`, `spell`).
 *
 * A serif sentence does not open with a numeral, and past twelve the numeral
 * IS the readable form — so the vocabulary has to be shared, not re-decided.
 * It is duplicated rather than imported because the daemon and the web client
 * are different packages; `ritual-slot.test.ts` reads this file and fails when
 * the two drift, which is the same mechanism `push-budget-client-parity`
 * already uses for the notification ceiling.
 */
const WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

export function spell(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "no";
  return n < WORDS.length ? WORDS[n]! : String(n);
}

/** Sentence-case a word that has just been used to start a sentence. */
function cap(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * The push, as the sentence it is (design v44 N2).
 *
 * *"While you slept, Cue finished four things."* / *"One needs you before
 * 10:30."* — two lines, in that order, the same two the ritual slot renders at
 * the top of Today. What it replaces ("3 finished overnight · 1 needs your OK")
 * was true and read like a status line; one-door means the push and the card
 * are the same door, and a door is not two different sentences.
 *
 * **The figures compose the sentence; the sentence is never written around
 * them.** Every number below comes from the brief's own payload, and when they
 * cannot be computed this returns `null` and the push does not fire — a serif
 * sentence is not licence to be vague.
 *
 * Review-state overnight items and a pending approval both count as "needs
 * you" (disjoint sources: awaiting_review work items vs pending tool
 * confirmations). A review-kind ask older than the overnight window still
 * counts once, so the line never claims a quiet night while the brief shows an
 * ask. `ritual-slot.ts`'s `briefFactsFrom` mirrors this rule exactly, and
 * `ritual-slot.test.ts` reads this file to prove it still does.
 */
export function composeMorningBriefCopy(input: {
  overnight: OvernightItem[];
  ask: BriefAsk | null;
  /**
   * First timed thing on the day ahead, pre-formatted ("10:30").
   *
   * Read off the calendar rather than chosen to look urgent, and absent when
   * the day carries no timed entry — the count is the fact, the time is a
   * courtesy only extended when there is one.
   */
  by?: string;
  /**
   * Items awaiting the owner RIGHT NOW, irrespective of the overnight window.
   *
   * `gatherOvernight` only returns items whose status CHANGED inside the
   * window — correct for "what happened overnight", and silent about anything
   * that has been standing there for days. So on a morning with seven items
   * waiting, none of them touched overnight, every count above was zero and
   * this push said "All quiet overnight — your day's ready."
   *
   * A quiet night is not a clear day. This is the number that stops the brief
   * reassuring somebody past work that is genuinely waiting on them.
   *
   * **`null` means the figure could not be computed** (the work-item store did
   * not answer) — and then there is no honest sentence to send, so there is no
   * push. `undefined` keeps the historic "assume none standing" behaviour for
   * callers that do not supply it.
   */
  standingNeedsYou?: number | null;
}): MorningBriefPushCopy | null {
  // The figures are the sentence. Without them there is nothing to say.
  if (input.standingNeedsYou === null) return null;

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

  // The window's count when it has one, else what is simply standing there.
  // "All quiet overnight." now requires BOTH to be zero, which is the bug fix
  // the previous shape carried, kept in the new voice.
  const needsYou = needsOk > 0 ? needsOk : (input.standingNeedsYou ?? 0);

  const title =
    done > 0
      ? `While you slept, Cue finished ${spell(done)} ${
          done === 1 ? "thing" : "things"
        }.`
      : needsYou > 0
        ? "Nothing finished overnight."
        : "All quiet overnight.";

  if (needsYou <= 0) return { title, body: "" };

  const subject =
    needsYou === 1 ? "One needs you" : `${cap(spell(needsYou))} need you`;
  return {
    title,
    body: input.by ? `${subject} before ${input.by}.` : `${subject}.`,
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

/**
 * How many work items are awaiting the owner right now, window-independent.
 *
 * **`null` when the store could not be read**, and that is the whole point:
 * this reads the same store `gatherOvernight` reads, so a failure here means
 * every count in the sentence is equally untrustworthy. It used to fail to
 * ZERO, which let an outage send "All quiet overnight" over an unknown amount
 * of waiting work. Design's N2 ruling closes that: if the numbers cannot be
 * computed, the push does not fire.
 */
function countStandingNeedsYou(): number | null {
  try {
    return listWorkItems().filter((i) => i.status === "awaiting_review").length;
  } catch (err) {
    log.warn(
      { err: String(err) },
      "morning-brief: standing needs-you read failed",
    );
    return null;
  }
}

/**
 * "10:30" from an ISO instant — the deadline the second line states.
 *
 * Formatted in the brief's configured timezone rather than the daemon's, for
 * the same reason the fire time is: prod runs UTC, and a London owner asked to
 * act "before 09:30" when their calendar says 10:30 has been handed a wrong
 * number, which is worse than being handed none. An unparseable instant, or no
 * instant at all, yields `undefined` and the line simply stops after "you".
 */
function timeLabel(
  iso: string | undefined,
  timezone: string | null,
): string | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(new Date(ms));
  } catch {
    return undefined;
  }
}

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
  // `buildMorningBrief` rather than the two helpers separately: it is the
  // EXACT payload `GET /brief/morning` returns, which is the exact payload the
  // ritual slot composes its sentence from. Calling the same builder is what
  // makes "the push and the slot are one door" a fact about the code rather
  // than a convention two files are asked to keep. It also inherits the
  // route's own reconciliation — the one ask is dropped from the overnight
  // list, which the push used to miss, so the two doors could state different
  // counts on any morning with a review-kind ask inside the window.
  let brief: Awaited<ReturnType<typeof buildMorningBrief>>;
  try {
    brief = await buildMorningBrief({ sinceHours: SINCE_HOURS });
  } catch (err) {
    log.warn({ err: String(err) }, "morning-brief: brief build failed");
    return { handled: false, deduplicated: false };
  }

  const copy = composeMorningBriefCopy({
    overnight: brief.overnight,
    ask: brief.ask,
    by: timeLabel(
      brief.day.find((d) => d.time)?.time,
      getConfig().notifications.morningBrief.timezone,
    ),
    standingNeedsYou: countStandingNeedsYou(),
  });

  // Design's N2 caveat, enforced: a serif sentence is not licence to be vague,
  // so a morning whose figures could not be computed sends nothing at all.
  if (!copy) {
    log.warn({ dateKey }, "Morning brief not sent — figures unavailable");
    return { handled: false, deduplicated: false };
  }

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
      // Two lines, in design's order: the sentence, then the one ask. On a
      // quiet night there is no second line, so the sentence becomes the
      // message and the pipeline derives the title from it — the alternative
      // is an empty `requestedMessage`, which drops straight out of the
      // deterministic pass-through and hands our verbatim copy to the LLM.
      ...(copy.body ? { requestedTitle: copy.title } : {}),
      requestedMessage: copy.body || copy.title,
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
        // The device push keeps both lines where design put them: the sentence
        // is the title, the ask is the body. A quiet night has an empty body,
        // which iOS renders as the title alone — design's "no subtitle".
        title: copy.title,
        body: copy.body,
        collapseId: `brief-${dateKey}`.slice(0, 64),
        threadId: "cue-morning-brief",
        data: deepLinkMetadata,
      },
    });
  }

  log.info(
    { dateKey, title: copy.title, body: copy.body, platformDelivered },
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
