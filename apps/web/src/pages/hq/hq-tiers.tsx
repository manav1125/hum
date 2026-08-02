/**
 * The deck's render policy — which slots must speak, and which are allowed to
 * be quiet (v7 §A, brief §9 invariant 11, brief §13.1).
 *
 * The original rule made every K1 module take an `Unavailable` object carrying
 * a required reason, so a module could never go quiet. That was the right
 * instinct behind the wrong mechanism: it conflated two things.
 *
 *   **Honesty requires a lane never be silently absent, and never fake a
 *   number. It does not require a card.**
 *
 * Design measured the deck and found twenty-six cards of chrome around eleven
 * items, so the fix is subtraction — and the tiers were how it stayed honest
 * while subtracting. But applied uniformly, the tiers over-corrected: they
 * produced NINE grey lines on a phone, four of which reported that something
 * which never happened had not happened. §13.1 names the distinction that
 * was missing:
 *
 *   > **A lane answers a standing question. An event either happened or it
 *   > didn't.** The never-silently-absent invariant applies to LANES only. An
 *   > absent event carries no information, so reporting it is noise pretending
 *   > to be honesty.
 *
 * So the roster splits three ways, and the split is in the type system rather
 * than in this comment:
 *
 *   · **Lanes that always hold a card** ({@link Tier1Id}) — Needs you ·
 *     Delivered · Missions. Even at zero: "nothing needs you" deserves space.
 *   · **Lanes that always hold a line** ({@link Tier3Id}) — Arrivals ·
 *     Waiting · Rhythms · Pulse. Four, on every surface. Glyph + full
 *     sentence + link. The honest empty states live here: "Nothing has
 *     arrived — because nothing is watching" is a LINE, not a card.
 *   · **Absorbed lanes** ({@link AbsorbedId}) — In motion · the day · Life.
 *     Still lanes, still standing questions, but the answer is already on
 *     screen in another form ({@link ANSWERED_BY}): the census bar says
 *     "9 doing", the day strip says the day, Life's items sit in needs-you. A
 *     card when there is more to show, nothing when there is not — and a LINE
 *     whenever the lane could not be queried, because absorption can only
 *     stand over an answer we actually have.
 *   · **Events** ({@link EventId}) — the batch offer · the filing correction.
 *     Nobody wonders "was there a batch I missed?". They take the screen when
 *     they happen and are genuinely absent when they don't.
 *
 * ## How the three invariants stay structural rather than conventional
 *
 * **1 · A LANE can never be silently absent.** The deck hands this module an
 * exhaustive `Record<LaneId, LaneSlot>`. TypeScript will not let that object
 * literal omit an id, {@link tier1} is typed to return a card and {@link tier3}
 * a line — narrowly, not as the wider slot union — so neither can be talked
 * into rendering nothing. {@link laneSlotsFor} then proves at runtime that
 * every id landed in exactly one bucket and that no standing lane landed in
 * the absent one.
 *
 * **2 · An EVENT may be absent, and a lane can never be filed as one to make
 * it disappear.** That is the loophole §13.1 opens, and it is closed twice
 * over. The absent slot carries an {@link AbsenceWarrant} — an opaque brand
 * with no literal, minted only inside {@link event} and {@link absorbed},
 * whose `id` parameters admit only {@link EventId} and {@link AbsorbedId}. So
 * `event("waiting", …)` does not type-check, and neither does a hand-written
 * `{ id: "waiting", render: "absent" }`: there is no way to obtain the
 * warrant. And the obvious way around both — moving the id into `EventId` —
 * is itself a compile error for any lane that must speak, because that would
 * put it in `Tier1Id | Tier3Id` and `AbsentSlot["id"]` at once. See
 * `_noSpeakingLaneCanBeAbsent`.
 *
 * **3 · A slot can never render a number it did not query.** A lane's card and
 * its sentence are both written as *functions of the queried payload*
 * ({@link LaneState} `known`). When the lane could not be asked there is no
 * payload, those functions never run, and the fallback is the `unavailable`
 * reason — a sentence with no number in it. For counts that cross lanes (the
 * delivery sentence reads Delivered *and* Needs-you) the number is carried by
 * the opaque {@link Queried} brand, which {@link counted} mints only from a
 * `known` state. `<DeliverySentence delivered={3} …/>` does not type-check.
 * This one applies to events too: an event that happened still cannot invent
 * a count for what happened.
 */

