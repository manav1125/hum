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
 * rather than emerging from render order: **when two windows overlap, the
 * narrower one wins.** Design generalised the old "before 11:00 the brief
 * wins" tiebreak into that rule, so there is no per-day special case to keep
 * in step — perishability decides, and the brief's eleven hours are always
 * more perishable than the weekly's sixty. (Design's own frame is labelled
 * `SATURDAY · YOUR BRIEF`, which is that rule drawn.)
 *
 * **Suppressed until something has actually been watched (R5).** The slot used
 * to be hidden entirely under Today's not-set-up takeover. Design overturned
 * that — *"the first morning is arguably exactly when a ritual should
 * introduce itself"* — with a condition: a fresh instance with nothing
 * connected has no brief, so the takeover keeps the screen, and the slot
 * returns on **the first morning after a night with real intake**, which is a
 * different trigger from "not empty". That is one extra boolean (*has this
 * owner seen a brief before*), not a second state machine.
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

/**
 * How wide each window is, in hours — the ONLY input to the tiebreak.
 *
 * Design's rule is general: **when two time windows overlap, the narrower one
 * wins**, because the narrower one is the more perishable. Stating the widths
 * is what makes that a rule rather than an ordering: nobody has to remember
 * that Saturday is special, and moving either boundary moves the tiebreak with
 * it instead of silently disagreeing with it.
 */
