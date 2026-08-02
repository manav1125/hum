/**
 * The canonical HQ deck modules — delivered, census, the honest empty states,
 * and the sentences behind the Tier-3 arrivals and pulse lines.
 *
 * Built to `01-work-surfaces/canonical/cue-canonical.html` (K1), the addendum's
 * A2 interim frame, and v7 §A. The reading order lives in `HqDeck`
 * (`hq-page.tsx`) and is the interim order design settled in Q2:
 *
 *   delivery sentence · composer · needs-you · delivered · the rest per v7
 *
 * The one rule everything else follows from: **value before cost**. A headline
 * of "3 things need you" makes Cue read as another inbox — every competitor
 * opens with your obligations. Ours opens with our receipts. Needs-you leads
 * the CARDS, but only because the delivery sentence one line above has already
 * given the receipts (invariant 1's stated exception).
 *
 * Two invariants are enforced here rather than left to the caller:
 *   · **The deck never grows.** Needs-you caps at `NEEDS_YOU_CAP` and shows
 *     "N of M" with a door to triage. At 31 open items or 300, only the census
 *     numbers move.
 *   · **Never a fake number.** Every count rendered is one the caller actually
 *     queried. Segments whose data does not exist yet (handed off, waiting,
 *     life) are omitted entirely rather than shown as zero — a zero reads as
 *     "none", which is a claim we cannot make. The counts that cross lanes ride
 *     `Queried` from `./hq-tiers`, which cannot be minted from a literal.
 *
 * What used to be a card here and is now one grey line: arrivals and pulse. See
 * `./hq-tiers` for why — honesty lives in the statement, not the card.
 */

import type { ReactNode } from "react";
import { Link } from "react-router";

import { C, MicroLabel, mono } from "./hq-kit";
import { routes } from "@/utils/routes";

/** Needs-you never renders more rows than this. See "the deck never grows". */
export const NEEDS_YOU_CAP = 3;

// ---------------------------------------------------------------------------
// Delivered
// ---------------------------------------------------------------------------

/**
 * "While you slept · Cue delivered" — Cue's receipts.
 *
 * **Tier 1: this renders a card even at zero.** It used to return null on an
 * empty list, on the reasoning that an empty receipts block is a worse opening
 * than none. That was true when Delivered opened the deck; it is not true now
 * that the delivery sentence carries the opening. An absent Delivered lane is
 * indistinguishable from a Delivered lane we failed to query, and "I haven't
 * finished anything yet today" is a fact worth stating in Cue's own voice.
 */
