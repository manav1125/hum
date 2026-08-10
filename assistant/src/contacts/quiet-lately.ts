/**
 * "Quiet lately" — people who have gone quiet *relative to their own rhythm*.
 *
 * Design v38 §2, and the name is part of the ruling: it was "Going quiet",
 * which sounds like Cue knows a relationship is dying. It knows a gap. The copy
 * and this module both say only what the arithmetic supports.
 *
 * ## Why every threshold is what it is
 *
 * **Eligibility — 5 messages spanning 30 days.** Below that there is no
 * baseline to be quiet against, and a "rhythm" derived from two emails a week
 * apart is a coincidence with a number attached. Ineligible people do not
 * appear at all, and the surface says why rather than showing an empty list.
 *
 * **MEDIAN gap, not mean.** One holiday, one long thread, one bulk week —
 * any of those drag a mean far enough to redefine "normal" for someone whose
 * behaviour never changed. The median ignores them, which is the whole point
 * of using it on human timing data.
 *
 * **Quiet is `> 3x median` AND `> 14 days`.** Both, deliberately. The ratio
 * alone flags a daily correspondent who has been silent for four days, which
 * is noise. The absolute alone flags everyone who writes monthly, which is
 * their normal. The conjunction is what makes this a signal about a CHANGE
 * rather than about frequency.
 *
 * **Ranked by how far past their OWN normal** (`silence / median`), never by
 * absolute silence — that would just sort your least frequent contacts to the
 * top every time and call it insight.
 *
 * ## The claim this surface makes, and its limit
 *
 * Every row carries its own arithmetic ("usually every 3 days · silent 19")
 * because a soft signal is only trustworthy when falsifiable at a glance. And
 * the ceiling is stated honestly: this is built from INBOUND alone, so it
 * knows when someone stopped writing to you — not whether you owe them a
 * reply. "You owe a reply" waits for sent-mail capture, the same signal the
 * valve's fourth stop needs.
 */

/** Below this many inbound messages there is no rhythm to speak of. */
export const MIN_MESSAGES = 5;
/** Below this span, frequent messages are one burst rather than a habit. */
export const MIN_SPAN_DAYS = 30;
/** How far back a baseline is computed from. */
export const BASELINE_WINDOW_DAYS = 180;
/** Silence must exceed this multiple of the person's own median gap. */
export const QUIET_RATIO = 3;
/** …and this many days outright. Both, or the signal is noise. */
export const QUIET_MIN_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Why a person is not on the list. Distinguished because the surface must
 * never merge "nobody is quiet" with "Cue has no rhythm yet" — they are
 * different facts and the owner acts on them differently.
 */
export type QuietIneligibleReason = "too_few_messages" | "span_too_short";

export interface QuietCandidate {
  /** Stable identity of the person — caller's key, echoed back untouched. */
  key: string;
  /** Inbound message times, epoch ms. Order does not matter. */
  timestamps: number[];
}

export interface QuietVerdict {
  key: string;
  /** Their normal, in whole days — the "usually every 3 days" number. */
  medianGapDays: number;
  /** Days since they last wrote — the "silent 19" number. */
  silentDays: number;
  /** silentDays / medianGapDays. The sort key; higher is more unusual. */
  ratio: number;
}

/**
 * The median gap between consecutive timestamps, in ms.
 *
 * Exported for its own tests: the even-length case (mean of the two middle
 * gaps) is the one that silently rounds wrong if written carelessly, and it is
 * the common case for a person with an odd number of messages.
 */
export function medianGapMs(sortedTimestamps: number[]): number | null {
  if (sortedTimestamps.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < sortedTimestamps.length; i++) {
    gaps.push(sortedTimestamps[i]! - sortedTimestamps[i - 1]!);
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 1 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
}

/**
 * Is this person eligible for a verdict at all, and if not, why?
 *
 * Returns `null` when eligible. Separated from {@link assessQuiet} so the
 * caller can count ineligible people — the surface needs to distinguish "you
 * have contacts but none have a rhythm yet" from "you have no contacts".
 */
export function quietIneligibleReason(
  sortedTimestamps: number[],
): QuietIneligibleReason | null {
  if (sortedTimestamps.length < MIN_MESSAGES) return "too_few_messages";
  const span =
    sortedTimestamps[sortedTimestamps.length - 1]! - sortedTimestamps[0]!;
  if (span < MIN_SPAN_DAYS * DAY_MS) return "span_too_short";
  return null;
}

/**
 * A verdict for one person, or `null` if they are ineligible or not quiet.
 *
 * Pure and total: no clock, no I/O, no throwing. `now` is injected so the
 * thresholds are testable without wall-clock races — the same reason the
 * valve's rules take their context rather than reading it.
 */
export function assessQuiet(
  candidate: QuietCandidate,
  now: number,
): QuietVerdict | null {
  const times = [...candidate.timestamps]
    .filter((t) => Number.isFinite(t) && t <= now)
    .sort((a, b) => a - b);

  // Only the baseline window counts. A rhythm from two years ago is not the
  // rhythm they are currently departing from.
  const cutoff = now - BASELINE_WINDOW_DAYS * DAY_MS;
  const recent = times.filter((t) => t >= cutoff);

  if (quietIneligibleReason(recent) !== null) return null;

  const median = medianGapMs(recent);
  if (median === null || median <= 0) return null;

  const last = recent[recent.length - 1]!;
  const silentMs = now - last;

  // Both conditions, per the ruling. Either alone produces a list nobody
  // trusts: the ratio alone flags a daily correspondent quiet since Friday,
  // the absolute alone flags everyone who simply writes monthly.
  if (silentMs <= QUIET_RATIO * median) return null;
  if (silentMs <= QUIET_MIN_DAYS * DAY_MS) return null;

  return {
    key: candidate.key,
    medianGapDays: Math.max(1, Math.round(median / DAY_MS)),
    silentDays: Math.floor(silentMs / DAY_MS),
    ratio: silentMs / median,
  };
}

/**
 * Everyone currently quiet, most-unusual first.
 *
 * The sort is on `ratio` — distance past their own normal — because ranking on
 * raw silence would put your least frequent contacts on top permanently and
 * teach the owner the list is meaningless.
 */
export function assessAllQuiet(
  candidates: QuietCandidate[],
  now: number,
): QuietVerdict[] {
  const out: QuietVerdict[] = [];
  for (const c of candidates) {
    const v = assessQuiet(c, now);
    if (v) out.push(v);
  }
  out.sort((a, b) => b.ratio - a.ratio);
  return out;
}

/**
 * How many candidates had enough history to be judged at all.
 *
 * Drives the difference between the two empty states: with eligible people and
 * no verdicts, everyone is talking at their usual pace; with none eligible,
 * Cue has no rhythm yet and should say so instead of implying all is well.
 */
export function countEligible(
  candidates: QuietCandidate[],
  now: number,
): number {
  const cutoff = now - BASELINE_WINDOW_DAYS * DAY_MS;
  let n = 0;
  for (const c of candidates) {
    const recent = [...c.timestamps]
      .filter((t) => Number.isFinite(t) && t <= now && t >= cutoff)
      .sort((a, b) => a - b);
    if (quietIneligibleReason(recent) === null) n++;
  }
  return n;
}

/** The row's own arithmetic, exactly as design worded it. */
export function quietRowExplanation(v: QuietVerdict): string {
  const every =
    v.medianGapDays === 1
      ? "usually every day"
      : `usually every ${v.medianGapDays} days`;
  return `${every} · silent ${v.silentDays}`;
}