export const BRIEF_WINDOW_HOURS = BRIEF_UNTIL_HOUR; // midnight → 11:00
export const WEEKLY_WINDOW_HOURS = 24 - WEEKLY_FROM_HOUR + 48; // Fri noon → Mon

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
 * A sub-line, in pieces, because design's pack emphasises a clause inside two
 * of them ("**Cue was watching**", "**This is what every morning looks like
 * now.**") and an emphasis in the middle of a sentence cannot survive a plain
 * string. Segments rather than markup: the model still says only what the
 * words are and which one carries the weight; the view spends the pixels.
 */
export interface RitualSubSegment {
  text: string;
  strong?: true;
}

/** One plain segment — the shape almost every sub-line has. */
function plain(text: string): RitualSubSegment[] {
  return [{ text }];
}

/**
 * The all-quiet brief's sub-line (R3).
 *
 * Design's ruling corrects their own spec: **omit-rather-than-fake governs
 * *absent* data, not *uneventful* data.** "Nothing happened" is a finding, and
 * a valuable one — so it renders, and it renders with **what was watched**,
 * because "6 sources, no movement" is the entire difference between a quiet
 * night and a broken pipeline.
 *
 * The watched clause is dropped when the source count could not be read, or
 * when it is zero. That is not the vagueness rule biting: "Cue was watching"
 * over an unreadable or empty watcher list is precisely the false reassurance
 * the clause exists to prevent, and a claim we cannot stand behind is absent
 * data. (A count of zero cannot reach the ordinary path anyway — nothing
 * watched means nothing was read, and R5's gate has already returned `null`.)
 */
export function quietSub(sources: number | null): RitualSubSegment[] {
  const opening = "Nothing arrived, nothing needs you.";
  if (sources === null || sources <= 0) return plain(opening);
  return [
    { text: `${opening} ` },
    { text: "Cue was watching", strong: true },
    {
      text: ` — ${sources} ${sources === 1 ? "source" : "sources"}, no movement.`,
    },
  ];
}

/**
 * The first brief's sentence (R5) — the one morning Cue gets to say what it is.
 *
 * Composed from the real intake count and nothing else. Design is explicit
 * that the figures are the point: *"every other onboarding surface promises
 * and this one reports"*, and a promise wearing a number it did not measure is
 * the worst of both. `pickRitualFace` will not reach this function without a
 * count, so the face physically cannot render around a missing figure.
 */
export function firstBriefSentence(read: number): string {
  return `One night in, and I've read ${spell(read)} ${
    read === 1 ? "thing" : "things"
  }.`;
}

/** "Twelve looked like yours. **This is what every morning looks like now.**" */
export function firstBriefSub(yours: number): RitualSubSegment[] {
  return [
    { text: `${cap(spell(yours))} looked like yours. ` },
    { text: "This is what every morning looks like now.", strong: true },
  ];
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
    slipped === 0 ? "Nothing slipped." : `${cap(spell(slipped))} slipped.`;
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
  /**
   * `"first"` is the one-time introduction R5 buys back; everything else is
   * `"ordinary"`. It is a tone, not a state: the same card, the same model,
   * one boolean's worth of difference in what it is allowed to say.
   */
  tone: "ordinary" | "first";
  /** "SATURDAY · YOUR BRIEF" / "YOUR FIRST BRIEF" / "THIS WEEK · READY". */
  label: string;
  /** The weekly's right-hand "4 beats". The brief carries a live dot instead. */
  trailing: string | null;
  sentence: string;
  /** Under the sentence, in pieces so an emphasised clause survives. */
  sub: RitualSubSegment[] | null;
  /**
   * Whether the sub-line is the needs-you fact (amber) or a description
   * (muted). Stated rather than inferred from `needsYou`, because the first
   * brief's sub-line is a description on a morning that may well have a
   * needs-you count behind it.
   */
  subTone: "muted" | "amber";
  /** How many things are waiting on the owner — the ONLY amber in the slot. */
  needsYou: number;
  /**
   * "Read it · 2 min" / "Look back · 3 min", or **`null` on the all-quiet
   * face**: there is nothing to read, so the sentence *is* the brief and a
   * verb would be sending the owner to an empty room (R3).
   */
  cta: string | null;
  /** What stands where the verb would be. Present exactly when `cta` is null. */
  note: string | null;
  /** The secondary control's word — "Later", or "Dismiss" with no verb beside it. */
  dismiss: string;
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

/**
 * What arrived overnight — R5's two figures, and R5's trigger.
 *
 * `null` while the read is in flight or after it failed, for the same reason
 * `BriefFacts` is nullable: zeros here would introduce a brand-new owner to
 * Cue with "I've read no things", which is worse than saying nothing at all.
 *
 * Deliberately separate from `sources` below. They are wanted on different
 * mornings — the intake figures exactly once, the source count on every quiet
 * one — and folding them into a single object is how the all-quiet face lost
 * its watched clause the first time this was built.
 */
export interface BriefIntake {
  /** Everything that arrived in the window — "I've read 41 things". */
  read: number;
  /** The ones Cue decided were the owner's — "Twelve looked like yours". */
  yours: number;
}

/** "10:30" from an ISO time, in the owner's locale. */
export function timeLabel(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
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
  /** What arrived overnight (R5). `null` when it could not be read. */
  intake: BriefIntake | null;
  /**
   * Live watched sources (R3's "6 sources"). `null` when the watcher list
   * could not be read — never zero-by-default, because "0 sources, no
   * movement" on a healthy morning reads as a broken pipeline.
   */
  sources: number | null;
  /**
   * R5's one extra boolean: has this owner met a brief on a previous morning?
   *
   * False on a brand-new instance AND on the very first morning after intake —
   * which is exactly the morning the "first brief" face is for. It flips the
   * day after, and every face is ordinary from then on.
   */
  hasSeenBrief: boolean;
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
  const quiet = facts.done === 0 && facts.needsYou === 0;
  const base = {
    state: "open" as const,
    kind: "brief" as const,
    tone: "ordinary" as const,
    label: briefLabel(input.now),
    trailing: null,
    sentence: briefSentence(facts),
    needsYou: facts.needsYou,
    href: input.briefHref,
  };

  // R3 — the all-quiet face. No primary verb, because there is nothing to
  // read; and it names what was watched, because that clause is what tells a
  // quiet night apart from a broken pipeline.
  if (quiet) {
    return {
      ...base,
      sub: quietSub(input.sources),
      subTone: "muted",
      cta: null,
      note: "Nothing to read this morning",
      dismiss: "Dismiss",
    };
  }

  const needsYouLine = briefNeedsYouLine({
    needsYou: facts.needsYou,
    by: facts.by,
  });
  return {
    ...base,
    sub: needsYouLine ? plain(needsYouLine) : null,
    subTone: needsYouLine ? "amber" : "muted",
    cta: "Read it · 2 min",
    note: null,
    dismiss: "Later",
  };
}

/**
 * R5's exception — the one brief that gets to say what it is.
 *
 * Reached only when real intake exists, so both figures in the sentence are
 * measured. It reports rather than promises, which is why design granted it
 * the exception it denies every other onboarding surface.
 */
function firstBrief(
  input: RitualSlotInput,
  intake: BriefIntake,
): RitualOpenFace {
  return {
    state: "open",
    kind: "brief",
    tone: "first",
    label: "YOUR FIRST BRIEF",
    trailing: null,
    sentence: firstBriefSentence(intake.read),
    sub: firstBriefSub(intake.yours),
    // The line is a description of what mornings are now, not an ask — so it
    // does not take the colour that means "answer me", however many things
    // happen to be waiting behind it.
    subTone: "muted",
    needsYou: input.brief?.needsYou ?? 0,
    cta: "Read it · 2 min",
    note: null,
    dismiss: "Later",
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
    tone: "ordinary",
    label: "THIS WEEK · READY",
    // The weekly's pager has four beats and always has; the count is the
    // format, not a metric, so it is safe to state without a source.
    trailing: "4 beats",
    sentence: weeklySentence(facts),
    // Beat four IS the autonomy question — a fact about the surface, which is
    // why it survives a week with no numbers in it.
    sub: plain("And one question about what Cue should handle alone."),
    subTone: "muted",
    needsYou: 0,
    cta: "Look back · 3 min",
    note: null,
    dismiss: "Later",
    href: input.weeklyHref,
  };
}

function collapsed(kind: RitualKind, href: string): RitualCollapsedFace {
  return kind === "brief"
    ? {
        state: "collapsed",
        kind,
        label: "TODAY'S BRIEF",
        cta: "Read it ›",
        href,
      }
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

  // Never both, and the choice is the general rule rather than an ordering:
  // of the windows that are open, the NARROWER one wins. On a Saturday
  // morning that is the brief (eleven hours) over the weekly (sixty).
  const open = [
    briefDue ? { kind: "brief" as const, hours: BRIEF_WINDOW_HOURS } : null,
    weeklyDue ? { kind: "weekly" as const, hours: WEEKLY_WINDOW_HOURS } : null,
  ].filter((w): w is { kind: RitualKind; hours: number } => w !== null);
  // Nothing due, or nothing behind what is. Nothing sits there empty.
  if (open.length === 0) return null;
  const winner = open.reduce((a, b) => (b.hours < a.hours ? b : a));

  if (winner.kind === "brief") {
    const done = input.briefProgress.read || input.briefProgress.dismissed;
    if (done) return collapsed("brief", input.briefHref);

    // R5. Before this owner has ever met a brief, the slot stays quiet until
    // Cue has actually watched a night — a fresh instance with nothing
    // connected has no brief to introduce, and Today's not-set-up takeover
    // keeps the screen. `read > 0` is the trigger: intake exists, which is a
    // different and stricter thing than the deck not being empty.
    if (!input.hasSeenBrief) {
      if (!input.intake || input.intake.read <= 0) return null;
      return firstBrief(input, input.intake);
    }
    return openBrief(input, input.brief!);
  }

  const done = input.weeklyProgress.read || input.weeklyProgress.dismissed;
  return done
    ? collapsed("weekly", input.weeklyHref)
    : openWeekly(input, input.weekly!);
}