import type { ReactElement, ReactNode } from "react";
import { Link } from "react-router";

import { C, mono } from "./hq-kit";
import { routes } from "@/utils/routes";

// ---------------------------------------------------------------------------
// The lane roster
// ---------------------------------------------------------------------------

export type Tier = 1 | 2 | 3;

/** Always a card, even at zero. */
export type Tier1Id = "needs_you" | "delivered" | "missions";
/**
 * A lane whose standing question is already answered elsewhere on the screen.
 *
 * A card when it has more to say, nothing when it does not — and a line
 * whenever it could not be queried. Which surface answers it is declared in
 * {@link ANSWERED_BY}: absorption is a claim about the screen, so it has to be
 * written down next to the lane making it.
 */
export type AbsorbedId = "in_motion" | "day" | "life";
/**
 * A thing that either happened or didn't. **Deliberately closed.**
 *
 * Widening this union is how a lane would be turned into something allowed to
 * vanish, so it is the one edit that must be conspicuous. Everything else in
 * this module derives from it: {@link SLOT_KIND} is a mapped type over it, and
 * the two builders that can mint an absence take their ids from it.
 */
export type EventId = "batch" | "correction";
/** One grey line, always. */
export type Tier3Id = "arrivals" | "waiting" | "rhythms" | "pulse";
/**
 * What the old middle tier became: absorbed lanes and events.
 *
 * Kept as a name (and in its original order) because it is still the set of
 * slots that render *below* Tier 1 and *above* the rail when they render at
 * all. Nothing in it produces a line any more.
 */
export type Tier2Id = AbsorbedId | EventId;
/**
 * Every id the deck must account for — lanes AND events.
 *
 * The roster is exhaustive on purpose: an event is allowed to render as
 * nothing, but it is never allowed to be *missing from the record*. Its
 * absence is a value ({@link AbsentSlot}), so it can be counted, asserted on,
 * and explained.
 */
export type LaneId = Tier1Id | Tier2Id | Tier3Id;
/** Every id that answers a standing question — i.e. every id that is a LANE. */
export type StandingLaneId = Exclude<LaneId, EventId>;

/**
 * Tier-1 order is the interim HQ order design settled in Q2: needs-you then
 * delivered, reached below the delivery sentence which has already given the
 * receipts. Delivered-first survives in that sentence.
 */
export const TIER1_IDS = ["needs_you", "delivered", "missions"] as const;
export const ABSORBED_IDS = ["in_motion", "day", "life"] as const;
export const EVENT_IDS = ["batch", "correction"] as const;
export const TIER2_IDS = [...ABSORBED_IDS, ...EVENT_IDS] as const;
export const TIER3_IDS = ["arrivals", "waiting", "rhythms", "pulse"] as const;

export const LANE_IDS = [...TIER1_IDS, ...TIER2_IDS, ...TIER3_IDS] as const;

/**
 * Compile-time proof that the ordered tuples above cover the `LaneId` union.
 * Add a lane to the union without adding it to a tier and this stops building —
 * which is the point: a lane that is not in a tier is a lane that renders as
 * nothing.
 */
type Uncovered = Exclude<LaneId, (typeof LANE_IDS)[number]>;
const _everyLaneHasATier: Uncovered extends never ? true : never = true;
void _everyLaneHasATier;

/**
 * Lane or event — derived from {@link EventId}, never declared by hand.
 *
 * `KindOf` is what stops this table from being the loophole: writing
 * `waiting: "event"` is a type error, because the value for each key is
 * computed from the union rather than chosen. The only way to change a slot's
 * kind is to change `EventId`.
 */
export type SlotKind = "lane" | "event";
type KindOf<K extends LaneId> = K extends EventId ? "event" : "lane";

export const SLOT_KIND: { readonly [K in LaneId]: KindOf<K> } = {
  needs_you: "lane",
  delivered: "lane",
  missions: "lane",
  in_motion: "lane",
  day: "lane",
  life: "lane",
  batch: "event",
  correction: "event",
  arrivals: "lane",
  waiting: "lane",
  rhythms: "lane",
  pulse: "lane",
};

