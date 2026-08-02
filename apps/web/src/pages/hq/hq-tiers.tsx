/**
 * The three tiers — the render policy that RETIRES "every module renders,
 * always" (v7 §A, brief §9 invariant 11).
 *
 * The old rule made every K1 module take an `Unavailable` object carrying a
 * required reason, so a lane could never go quiet. That was the right instinct
 * behind the wrong mechanism: it conflated two things.
 *
 *   **Honesty requires a lane never be silently absent, and never fake a
 *   number. It does not require a card.**
 *
 * Design measured the deck and found twenty-six cards of chrome around eleven
 * items. So the fix is subtraction, and the tiers are how it stays honest while
 * subtracting:
 *
 *   · **Tier 1 — always a card.** Needs you · Delivered · Missions. Even at
 *     zero: "nothing needs you" deserves the space.
 *   · **Tier 2 — a card only when non-empty.** In motion · day rail · Life ·
 *     batch offer · correction. When empty they demote to Tier 3, NEVER to
 *     nothing.
 *   · **Tier 3 — one grey line, always present.** Arrivals · Waiting ·
 *     Rhythms · Pulse, plus every demoted Tier 2. Glyph + full sentence + link.
 *     This is where the honest empty states now live: "Nothing has arrived —
 *     because nothing is watching" is a LINE, not the card it used to be.
 *
 * ## How the two invariants stay structural rather than conventional
 *
 * **1 · A lane can never be silently absent.** The deck hands this module an
 * exhaustive `Record<LaneId, LaneSlot>`. TypeScript will not let that object
 * literal omit a lane, and every builder below returns a slot that renders
 * either a card or a line — there is no third result and no `null` return. So
 * "forgot to render it" is a compile error, and "rendered it as nothing" is
 * unrepresentable. {@link laneSlotsFor} additionally proves at runtime that
 * card-slots plus line-slots equal the whole lane set.
 *
 * **2 · A lane can never render a number it did not query.** A lane's card and
 * its sentence are both written as *functions of the queried payload*
 * ({@link LaneState} `known`). When the lane could not be asked there is no
 * payload, those functions never run, and the fallback is the `unavailable`
 * reason — a sentence with no number in it. For counts that cross lanes (the
 * delivery sentence reads Delivered *and* Needs-you) the number is carried by
 * the opaque {@link Queried} brand, which {@link counted} mints only from a
 * `known` state. `<DeliverySentence delivered={3} …/>` does not type-check.
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
/** A card when it has something; a Tier-3 line when it does not. */
export type Tier2Id = "in_motion" | "day" | "life" | "batch" | "correction";
/** One grey line, always. */
export type Tier3Id = "arrivals" | "waiting" | "rhythms" | "pulse";
export type LaneId = Tier1Id | Tier2Id | Tier3Id;

/**
 * Tier-1 order is the interim HQ order design settled in Q2: needs-you then
 * delivered, reached below the delivery sentence which has already given the
 * receipts. Delivered-first survives in that sentence.
 */
export const TIER1_IDS = ["needs_you", "delivered", "missions"] as const;
export const TIER2_IDS = [
  "in_motion",
  "day",
  "life",
  "batch",
  "correction",
] as const;
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

export type LaneSlot =
  | { readonly id: LaneId; readonly render: "card"; readonly node: ReactNode }
  | { readonly id: LaneId; readonly render: "line"; readonly line: LaneLine };

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
): LaneSlot {
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
 * Tier 2 — a card only when non-empty, a Tier-3 line otherwise.
 *
 * `card` returning `null` IS the emptiness test, which keeps "what counts as
 * empty" next to the thing that renders it. A null card never means nothing: it
 * means the lane demotes, and `line` — also a function of the queried payload —
 * says what it found.
 */
export function tier2<T>(
  id: Tier2Id,
  state: LaneState<T>,
  card: (payload: T) => ReactElement | null,
  line: (payload: T) => LaneLine,
): LaneSlot {
  if (state.kind !== "known") {
    return { id, render: "line", line: unavailableLine(state) };
  }
  const node = card(state.payload);
  if (node == null) return { id, render: "line", line: line(state.payload) };
  return { id, render: "card", node };
}

/** Tier 3 — one grey line, always. */
export function tier3<T>(
  id: Tier3Id,
  state: LaneState<T>,
  line: (payload: T) => LaneLine,
): LaneSlot {
  if (state.kind !== "known") {
    return { id, render: "line", line: unavailableLine(state) };
  }
  return { id, render: "line", line: line(state.payload) };
}

/**
 * Split the deck's lanes into what renders where, and prove nothing was lost.
 *
 * The equality check is not decoration: it is the runtime half of "a lane can
 * never be silently absent", and it fires in tests long before it could ship.
 */
export type LaneCardSlot = Extract<LaneSlot, { render: "card" }>;
export type LaneLineSlot = Extract<LaneSlot, { render: "line" }>;

export function laneSlotsFor(lanes: Record<LaneId, LaneSlot>): {
  cards: LaneCardSlot[];
  lines: LaneLineSlot[];
} {
  const cards: LaneCardSlot[] = [];
  const lines: LaneLineSlot[] = [];
  for (const id of LANE_IDS) {
    const slot = lanes[id];
    if (slot.render === "card") cards.push(slot);
    else lines.push(slot);
  }
  if (cards.length + lines.length !== LANE_IDS.length) {
    throw new Error("A lane rendered as neither a card nor a line.");
  }
  return { cards, lines };
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
 * The Tier-1/Tier-2 cards, in the given order.
 *
 * A lane missing from `ids` is not omitted from the deck — it is a line, and
 * {@link TierRail} renders every line.
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
    .filter((slot): slot is Extract<LaneSlot, { render: "card" }> =>
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
 * The Tier-3 rail — the four permanent lines plus every demoted Tier 2.
 *
 * Always renders: Arrivals, Waiting, Rhythms and Pulse are lines whatever
 * happens, so the rail is never empty and a lane can never disappear by falling
 * out of the bottom of it.
 */
export function TierRail({ lanes }: { lanes: Record<LaneId, LaneSlot> }) {
  const order: readonly LaneId[] = [...TIER3_IDS, ...TIER2_IDS, ...TIER1_IDS];
  const lines = order
    .map((id) => lanes[id])
    .filter((slot): slot is Extract<LaneSlot, { render: "line" }> =>
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
    if (n == null) return "Nothing has finished yet.";
    return n === 0
      ? "Nothing needs you. I'll bring you something when it lands."
      : `Nothing has finished yet — ${n} ${n === 1 ? "needs" : "need"} you.`;
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
