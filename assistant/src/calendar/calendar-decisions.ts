/**
 * The narrow exception to "a calendar event is not work".
 *
 * A meeting is something you attend, and the day rail (`day-rail.ts`) is how it
 * reaches the owner — so the calendar watcher records its change stream and
 * mints nothing. That is still the default and this module does not change it.
 *
 * What it adds is the one case the default gets wrong: **the event is not the
 * task, the collision between two events is.** "Resolve the Dinner conflict —
 * Flight CX 784 overlaps" is a decision somebody has to make, and no amount of
 * rendering the calendar produces it, because it is a fact about a PAIR.
 *
 * So: a calendar arrival mints work only when it creates a decision. Everything
 * here is an allowlist on top of `record_only`, and every rule is deterministic.
 * When a rule is unsure it returns nothing — a false negative is a change the
 * owner still sees on their calendar, a false positive is the 2020 flood again.
 *
 * ── What this detects ──────────────────────────────────────────────────────
 *  1. **A conflict** — two busy, timed commitments overlap, and at least one of
 *     them is what changed on this poll.
 *  2. **An invite needing an answer** — the owner is an attendee with
 *     `responseStatus: "needsAction"` on an event they did not organise.
 *
 * ── What it deliberately does NOT detect ───────────────────────────────────
 *  · **A hold that expires.** Google Calendar has no expiry field. The only
 *    available signals are a `tentative` RSVP and the word "hold" in a title,
 *    and neither says when the hold lapses — so any deadline Cue attached would
 *    be invented. A guessed expiry on a real commitment is worse than no
 *    feature, so this is left out rather than approximated. If holds ever
 *    arrive as structured data (a Calendar API field, or a Cue-side hold
 *    record), this is the module that gains the rule.
 *  · **A double-booking the owner has lived with for months.** Only pairs
 *    involving an event that CHANGED are considered — this is an arrivals rule,
 *    not a calendar audit.
 *  · **All-day overlaps.** "Out of office (all day)" over a 3pm call is the
 *    normal shape of a calendar, not a collision.
 *  · **Focus time and working-location blocks.** People schedule over their own
 *    focus blocks constantly; treating that as a decision would mint daily.
 */

import { isAllDay } from "./day-rail.js";
import type { CalendarEvent } from "./google-calendar-client.js";

/** Prefix on every decision key, so a decision is never mistaken for an event. */
export const DECISION_ID_PREFIX = "decision:";

/** The kinds of decision a calendar arrival can create. */
export type CalendarDecisionKind = "conflict" | "invite_needs_answer";

/** One decision, ready to become an arrival and a work item. */
export interface CalendarDecision {
  kind: CalendarDecisionKind;
  /**
   * Stable dedup key. Idempotency is the whole reason this is computed from
   * the events rather than generated: `recordArrival` is idempotent on
   * (channel, externalId), so the same conflict re-reported on every poll for
   * the next three months resolves to one row and one work item.
   */
  externalId: string;
  /** The DECISION, in the owner's words. Never "Calendar event: Dinner". */
  title: string;
  /** The evidence, one line: what overlaps what, and when. */
  snippet: string;
  /** Why this cleared the allowlist. */
  reason: string;
  /** Which rule fired, for the arrivals audit. */
  ruleId: string;
}

export interface DetectCalendarDecisionsInput {
  /**
   * Google event ids that changed on this poll. A series MASTER id counts for
   * every instance of that series; an exception id counts for itself.
   */
  changedIds: readonly string[];
  /**
   * Every event on the owner's calendar inside the forward horizon, already
   * expanded into concrete instances (`singleEvents: true`).
   *
   * The horizon has to be fetched rather than derived from the changed events,
   * because the OTHER half of a conflict did not change and so is not in the
   * sync feed. This is also why the full `CalendarEvent` is required here and
   * not the flattened watcher payload — `transparency` and `attendees[].self`
   * decide whether something is a commitment at all.
   */
  horizon: readonly CalendarEvent[];
  now: number;
}

/** Longest event title kept in a decision title, so a row stays readable. */
const TITLE_CLIP = 60;

/**
 * Google's `eventType`s that are NOT commitments you can be double-booked
 * against. `default` and `outOfOffice` are; the rest are calendar furniture.
 * An absent `eventType` is treated as `default` — every event predating the
 * field is an ordinary one.
 */
const NON_COMMITMENT_EVENT_TYPES = new Set([
  "focusTime",
  "workingLocation",
  "birthday",
]);

/** The owner's own RSVP, or null when they are not on the attendee list. */
function selfResponseStatus(
  event: CalendarEvent,
): "needsAction" | "declined" | "tentative" | "accepted" | null {
  return event.attendees?.find((a) => a.self === true)?.responseStatus ?? null;
}