/**
 * Where an absorbed lane's standing question is answered instead.
 *
 * This is the price of letting a lane render nothing: you must name the thing
 * on screen that already says it. "In motion" is absorbed only because the
 * census bar states "9 doing" — if that bar ever stops stating it, this table
 * is the record of what broke and where to look.
 */
export const ANSWERED_BY: Record<AbsorbedId, string> = {
  in_motion: "the census bar",
  day: "the day strip",
  life: "the needs-you list",
};

export const LANE_TIER: Record<LaneId, Tier> = {
  needs_you: 1,
  delivered: 1,
  missions: 1,
  in_motion: 2,
  day: 2,
  life: 2,
  batch: 2,
  correction: 2,
  arrivals: 3,
  waiting: 3,
  rhythms: 3,
  pulse: 3,
};

/**
 * The glyph and the door for each lane.
 *
 * Every state carries a glyph — no colour-only state, ever (invariant 10). The
 * glyph is also what makes a one-line lane scannable: at 12.5px grey, the mark
 * is doing more work than the words.
 */
export const LANE_META: Record<
  LaneId,
  { label: string; glyph: string; href: string }
> = {
  needs_you: { label: "Needs you", glyph: "‖", href: routes.reviewQueue },
  delivered: { label: "Delivered", glyph: "✓", href: routes.allWork },
  missions: { label: "Missions", glyph: "◎", href: routes.allWork },
  in_motion: { label: "In motion", glyph: "◉", href: routes.allWork },
  day: { label: "Your day", glyph: "◱", href: routes.allWork },
  life: { label: "Personal", glyph: "⌂", href: routes.allWork },
  batch: { label: "Batching", glyph: "⧉", href: routes.allWork },
  correction: { label: "Filing", glyph: "✨", href: routes.allWork },
  arrivals: { label: "Arrivals", glyph: "↴", href: routes.allWork },
  waiting: { label: "Waiting", glyph: "◷", href: routes.people },
  rhythms: { label: "Rhythms", glyph: "⟳", href: routes.settings.schedules },
  pulse: { label: "Pulse", glyph: "○", href: routes.automations },
};

// ---------------------------------------------------------------------------
// Lane state — queried, or honestly unable to ask
// ---------------------------------------------------------------------------

/** Why a lane has nothing to show. Never rendered as silence. */
export type Unavailable = {
  /** One sentence, specific. "Not connected" — never "no data". */
  reason: string;
  /** Optional route that would fix it. */
  fixHref?: string;
  fixLabel?: string;
};

/**
 * What a lane knows about itself.
 *
 * `known` means we asked and this is the answer — an EMPTY payload is still an
 * answer, and "0 need you" is a real number. `unavailable` means we could not
 * ask, and it carries the sentence that says so. There is deliberately no third
 * variant: "absent" is not a state a lane is allowed to be in.
 */
export type LaneState<T> =
  | { readonly kind: "known"; readonly payload: T }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
      readonly fixHref?: string;
      readonly fixLabel?: string;
    };

export function known<T>(payload: T): LaneState<T> {
  return { kind: "known", payload };
}

export function unavailable<T>(
  reason: string,
  fix?: { href?: string; label?: string },
): LaneState<T> {
  return {
    kind: "unavailable",
    reason,
    fixHref: fix?.href,
    fixLabel: fix?.label,
  };
}

/** Bridge from the existing `Unavailable`-carrying hooks to a lane state. */
export function fromUnavailable<T>(
  payload: T,
  note: Unavailable | undefined,
): LaneState<T> {
  return note
    ? unavailable<T>(note.reason, {
        href: note.fixHref,
        label: note.fixLabel,
      })
    : known(payload);
}

// ---------------------------------------------------------------------------
// A number that was actually queried
// ---------------------------------------------------------------------------

declare const QUERIED: unique symbol;

/**
 * A count that came out of a lane's own answer.
 *
 * Opaque on purpose: there is no literal of this type, so a component that
 * takes a `Queried` cannot be handed a number someone typed. The only way to
 * make one is {@link counted}, which refuses when the lane could not be asked.
 */
export interface Queried {
  readonly [QUERIED]: true;
  readonly value: number;
}

