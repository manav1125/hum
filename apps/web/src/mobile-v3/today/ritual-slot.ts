/**
 * The ritual slot's model — which ritual is due, what it says, and whether it
 * says anything at all (design v43 R1, `cue-mobile-rituals.html`).
 *
 * The Morning Brief (`/assistant/brief`) and the Weekly review
 * (`/assistant/weekly`) are two finished surfaces that had, between them, one
 * door: an iOS push. Design's ruling is that rituals do not live in a menu —
 * *a menu has no sense of time* — so they live at the top of Today, in one
 * component with three faces, above the ring.
 *
 * Everything here is pure so the rules can be tested at a stated clock rather
 * than at whatever time CI happens to run:
 *
 *   `pickRitualFace(input)` → the face, or `null` for "render nothing".
 *
 * ## The four rules that are load-bearing, and why each is here
 *
 * **Omit rather than fake.** No ritual due, or nothing behind the one that is,
 * and the slot returns `null`. A permanent "Brief" row sitting empty six hours
 * a day is fabricated content in navigation form — the same rule this codebase
 * states in nine other files, applied to navigation. Loading and error states
 * return `null` too: a door into a room we could not read is worse than no
 * door, because the owner pays the tap to find out.
 *
 * **Never both at once.** The brief owns the morning; the weekly owns Friday
 * from noon and persists, unread, through the weekend. Those windows overlap
 * on Saturday and Sunday morning, which is why priority is stated once, here,
 * rather than emerging from render order: **before 11:00 the brief wins.**
 * (Design's own frame is labelled `SATURDAY · YOUR BRIEF`, which is that rule
 * drawn.)
 *
 * **No state colour is spent.** Both faces are brand blue. A ritual being due
 * is an invitation, not a state — so amber stays free for "needs you", both
 * inside the slot ("one needs you before 10:30") and on the card below it.
 * That is a rule about the component, so the component holds it; this file
 * only ever emits `needsYou` as a count and lets the view spend the colour.
 *
 * **The push and the slot are one door.** `briefSentence` composes from the
 * same three numbers the daemon's push composes from — done overnight, review
 * items, and the single ask (`assistant/src/notifications/morning-brief-push.ts`,
 * `composeMorningBriefCopy`). Both read the output of `gatherOvernight` /
 * `pickAsk`; neither invents a summary of its own. Missing the notification
 * therefore costs nothing, which is the actual bug being fixed.
 */

import type { MorningBrief } from "../brief/use-morning-brief";

/* ------------------------------------------------------------------------- */
/* Windows                                                                   */
/* ------------------------------------------------------------------------- */

/** The brief stops asking at 11:00 (design: "morning, until read or 11am"). */
export const BRIEF_UNTIL_HOUR = 11;
/** Friday's weekly opens at noon ("Friday from noon"). */
export const WEEKLY_FROM_HOUR = 12;

/** Morning — the brief's window, and the half of the overlap the brief owns. */
export function isBriefWindow(now: Date): boolean {
  return now.getHours() < BRIEF_UNTIL_HOUR;
}

/**
 * Friday from noon, then all of Saturday and Sunday.
 *
 * "Persisting through the weekend while unread" is the whole reason this is a
 * window and not an instant: a Friday beat missed on Friday is still worth
 * reading on Sunday, and a review that vanished at midnight would be a ritual
 * that punishes you for having a life on Friday evening.
 */
export function isWeeklyWindow(now: Date): boolean {
  const day = now.getDay(); // 0 Sun … 5 Fri, 6 Sat
  if (day === 5) return now.getHours() >= WEEKLY_FROM_HOUR;
  return day === 6 || day === 0;
}

/* ------------------------------------------------------------------------- */
/* Copy                                                                      */
/* ------------------------------------------------------------------------- */

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

/**
 * Small numbers as words, because the serif line is a sentence and a sentence
 * does not open with a numeral. Past twelve the numeral is the readable form.
 */
export function spell(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "no";
  return n < WORDS.length ? WORDS[n]! : String(n);
}