export function DeliveredBlock({
  items,
  onOpen,
}: {
  items: { id: string; title: string }[];
  onOpen?: (id: string) => void;
}) {
  if (items.length === 0) {
    return (
      <section data-slot="hq-delivered" style={{ marginTop: 0 }}>
        <MicroLabel color={C.green}>Delivered</MicroLabel>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 9,
            marginTop: 10,
            fontSize: 13,
            color: C.t2,
          }}
        >
          <span aria-hidden style={{ color: C.t3 }}>
            ○
          </span>
          <span>I haven&rsquo;t finished anything for you yet today.</span>
        </div>
      </section>
    );
  }
  return (
    <section data-slot="hq-delivered">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <MicroLabel color={C.green}>While you slept · Cue delivered</MicroLabel>
        <Link
          to={routes.allWork}
          style={{
            marginLeft: "auto",
            fontSize: 11.5,
            color: C.t3,
            textDecoration: "none",
            fontFamily: mono,
          }}
        >
          This week ›
        </Link>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 7,
          marginTop: 12,
        }}
      >
        {items.slice(0, 4).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onOpen?.(item.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              textAlign: "left",
              background: "none",
              border: "none",
              padding: 0,
              cursor: onOpen ? "pointer" : "default",
              font: "inherit",
            }}
          >
            {/* Glyph, not colour alone — see the no-colour-only-state rule. */}
            <span aria-hidden style={{ color: C.green, fontSize: 13 }}>
              ✓
            </span>
            <span
              style={{
                fontSize: 13.5,
                color: C.t1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {item.title}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Census
// ---------------------------------------------------------------------------

export interface CensusSegment {
  /**
   * Show this segment even at zero.
   *
   * Set it when the segment is what ANSWERS a lane that has gone silent. Under
   * the lanes-vs-events rule, in-motion no longer takes a Tier-3 line because
   * "9 doing" in the census already answers "is anything running?" — but if the
   * census then drops the segment at zero, the question goes unanswered on the
   * entire screen and a busy account and an idle one look identical.
   *
   * A zero is normally a claim we will not make (see the file header). This is
   * the exception, and it is narrow: only a segment that has taken over another
   * lane's job has to keep speaking when the answer is none.
   */
  keep?: boolean;
  label: string;
  value: number;
}

/**
 * The honest count, and the door to the ledger.
 *
 * Takes segments already computed by the caller so this component can never
 * invent one. Callers pass only what they queried: a segment the product
 * cannot yet answer (handed off, waiting on people, life) must be absent, not
 * zero.
 */
export function CensusBar({ segments }: { segments: CensusSegment[] }) {
  const shown = segments.filter((s) => s.value > 0 || s.keep);
  if (shown.length === 0) return null;
  return (
    <div
      data-slot="hq-census"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        marginTop: 26,
        paddingTop: 14,
        borderTop: `1px solid ${C.line}`,
        fontFamily: mono,
        fontSize: 11.5,
        color: C.t3,
      }}
    >
      <span>
        {shown.map((s, i) => (
          <span key={s.label}>
            {i > 0 ? " · " : ""}
            <span style={{ color: C.t2 }}>{s.value}</span> {s.label}
          </span>
        ))}
      </span>
      <Link
        to={routes.allWork}
        style={{
          marginLeft: "auto",
          color: C.t3,
          textDecoration: "none",
        }}
      >
        All work ›
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pulse — a Tier-3 line (v7 §A)
// ---------------------------------------------------------------------------

/**
 * What Cue is watching on your behalf, as one sentence.
 *
 * `sourceCount === 0` is the addendum's A2 interim copy, and it is deliberately
 * blunt: the product currently watches nothing, and saying "all quiet" would be
 * a lie of omission. It states the fact and names the reason — with the check
 * count as the evidence that Cue has in fact been running the whole time.
 *
 * Every number here is an argument, so the caller cannot get one from anywhere
 * but the query that produced it; `checkCount === null` prints no number rather
 * than a zero, because a zero would claim the heartbeat never ran.
 */
export function pulseSentence(
  sourceCount: number,
  checkCount: number | null,
  lastCheckLabel: string | null,
): string {
  if (sourceCount > 0) {
    return [
      `Watching ${sourceCount} ${sourceCount === 1 ? "source" : "sources"}`,
      lastCheckLabel ? `checked ${lastCheckLabel}` : null,
      checkCount != null ? `${checkCount.toLocaleString()} checks` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return checkCount != null
    ? `Watching nothing — the heartbeat has run ${checkCount.toLocaleString()} times with nothing to check.`
    : "Watching nothing yet.";
}

// ---------------------------------------------------------------------------
// Arrivals — a Tier-3 line (v7 §A)
// ---------------------------------------------------------------------------

export interface ArrivalsSummary {
  /** Everything that arrived on its own. */
  total: number;
  /** Auto-filed onto a mission or project, with provenance. */
  filed: number;
  /** Scored but below confidence — Cue refused to guess. These need a human. */
  kept: number;
}

/**
 * "Came in" as ONE line, whatever the volume (§9).
 *
 * The rule this exists to enforce: *40 Monday arrivals must not become 40
 * cards.* Rendering arrivals as a list is what turns a chief of staff back into
 * an inbox — it hands the user the entire pile and calls it surfacing. The
 * digest says what Cue DID with the pile, and the only number that asks for
 * attention is the one Cue was genuinely unsure about.
 *
 * v7 demotes even the digest card to a Tier-3 line: at eleven items the card
 * was chrome around a sentence. The sentence is unchanged.
 *
 * `filed` and `kept` are the honest split: filed means Cue chose a home and can
 * name it; kept means it scored the item and declined to guess. Anything in
 * neither bucket is still in flight and is deliberately not implied to be
 * handled — which is why two numbers are shown rather than one "processed".
 */
export function arrivalsSentence(summary: ArrivalsSummary): string {
  const { total, filed, kept } = summary;
  if (total === 0) {
    // A no-op is not a success: "nothing arrived" alone reads as a calm inbox
    // when the truth is that observation is switched off.
    return "Nothing has arrived — because nothing is watching, not because it's quiet.";
  }
  // First person for Cue's own actions (§6.2) — "Cue filed" is the passive
  // voice products hide in, and this is a claim about what Cue did.
  //
  // "kept for you" deliberately no longer says "need a decision". That set is
  // NOT the needs-you set, and the deck was showing both on one screen: a
  // headline of "13 need you" above a line reading "180 need a decision". Both
  // numbers were true and measuring different things, which to a reader is
  // simply a contradiction. Only the needs-you set gets the word "need"
  // (invariant 2 — one definition, shared by badge, headline and rows).
  const did = `${total} arrived — I filed ${filed}${kept > 0 ? `, kept ${kept} for you` : ""}`;
  return kept > 0
    ? `${did}. ${kept === 1 ? "It's" : "They're"} in the lane, nothing lost.`
    : `${did} · nothing lost.`;
}

// ---------------------------------------------------------------------------
// Honest empty states (§14 — three kinds, three treatments)
// ---------------------------------------------------------------------------

export type EmptyKind = "not_set_up" | "nothing_yet" | "broken";

/**
 * One empty state, three treatments — never a single generic shrug.
 *
 * · `not_set_up` — blue, actionable, owns the screen. This is the state the
 *   product is actually in today, and its sentence is the most important one on
 *   the surface: "Cue can see your inbox — but it isn't watching it."
 * · `nothing_yet` — grey, and refuses to imply quiet. "Nothing has arrived"
 *   without "because nothing is watching" tells the user the system is calm
 *   when it is in fact switched off.
 * · `broken` — amber, and NAMED. "Something went wrong" is not a state; "718
 *   memory jobs found nothing" is.
 */
export function EmptyState({
  kind,
  title,
  body,
  action,
}: {
  kind: EmptyKind;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  const tone =
    kind === "not_set_up"
      ? {
          accent: C.blue,
          glyph: "👁",
          ground: `color-mix(in srgb, ${C.blue} 5%, ${C.surface})`,
        }
      : kind === "broken"
        ? {
            accent: C.amber,
            glyph: "!",
            ground: `color-mix(in srgb, ${C.amber} 6%, ${C.surface})`,
          }
        : { accent: C.t3, glyph: "↴", ground: C.surface };
  return (
    <div
      data-slot={`hq-empty-${kind}`}
      style={{
        border: `1px solid ${kind === "nothing_yet" ? C.line : `color-mix(in srgb, ${tone.accent} 28%, ${C.line})`}`,
        background: tone.ground,
        borderRadius: 14,
        padding: 16,
        marginTop: 12,
      }}
    >
      <div style={{ display: "flex", gap: 11 }}>
        <span aria-hidden style={{ color: tone.accent, fontSize: 15 }}>
          {tone.glyph}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>
            {title}
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: C.t2,
              marginTop: 5,
              lineHeight: 1.5,
            }}
          >
            {body}
          </div>
          {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
        </div>
      </div>
    </div>
  );
}