/**
 * Count a lane's own payload — or `null` when the lane could not be asked.
 *
 * The cast is the single place in the codebase that mints a `Queried`, and it
 * is unreachable without a `known` state.
 */
export function counted<T>(
  state: LaneState<T>,
  of: (payload: T) => number,
): Queried | null {
  if (state.kind !== "known") return null;
  return { value: of(state.payload) } as unknown as Queried;
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export interface LaneLine {
  /**
   * A FULL sentence — "Nothing is waiting on anyone." Not a label, not
   * "0 items". Written as a function of the queried payload, which is why a
   * number can only appear here when there was a number to read.
   */
  sentence: string;
  /** Overrides the lane's default link label. */
  linkLabel?: string;
  /** Overrides the lane's default door. */
  href?: string;
  /** `attention` tints the glyph amber — the words still carry the fact. */
  tone?: "muted" | "attention";
}

declare const WARRANT: unique symbol;

/**
 * Permission for a slot to render nothing.
 *
 * Opaque, exactly like {@link Queried} and for the same reason: there is no
 * literal of this type anywhere in the codebase, so an absent slot cannot be
 * written by hand. {@link mintWarrant} is module-private and reachable only
 * through {@link event} and {@link absorbed}, both of which refuse a standing
 * lane's id at compile time. That is the whole mechanism behind "an event may
 * be absent; a lane may not".
 */
export interface AbsenceWarrant {
  readonly [WARRANT]: true;
  /** Why nothing is the honest render. Surfaced in errors, never in the UI. */
  readonly because: string;
}

function mintWarrant(because: string): AbsenceWarrant {
  return { because } as unknown as AbsenceWarrant;
}

export type LaneCardSlot = {
  readonly id: LaneId;
  readonly render: "card";
  readonly node: ReactNode;
};
export type LaneLineSlot = {
  readonly id: LaneId;
  readonly render: "line";
  readonly line: LaneLine;
};
/**
 * Rendered as nothing, on purpose, with a reason.
 *
 * `id` is narrowed to {@link Tier2Id} — the absorbed lanes and the events — so
 * even holding a warrant you could not construct an absent Arrivals. Absence
 * is a *value* rather than a missing key: {@link laneSlotsFor} counts these,
 * and the runtime check that no standing lane is among them is the half of the
 * invariant a cast could otherwise slip past.
 */
export type AbsentSlot = {
  readonly id: Tier2Id;
  readonly render: "absent";
  readonly warrant: AbsenceWarrant;
};

export type LaneSlot = LaneCardSlot | LaneLineSlot | AbsentSlot;

/**
 * A lane that must speak can never be the id of an absence — **checked**.
 *
 * This is the load-bearing half of "a lane cannot be filed as an event to make
 * it disappear". Moving, say, `waiting` into {@link EventId} would let
 * {@link event} accept it, but it would also make `waiting` a member of both
 * `Tier3Id` and `AbsentSlot["id"]`, and this line stops compiling. So the
 * seven ids that must always render — the three cards and the four rail lines
 * — cannot be reclassified at all, in any number of steps. What is left for
 * `EventId` to grow into is genuinely new slots, which is the only case where
 * growing it is honest.
 */
type LaneThatCouldVanish = Extract<Tier1Id | Tier3Id, AbsentSlot["id"]>;
const _noSpeakingLaneCanBeAbsent: LaneThatCouldVanish extends never
  ? true
  : never = true;
void _noSpeakingLaneCanBeAbsent;

/** And a standing lane is exactly a Tier-1, an absorbed, or a Tier-3 lane. */
type StandingUncovered = Exclude<
  StandingLaneId,
  Tier1Id | AbsorbedId | Tier3Id
>;
const _everyStandingLaneIsPlaced: StandingUncovered extends never
  ? true
  : never = true;
void _everyStandingLaneIsPlaced;

/** The line an `unavailable` lane shows: its reason, and the way to fix it. */
function unavailableLine(state: {
  reason: string;
  fixHref?: string;
  fixLabel?: string;
}): LaneLine {
  return {
    sentence: state.reason,
    href: state.fixHref,
    linkLabel: state.fixLabel,
  };
}

/**
 * Tier 1 — always a card.
 *
 * `card` is typed `ReactElement`, not `ReactNode`: `ReactNode` admits `null`,
 * and a Tier-1 builder that can return null is a Tier-1 lane that can vanish.
 * When the lane could not be asked it still gets a card — one that states the
 * reason instead of a number.
 */
export function tier1<T>(
  id: Tier1Id,
  state: LaneState<T>,
  card: (payload: T) => ReactElement,
): LaneCardSlot {
  if (state.kind === "known") {
    return { id, render: "card", node: card(state.payload) };
  }
  return {
    id,
    render: "card",
    node: <UnavailableCard id={id} line={unavailableLine(state)} />,
  };
}

/**
 * An absorbed lane — a card when it has more to say, nothing when it doesn't.
 *
 * `card` returning `null` IS the emptiness test, which keeps "what counts as
 * empty" next to the thing that renders it. Empty does not mean unanswered:
 * {@link ANSWERED_BY} names the surface that already carries this lane's
 * answer, and the warrant quotes it.
 *
 * The one case that still gets a line is `unavailable`. "The census bar
 * already says it" is a claim about an answer we have; when the query failed
 * we have no answer, the absorbing surface has none either, and staying quiet
 * would be the silent absence this module exists to prevent.
 */
export function absorbed<T>(
  id: AbsorbedId,
  state: LaneState<T>,
  card: (payload: T) => ReactElement | null,
): LaneCardSlot | LaneLineSlot | AbsentSlot {
  if (state.kind !== "known") {
    return { id, render: "line", line: unavailableLine(state) };
  }
  const node = card(state.payload);
  if (node == null) {
    return {
      id,
      render: "absent",
      warrant: mintWarrant(`answered by ${ANSWERED_BY[id]}`),
    };
  }
  return { id, render: "card", node };
}

/**
 * An event — the screen when it happened, nothing when it didn't.
 *
 * Note the return type: `LaneCardSlot | AbsentSlot`, with no line in it. An
 * event has no quiet state to report, so "the batch offer isn't built yet" and
 * "there was no batch today" render identically — as nothing. That is not the
 * `unavailable` sentence going missing; it is §13.1's point that an absent
 * event carries no information.
 */
export function event<T>(
  id: EventId,
  state: LaneState<T>,
  card: (payload: T) => ReactElement | null,
): LaneCardSlot | AbsentSlot {
  const node = state.kind === "known" ? card(state.payload) : null;
  if (node == null) {
    return {
      id,
      render: "absent",
      warrant: mintWarrant(
        state.kind === "known" ? "it didn't happen" : state.reason,
      ),
    };
  }
  return { id, render: "card", node };
}

/**
 * The old Tier-2 builder, kept so the desktop deck keeps compiling while its
 * call sites move over.
 *
 * It dispatches on the id — the only thing it can honestly do now, since
 * §13.1 assigns each former Tier-2 id to {@link absorbed} or {@link event} and
 * neither of those produces a line for an empty slot. `line` is therefore no
 * longer read.
 *
 * @deprecated Call {@link absorbed} or {@link event} directly. The `line`
 * argument is ignored: an absorbed lane's empty state is carried by the
 * surface that absorbed it, and an event has no empty state to carry.
 */
export function tier2<T>(
  id: Tier2Id,
  state: LaneState<T>,
  card: (payload: T) => ReactElement | null,
  line?: (payload: T) => LaneLine,
): LaneSlot {
  void line;
  return isEventId(id) ? event(id, state, card) : absorbed(id, state, card);
}

function isEventId(id: Tier2Id): id is EventId {
  return SLOT_KIND[id] === "event";
}

/**
 * Tier 3 — one grey line, always.
 *
 * Returns `LaneLineSlot`, not the wider slot union: these four are the lanes
 * that carry the deck's standing questions, and a builder that could return an
 * absence is a lane that could go quiet. It cannot, so it does not.
 */
export function tier3<T>(
  id: Tier3Id,
  state: LaneState<T>,
  line: (payload: T) => LaneLine,
): LaneLineSlot {
  if (state.kind !== "known") {
    return { id, render: "line", line: unavailableLine(state) };
  }
  return { id, render: "line", line: line(state.payload) };
}

/**
 * Split the deck into what renders where, and prove nothing was lost.
 *
 * The checks are not decoration. They are the runtime half of the two
 * invariants, and they fire in tests long before they could ship:
 *
 *   · every id landed in exactly one bucket — nothing fell out of the roster;
 *   · a Tier-1 lane is a card and a Tier-3 lane is a line — the builders
 *     already guarantee this by return type, so a violation here means someone
 *     cast their way around them;
 *   · **no standing lane is absent.** Events and absorbed lanes may be; a lane
 *     that answers a standing question on its own may not, whatever warrant it
 *     somehow acquired.
 */
export function laneSlotsFor(lanes: Record<LaneId, LaneSlot>): {
  cards: LaneCardSlot[];
  lines: LaneLineSlot[];
  absent: AbsentSlot[];
} {
  const cards: LaneCardSlot[] = [];
  const lines: LaneLineSlot[] = [];
  const absent: AbsentSlot[] = [];
  for (const id of LANE_IDS) {
    const slot = lanes[id];
    if (slot.render === "card") cards.push(slot);
    else if (slot.render === "line") lines.push(slot);
    else absent.push(slot);
    if (LANE_TIER[id] === 1 && slot.render !== "card") {
      throw new Error(`Tier-1 lane '${id}' rendered as ${slot.render}.`);
    }
    if (LANE_TIER[id] === 3 && slot.render !== "line") {
      throw new Error(`Tier-3 lane '${id}' rendered as ${slot.render}.`);
    }
  }
  if (cards.length + lines.length + absent.length !== LANE_IDS.length) {
    throw new Error("A slot rendered as none of card, line or absent.");
  }
  for (const slot of absent) {
    if (SLOT_KIND[slot.id] === "event") continue;
    if ((ABSORBED_IDS as readonly string[]).includes(slot.id)) continue;
    throw new Error(
      `Lane '${slot.id}' went silently absent — only events and absorbed lanes may.`,
    );
  }
  return { cards, lines, absent };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The Tier-1 card a lane shows when it could not be asked. Never a number. */
function UnavailableCard({ id, line }: { id: LaneId; line: LaneLine }) {
  const meta = LANE_META[id];
  return (
    <section
      data-slot={`hq-lane-unavailable-${id}`}
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        padding: "14px 16px",
        background: C.surface,
      }}
    >
      <div
        style={{
          fontFamily: mono,
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--hq-muted)",
        }}
      >
        {meta.glyph} {meta.label}
      </div>
      <div
        style={{
          fontSize: 13,
          color: C.t2,
          marginTop: 7,
          lineHeight: 1.5,
        }}
      >
        {line.sentence}
        {line.href ? (
          <>
            {" "}
            <Link
              to={line.href}
              style={{ color: C.blueText, textDecoration: "none" }}
            >
              {line.linkLabel ?? "Set it up"} ›
            </Link>
          </>
        ) : null}
      </div>
    </section>
  );
}

