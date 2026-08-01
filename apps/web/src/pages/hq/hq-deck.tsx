/**
 * The canonical HQ deck modules — delivered, needs-you, census and pulse.
 *
 * Built to `01-work-surfaces/canonical/cue-canonical.html` (K1) and the
 * addendum's A2 interim frame. The reading order in `PulseLayout` is the spec
 * and is load-bearing:
 *
 *   0 greeting (states DELIVERY) · 1 capture bar · 2 day rail · 3 missions+Life
 *   4 DELIVERED · 5 needs-you (capped) · 6 census · 7 agents/waiting/came-in
 *   8 pulse
 *
 * The one rule everything else follows from: **value before cost**. A headline
 * of "3 things need you" makes Cue read as another inbox — every competitor
 * opens with your obligations. Ours opens with our receipts. So `Delivered`
 * renders above `NeedsYou` on every surface that shows both.
 *
 * Two invariants are enforced here rather than left to the caller:
 *   · **The deck never grows.** Needs-you caps at `NEEDS_YOU_CAP` and shows
 *     "N of M" with a door to triage. At 31 open items or 300, only the census
 *     numbers move.
 *   · **Never a fake number.** Every count rendered is one the caller actually
 *     queried. Segments whose data does not exist yet (handed off, waiting,
 *     life) are omitted entirely rather than shown as zero — a zero reads as
 *     "none", which is a claim we cannot make.
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
 * "While you slept · Cue delivered" — the first thing on the deck.
 *
 * Renders nothing when there is nothing delivered: an empty receipts block
 * would be a worse opening than none. The caller decides what follows.
 */
export function DeliveredBlock({
  items,
  onOpen,
}: {
  items: { id: string; title: string }[];
  onOpen?: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section data-slot="hq-delivered" style={{ marginTop: 30 }}>
      <div
        style={{ display: "flex", alignItems: "baseline", gap: 10 }}
      >
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
  const shown = segments.filter((s) => s.value > 0);
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
// Pulse
// ---------------------------------------------------------------------------

/**
 * The pulse strip — what Cue is watching on your behalf.
 *
 * `sourceCount === 0` is the addendum's A2 interim copy, and it is deliberately
 * blunt: the product currently watches nothing, and saying "all quiet" would be
 * a lie of omission. It states the fact and names the reason.
 */
export function PulseStrip({
  sourceCount,
  checkCount,
  lastCheckLabel,
}: {
  sourceCount: number;
  checkCount: number | null;
  lastCheckLabel: string | null;
}) {
  const watching = sourceCount > 0;
  return (
    <div
      data-slot="hq-pulse"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginTop: 18,
        fontFamily: mono,
        fontSize: 11,
        color: C.t3,
        lineHeight: 1.5,
      }}
    >
      <span aria-hidden style={{ opacity: watching ? 1 : 0.5 }}>
        {watching ? "◉" : "○"}
      </span>
      <span>
        {watching
          ? [
              `Watching ${sourceCount} ${sourceCount === 1 ? "source" : "sources"}`,
              lastCheckLabel ? `checked ${lastCheckLabel}` : null,
              checkCount != null
                ? `${checkCount.toLocaleString()} checks`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")
          : checkCount != null
            ? `Watching nothing · the heartbeat has run ${checkCount.toLocaleString()} times with nothing to check`
            : "Watching nothing yet"}
      </span>
    </div>
  );
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
      ? { accent: C.blue, glyph: "👁", ground: `color-mix(in srgb, ${C.blue} 5%, ${C.surface})` }
      : kind === "broken"
        ? { accent: C.amber, glyph: "!", ground: `color-mix(in srgb, ${C.amber} 6%, ${C.surface})` }
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

// ---------------------------------------------------------------------------
// Arrivals digest (§9)
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
 * "Came in" as ONE row, whatever the volume.
 *
 * The rule this exists to enforce (§9): *40 Monday arrivals must not become 40
 * cards.* Rendering arrivals as a list is what turns a chief of staff back into
 * an inbox — it hands the user the entire pile and calls it surfacing. The
 * digest says what Cue DID with the pile, and the only number that asks for
 * attention is the one Cue was genuinely unsure about.
 *
 * `filed` and `kept` are the honest split: filed means Cue chose a home and can
 * name it; kept means it scored the item and declined to guess. Anything not in
 * either bucket is still in flight and is deliberately not implied to be
 * handled — which is why the two numbers are shown rather than a single
 * "processed" count.
 */
export function ArrivalsDigest({
  summary,
  onExpand,
}: {
  summary: ArrivalsSummary;
  onExpand?: () => void;
}) {
  if (summary.total === 0) return null;
  const { total, filed, kept } = summary;
  return (
    <div
      data-slot="hq-arrivals-digest"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        marginTop: 12,
        padding: "13px 15px",
        border: `1px solid ${C.line}`,
        borderRadius: 13,
        background: C.surface,
      }}
    >
      <span aria-hidden style={{ color: C.blue, fontSize: 14 }}>
        ↴
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13.5, color: C.ink }}>
          {total} arrived — Cue filed {filed}
          {kept > 0 ? `, kept ${kept} for you` : ""}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: C.t3,
            marginTop: 3,
            fontFamily: mono,
          }}
        >
          {kept > 0
            ? `${kept} ${kept === 1 ? "needs" : "need"} a decision · nothing lost`
            : "nothing needs you · nothing lost"}
        </div>
      </div>
      {onExpand ? (
        <button
          type="button"
          onClick={onExpand}
          style={{
            border: "none",
            background: "none",
            padding: 0,
            fontSize: 11.5,
            fontFamily: mono,
            color: C.t3,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          Where it went ›
        </button>
      ) : null}
    </div>
  );
}