/**
 * The series an instance belongs to. Two instances of one weekly meeting share
 * this; a one-off is its own series.
 */
export function seriesKey(event: CalendarEvent): string {
  return event.recurringEventId ?? event.id;
}

/** Instant in epoch ms, or null when the event carries no readable time. */
function instantOf(when: string | undefined): number | null {
  if (!when) return null;
  const ms = Date.parse(when);
  return Number.isNaN(ms) ? null : ms;
}

interface TimedEvent {
  event: CalendarEvent;
  startMs: number;
  endMs: number;
}

/**
 * A busy, timed commitment — the only thing that can be half of a conflict.
 *
 * Every clause is a way the calendar says "this does not collide":
 * cancelled, marked Free, declined by the owner, all-day, or not a real
 * commitment in the first place. An event whose times cannot be read is
 * dropped, because an overlap computed from a time we could not parse is a
 * guess, and this path does not guess.
 */
function asCommitment(event: CalendarEvent): TimedEvent | null {
  if (event.status === "cancelled") return null;
  if (event.transparency === "transparent") return null;
  if (selfResponseStatus(event) === "declined") return null;
  if (isAllDay(event)) return null;
  if (event.eventType && NON_COMMITMENT_EVENT_TYPES.has(event.eventType)) {
    return null;
  }
  const startMs = instantOf(event.start?.dateTime);
  const endMs = instantOf(event.end?.dateTime);
  if (startMs === null || endMs === null) return null;
  // A zero-length marker cannot overlap anything under the strict test below,
  // and keeping it would only widen the candidate set.
  if (endMs <= startMs) return null;
  return { event, startMs, endMs };
}

/**
 * True when this instance is one of the events that changed on this poll.
 *
 * Three shapes, because the sync feed reports whichever one the write touched:
 * the instance itself, an exception carrying its master's id, and the master of
 * a series (whose instances Google names `<masterId>_20260805T110000Z`).
 */
function changedByThisPoll(
  event: CalendarEvent,
  changedIds: ReadonlySet<string>,
): boolean {
  if (changedIds.has(event.id)) return true;
  if (event.recurringEventId && changedIds.has(event.recurringEventId)) {
    return true;
  }
  const underscore = event.id.indexOf("_");
  if (underscore > 0 && changedIds.has(event.id.slice(0, underscore))) {
    return true;
  }
  return false;
}

/** An event title, trimmed, clipped, and never empty. */
function displayTitle(event: CalendarEvent): string {
  const raw = event.summary?.trim() || "(no title)";
  return raw.length > TITLE_CLIP ? `${raw.slice(0, TITLE_CLIP)}…` : raw;
}

/**
 * The wall-clock reading Google already put in the string.
 *
 * `2026-08-05T19:00:00+08:00` carries the owner's local time in its literal
 * prefix, so the date and time can be quoted back without knowing (or
 * guessing) a timezone. Converting to a zone Cue picked would be the one way
 * to print a time that is wrong.
 */
function wallClock(when: string | undefined): { date: string; time: string } {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(when ?? "");
  if (!match) return { date: "", time: "" };
  return { date: match[1]!, time: match[2]! };
}

/** "5 Aug 19:00–21:00", or "5 Aug 19:00 → 6 Aug 02:00" when it spans days. */
function describeWindow(event: CalendarEvent): string {
  const start = wallClock(event.start?.dateTime);
  const end = wallClock(event.end?.dateTime);
  if (!start.date) return "";
  if (!end.date || end.date === start.date) {
    return `${start.date} ${start.time}–${end.time || start.time}`;
  }
  return `${start.date} ${start.time} → ${end.date} ${end.time}`;
}

/**
 * Read the pairs of overlapping commitments out of the horizon.
 *
 * Sorted sweep rather than a full cross product: once a later event starts
 * after this one ends, nothing beyond it can overlap either.
 */