/** One Tier-3 line: glyph + full sentence + link. */
export function TierLine({ id, line }: { id: LaneId; line: LaneLine }) {
  const meta = LANE_META[id];
  const href = line.href ?? meta.href;
  return (
    <div
      data-lane={id}
      data-slot="hq-tier-line"
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 10,
        padding: "6px 0",
        // #5B5B68 is never a text colour (2.5:1 on our dark grounds). This var
        // is #6B6B60 light / #9A9AA8 dark — see `HqStyle`.
        color: "var(--hq-muted)",
        fontSize: 12.5,
        lineHeight: 1.5,
      }}
    >
      <span
        aria-hidden
        style={{
          fontFamily: mono,
          fontSize: 12,
          width: 13,
          flexShrink: 0,
          color: line.tone === "attention" ? C.amberText : "var(--hq-muted)",
        }}
      >
        {meta.glyph}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>{line.sentence}</span>
      <Link
        to={href}
        style={{
          fontFamily: mono,
          fontSize: 11,
          color: "var(--hq-muted)",
          textDecoration: "none",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {line.linkLabel ?? meta.label} ›
      </Link>
    </div>
  );
}

/**
 * The cards, in the given order.
 *
 * A lane missing from `ids` is not omitted from the deck — it is a line, and
 * {@link TierRail} renders every line. A slot that is *absent* renders nowhere
 * by design: it is an event that didn't happen, or a lane whose answer is
 * already on the screen in another form.
 */