/** Sentence-case a word that has just been used to start a sentence. */
function cap(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * The brief's serif line, from the same counts the push sends.
 *
 * The three shapes match the push's three: something finished, nothing
 * finished but something is waiting, and a genuinely quiet night. The voice
 * differs (the slot is a sentence, the push is a status line) because they sit
 * in different places; the *facts* are the same numbers, which is what "one
 * door" has to mean when one door is a notification and the other is a card.
 */
export function briefSentence(input: {
  done: number;
  needsYou: number;
}): string {
  if (input.done > 0) {
    return `While you slept, Cue finished ${spell(input.done)} ${
      input.done === 1 ? "thing" : "things"
    }.`;
  }
  if (input.needsYou > 0) return "Nothing finished overnight.";
  return "All quiet overnight.";
}

/**
 * The amber line under the brief's sentence — the ONE place the slot spends a
 * state colour, and it spends it on "needs you", never on "a ritual is due".
 *
 * `by` is the first timed thing on the day ahead, so "before 10:30" is read
 * off the calendar rather than chosen to look urgent. No deadline on file and
 * the line simply stops after "you" — the count is the fact; the time is a
 * courtesy we only extend when we have it.
 */
export function briefNeedsYouLine(input: {
  needsYou: number;
  by?: string;
}): string | null {
  if (input.needsYou <= 0) return null;
  const subject =
    input.needsYou === 1
      ? "One needs you"
      : `${cap(spell(input.needsYou))} need you`;
  return input.by ? `${subject} before ${input.by}.` : `${subject}.`;
}

/**
 * The weekly's serif line: what moved, and what did not.
 *
 * Both halves are stated even when one is zero — "Nothing slipped" is a real
 * and rather good week, and dropping the clause would make a clean week look
 * like a missing number.
 */
export function weeklySentence(input: {
  moved: number;
  slipped: number;
}): string {
  const { moved, slipped } = input;
  if (moved === 0 && slipped === 0) return "A quiet week.";
  const first =
    moved === 0
      ? "Nothing moved."
      : `${cap(spell(moved))} ${moved === 1 ? "thing" : "things"} moved.`;
  const second =
    slipped === 0
      ? "Nothing slipped."
      : `${cap(spell(slipped))} slipped.`;
  return `${first} ${second}`;
}

/* ------------------------------------------------------------------------- */
/* Faces                                                                     */
/* ------------------------------------------------------------------------- */

export type RitualKind = "brief" | "weekly";

/** The expanded card — a dated microlabel, a serif sentence, a timed verb. */
export interface RitualOpenFace {
  state: "open";
  kind: RitualKind;
  /** "SATURDAY · YOUR BRIEF" / "THIS WEEK · READY". */
  label: string;
  /** The weekly's right-hand "4 beats". The brief carries a live dot instead. */
  trailing: string | null;
  sentence: string;
  /** Under the sentence. Amber only when `needsYou` says so. */
  sub: string | null;
  /** How many things are waiting on the owner — the ONLY amber in the slot. */
  needsYou: number;
  /** "Read it · 2 min" / "Look back · 3 min". */
  cta: string;
  href: string;
}

/** The one-row form — a ritual you have done stops asking, but stays reachable. */
export interface RitualCollapsedFace {
  state: "collapsed";
  kind: RitualKind;
  /** "TODAY'S BRIEF" / "THIS WEEK'S REVIEW". */
  label: string;
  /** "Read it ›" / "Look back ›". */
  cta: string;
  href: string;
}

export type RitualFace = RitualOpenFace | RitualCollapsedFace;

/** What the owner has already done with today's / this week's ritual. */
export interface RitualProgress {
  /** They opened it. */
  read: boolean;
  /** They pressed "Later". */
  dismissed: boolean;
}

/**
 * The brief's facts — `null` while the read is in flight or after it failed.
 *
 * A discriminated `null` rather than an object of zeros: zeros would render a
 * confident "All quiet overnight." over a brief we could not actually read,
 * which is the exact failure "omit rather than fake" exists to stop.
 */
export interface BriefFacts {
  /** Finished quietly overnight. */
  done: number;
  /** Waiting on the owner right now (review-state items plus the ask). */
  needsYou: number;
  /** First timed thing on the day ahead, pre-formatted ("10:30"). */
  by?: string;
}

/** The weekly's facts, same contract. */
export interface WeeklyFacts {
  moved: number;
  slipped: number;
}

/** "10:30" from an ISO time, in the owner's locale. */
export function timeLabel(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * The brief payload → the three numbers the slot says.
 *
 * **This is the "one door" seam.** `needsYou` is computed with the exact rule
 * `composeMorningBriefCopy` uses in
 * `assistant/src/notifications/morning-brief-push.ts`: review-state overnight
 * items, plus one for a pending approval, and a review-kind ask that predates
 * the overnight window still counts once so the line never claims a quiet
 * morning over work that is genuinely waiting. That last clause is not an
 * optimisation — it is a bug the push already had and fixed, and re-deriving
 * this by eye is how the card would reacquire it.
 *
 * `ritual-slot.test.ts` reads the daemon file and fails if the rule drifts.
 */
export function briefFactsFrom(brief: MorningBrief | null): BriefFacts | null {
  if (!brief) return null;
  const done = brief.overnight.filter((o) => o.state === "done").length;
  const review = brief.overnight.filter((o) => o.state === "review").length;

  let needsYou = review;
  if (brief.ask?.kind === "approval") {
    needsYou += 1;
  } else if (brief.ask?.kind === "review" && review === 0) {
    needsYou = 1;
  }

  // The deadline is the first TIMED thing on the day ahead. All-day entries
  // carry no time and must not be turned into one.
  const by = timeLabel(brief.day.find((d) => d.time)?.time);
  return by ? { done, needsYou, by } : { done, needsYou };
}

export interface RitualSlotInput {
  now: Date;
  brief: BriefFacts | null;
  weekly: WeeklyFacts | null;
  briefProgress: RitualProgress;
  weeklyProgress: RitualProgress;
  /** Routes, injected so this file never imports the app's router. */
  briefHref: string;
  weeklyHref: string;
}

/** "SATURDAY · YOUR BRIEF" — the weekday is the dated half of the label. */
function briefLabel(now: Date): string {
  return `${now.toLocaleDateString(undefined, { weekday: "long" })} · YOUR BRIEF`.toUpperCase();
}

function openBrief(input: RitualSlotInput, facts: BriefFacts): RitualOpenFace {
  return {
    state: "open",
    kind: "brief",
    label: briefLabel(input.now),
    trailing: null,
    sentence: briefSentence(facts),
    sub: briefNeedsYouLine({ needsYou: facts.needsYou, by: facts.by }),
    needsYou: facts.needsYou,
    cta: "Read it · 2 min",
    href: input.briefHref,
  };
}

function openWeekly(
  input: RitualSlotInput,
  facts: WeeklyFacts,
): RitualOpenFace {
  return {
    state: "open",
    kind: "weekly",
    label: "THIS WEEK · READY",
    // The weekly's pager has four beats and always has; the count is the
    // format, not a metric, so it is safe to state without a source.
    trailing: "4 beats",
    sentence: weeklySentence(facts),
    // Beat four IS the autonomy question — a fact about the surface, which is
    // why it survives a week with no numbers in it.
    sub: "And one question about what Cue should handle alone.",
    needsYou: 0,
    cta: "Look back · 3 min",
    href: input.weeklyHref,
  };
}

function collapsed(kind: RitualKind, href: string): RitualCollapsedFace {
  return kind === "brief"
    ? { state: "collapsed", kind, label: "TODAY'S BRIEF", cta: "Read it ›", href }
    : {
        state: "collapsed",
        kind,
        label: "THIS WEEK'S REVIEW",
        cta: "Look back ›",
        href,
      };
}

/**
 * The whole decision, in one place.
 *
 * Returns `null` for "render nothing" — which is a real and frequent answer,
 * not an error path. Most of the day the top of Today has no ritual in it.
 */
export function pickRitualFace(input: RitualSlotInput): RitualFace | null {
  const briefDue = isBriefWindow(input.now) && input.brief !== null;
  const weeklyDue = isWeeklyWindow(input.now) && input.weekly !== null;

  // Never both. The morning belongs to the brief even on a weekend, which is
  // why this is one branch and not two independent renders.
  if (briefDue) {
    const done = input.briefProgress.read || input.briefProgress.dismissed;
    return done
      ? collapsed("brief", input.briefHref)
      : openBrief(input, input.brief!);
  }
  if (weeklyDue) {
    const done = input.weeklyProgress.read || input.weeklyProgress.dismissed;
    return done
      ? collapsed("weekly", input.weeklyHref)
      : openWeekly(input, input.weekly!);
  }
  // Nothing due, or nothing behind what is. Nothing sits there empty.
  return null;
}