function conflictDecisions(
  horizon: readonly CalendarEvent[],
  changedIds: ReadonlySet<string>,
  now: number,
): CalendarDecision[] {
  const commitments: TimedEvent[] = [];
  for (const event of horizon) {
    const timed = asCommitment(event);
    // ── The past-event bound ──────────────────────────────────────────
    // Judged on the event's OWN time, never on when the change arrived. A
    // present-day edit to a series running since 2020 rewrites `updated` on
    // every stored exception in it, so "recently changed" says nothing about
    // when the meeting is. A collision that is already over is not a decision
    // anybody can make.
    if (timed && timed.endMs > now) commitments.push(timed);
  }
  commitments.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const decisions: CalendarDecision[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < commitments.length; i++) {
    const a = commitments[i]!;
    for (let j = i + 1; j < commitments.length; j++) {
      const b = commitments[j]!;
      // Strictly: back-to-back (a ends exactly when b starts) is not overlap.
      if (b.startMs >= a.endMs) break;

      const keyA = seriesKey(a.event);
      const keyB = seriesKey(b.event);
      // Two instances of the same series cannot conflict with each other, and
      // a series meeting itself is a calendar bug, not the owner's decision.
      if (keyA === keyB) continue;

      const aChanged = changedByThisPoll(a.event, changedIds);
      const bChanged = changedByThisPoll(b.event, changedIds);
      // Nothing arrived here. A double-booking the owner has lived with is not
      // news, and minting it would turn every poll into a calendar audit.
      if (!aChanged && !bChanged) continue;

      // ── Idempotency, and the recurring-series judgement call ──────────
      // Keyed on the unordered pair of SERIES, with no date in it. A weekly
      // sync that collides with a weekly PT slot is ONE decision — "these two
      // things clash" — made once, not fifty-two times. Putting the occurrence
      // date in the key would be defensible for one-offs and catastrophic for
      // series, and series are where the flood came from. The cost is real and
      // accepted: if the same two series collide again next year, Cue stays
      // quiet, because the arrival row from the first time is still there.
      const pairKey = [keyA, keyB].sort().join("+");
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      // The one that was already on the calendar is the thing being disrupted;
      // the one that arrived is what "overlaps" it. That ordering is what makes
      // the title read as a decision — "Resolve the Dinner conflict — Flight CX
      // 784 overlaps" — rather than as two nouns in arbitrary order.
      const [settled, arriving] =
        aChanged === bChanged ? [a, b] : aChanged ? [b, a] : [a, b];

      decisions.push({
        kind: "conflict",
        externalId: `${DECISION_ID_PREFIX}conflict:${pairKey}`,
        title: `Resolve the ${displayTitle(settled.event)} conflict — ${displayTitle(arriving.event)} overlaps`,
        snippet: `${displayTitle(settled.event)} (${describeWindow(settled.event)}) overlaps ${displayTitle(arriving.event)} (${describeWindow(arriving.event)})`,
        reason: "two commitments on your calendar overlap",
        ruleId: "calendar_conflict",
      });
    }
  }
  return decisions;
}

/**
 * Invites the owner has not answered.
 *
 * An unanswered invite is a decision by construction: somebody is waiting on a
 * yes or a no. The narrowing clauses are the ones that stop it being a firehose
 * — their own event (nothing to answer), an event already under way, and
 * anything they have in fact already answered.
 */
function inviteDecisions(
  horizon: readonly CalendarEvent[],
  changedIds: ReadonlySet<string>,
  now: number,
): CalendarDecision[] {
  const decisions: CalendarDecision[] = [];
  const seen = new Set<string>();

  for (const event of horizon) {
    if (event.status === "cancelled") continue;
    if (!changedByThisPoll(event, changedIds)) continue;
    if (selfResponseStatus(event) !== "needsAction") continue;
    // You do not RSVP to your own meeting.
    if (event.organizer?.self === true) continue;

    // The past-event bound again, and stricter here on purpose: an invite you
    // did not answer before it began is not a decision, it is history.
    const startMs =
      instantOf(event.start?.dateTime) ?? instantOf(event.start?.date);
    if (startMs === null || startMs <= now) continue;

    const key = `${DECISION_ID_PREFIX}invite:${seriesKey(event)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const when = isAllDay(event)
      ? (event.start?.date ?? "")
      : describeWindow(event);
    const from = event.organizer?.displayName || event.organizer?.email || "";

    decisions.push({
      kind: "invite_needs_answer",
      externalId: key,
      title: `Answer the invite to ${displayTitle(event)}`,
      snippet: [when && `${when}.`, from && `Invited by ${from}.`]
        .filter(Boolean)
        .join(" "),
      reason: "you have not answered this invite",
      ruleId: "calendar_invite_needs_answer",
    });
  }
  return decisions;
}

/**
 * Every decision this poll's calendar changes created. Empty is the normal
 * answer and the safe one.
 */
export function detectCalendarDecisions(
  input: DetectCalendarDecisionsInput,
): CalendarDecision[] {
  const changedIds = new Set(input.changedIds.filter((id) => id.length > 0));
  if (changedIds.size === 0) return [];
  return [
    ...conflictDecisions(input.horizon, changedIds, input.now),
    ...inviteDecisions(input.horizon, changedIds, input.now),
  ];
}