export function LaneCards({
  lanes,
  ids,
  gap = 26,
}: {
  lanes: Record<LaneId, LaneSlot>;
  ids: readonly LaneId[];
  gap?: number;
}) {
  const cards = ids
    .map((id) => lanes[id])
    .filter((slot): slot is LaneCardSlot =>
      Boolean(slot && slot.render === "card"),
    );
  if (cards.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {cards.map((slot) => (
        <div key={slot.id} data-lane={slot.id}>
          {slot.node}
        </div>
      ))}
    </div>
  );
}

/**
 * The rail — **four lines**: Arrivals, Waiting, Rhythms, Pulse.
 *
 * It used to be four plus every empty Tier 2, which is how a quiet account
 * produced nine grey lines saying nothing had happened. Under §13.1 the
 * absorbed lanes and the events no longer demote here; the only way anything
 * else joins the four is an absorbed lane we could not query, which says so.
 *
 * Arrivals, Waiting, Rhythms and Pulse are lines whatever happens, so the rail
 * is never empty and a lane can never disappear by falling out of the bottom
 * of it.
 */
export function TierRail({ lanes }: { lanes: Record<LaneId, LaneSlot> }) {
  const order: readonly LaneId[] = [...TIER3_IDS, ...TIER2_IDS, ...TIER1_IDS];
  const lines = order
    .map((id) => lanes[id])
    .filter((slot): slot is LaneLineSlot =>
      Boolean(slot && slot.render === "line"),
    );
  if (lines.length === 0) return null;
  return (
    <section
      data-slot="hq-tier-rail"
      style={{
        marginTop: 26,
        paddingTop: 12,
        borderTop: `1px solid ${C.line}`,
      }}
    >
      {lines.map((slot) => (
        <TierLine key={slot.id} id={slot.id} line={slot.line} />
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The delivery sentence (brief §7 step 1, Q2)
// ---------------------------------------------------------------------------

/**
 * "While you slept: 3 done, 2 need you" — one line, above everything.
 *
 * A strict subset of the landing surface that ships later: no new data, no new
 * screen. It reads what the deck already queried, which is why both counts are
 * {@link Queried} — a lane we could not ask contributes nothing to the sentence
 * rather than a zero, because a zero here would be a claim.
 *
 * When the landing surface lands, this line lifts out of HQ and becomes the
 * door.
 */
export function deliverySentence(
  delivered: Queried | null,
  needsYou: Queried | null,
  /** Hoisted by the caller — reading the clock in render is impure. */
  hour: number,
): string {
  const lead = hour < 12 ? "While you slept" : "Today so far";
  const d = delivered?.value ?? null;
  const n = needsYou?.value ?? null;

  if (d == null && n == null) return "I couldn't read your work just now.";
  if (d == null) {
    return n === 0
      ? "Nothing needs you."
      : `${n} ${n === 1 ? "thing needs" : "things need"} you.`;
  }
  if (d === 0) {
    // First person, and the obligation is not the headline. "Nothing has
    // finished yet — 13 need you" opens the product on an accusation, which is
    // the inbox feeling the delivered-first rule exists to remove. Owning the
    // empty result is honest; leading with the reader's debt is not.
    if (n == null) return "I haven't finished anything yet.";
    return n === 0
      ? "Nothing needs you. I'll bring you something when it lands."
      : `I haven't finished anything yet — ${n} still ${n === 1 ? "needs" : "need"} you.`;
  }
  const done = `${lead}: ${d} done`;
  if (n == null) return `${done}.`;
  return n === 0 ? `${done}. Nothing needs you.` : `${done}, ${n} need you.`;
}

export function DeliverySentence({
  delivered,
  needsYou,
  hour,
}: {
  delivered: Queried | null;
  needsYou: Queried | null;
  hour: number;
}) {
  return (
    <div
      data-slot="hq-delivery-sentence"
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 9,
        fontSize: 14,
        color: C.t2,
        lineHeight: 1.5,
      }}
    >
      <span aria-hidden style={{ color: C.green, fontSize: 13 }}>
        ✓
      </span>
      <span>{deliverySentence(delivered, needsYou, hour)}</span>
    </div>
  );
}
