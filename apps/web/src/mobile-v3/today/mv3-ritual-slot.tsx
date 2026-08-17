/**
 * The ritual slot — one component, three faces, at the top of Today above the
 * ring (design v43 R1; values read off `cue-mobile-rituals.html`'s frames).
 *
 * ## What this fixes
 *
 * The Morning Brief and the Weekly review are both finished, data-bound
 * surfaces. Between them they had one entrance: an iOS push, for the brief
 * only. The weekly had none at all. Design's ruling is that the fix is not a
 * menu row — *a menu has no sense of time*, and in ⋯ they would be eleventh
 * and twelfth in an alphabetical list, linked and still dark. A ritual needs a
 * door that appears when the ritual is due.
 *
 * ## The rules the styling encodes
 *
 * **Brand blue, on both faces.** The tint, the border, the microlabel and the
 * button are the same on the brief and the weekly, because *a ritual being due
 * is an invitation, not a state*. Blue on both is also what proves they are one
 * component; the dated label and the sentence carry the difference, not the
 * hue. The only colour that changes anything here is amber, and it is spent on
 * "one needs you before 10:30" — a fact about work, not about the ritual.
 *
 * **The serif sentence is the content.** It is the same fact the push carries
 * (see `ritual-slot.ts`, `briefFactsFrom`), which is what makes the push and
 * this card one door rather than two.
 *
 * **Later is not gone.** It collapses to the one-row form, which still opens
 * the surface. A ritual you have done stops asking; it does not disappear
 * mid-morning and leave you wondering whether you imagined it.
 *
 * **A brief with nothing in it still has a face (R3).** The all-quiet card
 * drops the primary verb — there is nothing to read, so the sentence is the
 * brief — and says what was watched instead, because "6 sources, no movement"
 * is the whole difference between a quiet night and a broken pipeline.
 *
 * **And the first one says so (R5).** One morning, once, the card wears the
 * heavier border and reports what a night of watching actually produced.
 *
 * Anything this component cannot say honestly, it does not render at all —
 * `useRitualSlot` returns `null` and nothing sits at the top of Today. See
 * `ritual-slot.ts` for that decision; it is the whole reason this is a
 * component and not a nav entry.
 */
import { useNavigate } from "react-router";

import { haptic } from "@/utils/haptics";

import { mv3Mono } from "../mv3-kit";
import { dismissRitual, markRitualRead } from "./ritual-progress";
import type { RitualFace } from "./ritual-slot";

const serif = "'Instrument Serif', Georgia, serif";

/**
 * The blue wash is a THIRD GROUND, not the canvas and not a card (D2's
 * addendum). Text on it therefore takes the `-text` legs, which are measured
 * against both grounds, rather than a hex picked to match the frame.
 *
 * Three strengths, all the same hue, all read off the pack's inline styles:
 *
 *   - `WASH` — the ordinary invitation.
 *   - `QUIET` — the all-quiet face, one step down. A night in which nothing
 *     happened should press slightly less on the eye than one in which four
 *     things did; the hue does not change, because the ritual is no less real.
 *   - `FIRST` — the introduction, one step up and the only 1.5px border in the
 *     component. It is loud exactly once, ever.
 */
const WASH = {
  backgroundImage:
    "linear-gradient(155deg, rgba(61,110,232,.17), rgba(61,110,232,.05))",
  border: "1px solid rgba(61,110,232,.42)",
} as const;

const QUIET = {
  backgroundImage:
    "linear-gradient(155deg, rgba(61,110,232,.14), rgba(61,110,232,.04))",
  border: "1px solid rgba(61,110,232,.32)",
} as const;

const FIRST = {
  backgroundImage:
    "linear-gradient(155deg, rgba(61,110,232,.2), rgba(61,110,232,.05))",
  border: "1.5px solid rgba(61,110,232,.45)",
} as const;

/** The dated microlabel — mono, 8.5px, +0.12em, accent. */
const label: React.CSSProperties = {
  fontFamily: mv3Mono,
  fontSize: 8.5,
  letterSpacing: "0.12em",
  color: "var(--mv3-accent-text)",
};

export function Mv3RitualSlot({
  face,
  style,
}: {
  face: RitualFace | null;
  style?: React.CSSProperties;
}) {
  const navigate = useNavigate();

  // The absent face. Not a fragment with a spacer, not a zero-height div —
  // nothing, so the ring rises to the top of the page exactly as it does on
  // every day with no ritual in it.
  if (!face) return null;

  const open = () => {
    haptic.light();
    markRitualRead(face.kind);
    void navigate(face.href);
  };

  if (face.state === "collapsed") {
    return (
      <div data-slot="mv3-ritual" data-ritual={face.kind} style={style}>
        <button
          type="button"
          className="cue-pressable"
          onClick={open}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            width: "100%",
            background: "var(--mv3-btn2-bg)",
            border: "1px solid var(--mv3-btn2-border)",
            borderRadius: 12,
            padding: "9px 12px",
            fontFamily: "inherit",
            cursor: "pointer",
            textAlign: "left",
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <span
            style={{
              ...label,
              letterSpacing: "0.1em",
              color: "var(--mv3-muted)",
            }}
          >
            {face.label}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "var(--mv3-accent-text)" }}>
            {face.cta}
          </span>
        </button>
      </div>
    );
  }

  // Which of the three washes this face wears. The all-quiet face is the one
  // with no verb; the first is the one design bought back from suppression.
  const wash = face.tone === "first" ? FIRST : face.cta === null ? QUIET : WASH;

  return (
    <div
      data-slot="mv3-ritual"
      data-ritual={face.kind}
      data-tone={face.tone}
      style={{
        position: "relative",
        ...wash,
        borderRadius: 18,
        padding: "13px 14px",
        ...style,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={label}>{face.label}</span>
        <span style={{ flex: 1 }} />
        {face.trailing ? (
          <span
            style={{
              fontFamily: mv3Mono,
              fontSize: 8.5,
              color: "var(--mv3-muted)",
            }}
          >
            {face.trailing}
          </span>
        ) : (
          /* The brief's live dot — the frame's `mrPulse`, which is
             `mv3DashPulse` here. Frozen by the mv3 reduced-motion rule. */
          <span
            aria-hidden
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "var(--mv3-accent-text)",
              animation: "mv3DashPulse 2s ease-in-out infinite",
            }}
          />
        )}
      </div>

      <div
        style={{
          fontFamily: serif,
          fontSize: 19,
          lineHeight: 1.28,
          marginTop: 7,
          color: "var(--mv3-text)",
        }}
      >
        {face.sentence}
      </div>

      {face.sub ? (
        <div
          style={{
            fontSize: 11.5,
            lineHeight: 1.5,
            marginTop: 6,
            // Amber ONLY when the sub-line IS the needs-you fact. Every other
            // sub-line — the weekly's description of its own pager, the first
            // brief's "this is what every morning looks like now", the quiet
            // night's account of what was watched — describes rather than
            // asks, and description does not get to wear the colour that
            // means "answer me". The face says which; the view does not guess.
            color:
              face.subTone === "amber"
                ? "var(--mv3-amber-text)"
                : "var(--mv3-pill-text)",
          }}
        >
          {face.sub.map((seg, i) =>
            seg.strong ? (
              <b key={i} style={{ color: "var(--mv3-text)", fontWeight: 600 }}>
                {seg.text}
              </b>
            ) : (
              seg.text
            ),
          )}
        </div>
      ) : null}

      <div
        style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 11 }}
      >
        {face.cta === null ? (
          /* R3's all-quiet face has NO primary verb — there is nothing to
             read, so the sentence is the brief. The note stands where the
             button would, so the row keeps its shape and the card does not
             read as one that lost its button. */
          <span style={{ flex: 1, fontSize: 11, color: "var(--mv3-muted)" }}>
            {face.note}
          </span>
        ) : (
          <button
            type="button"
            className="cue-pressable"
            onClick={open}
            style={{
              flex: 1,
              background: "var(--mv3-accent-fill)",
              color: "var(--mv3-accent-on-fill)",
              border: "none",
              borderRadius: 11,
              padding: 10,
              fontSize: 12.5,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            {face.cta}
          </button>
        )}
        <button
          type="button"
          className="cue-pressable"
          onClick={() => {
            haptic.light();
            dismissRitual(face.kind);
          }}
          style={{
            background: "none",
            border: "none",
            fontSize: 11,
            // "Dismiss" is the only control on the all-quiet face, so it takes
            // the accent the pack gives it there; beside a primary verb it
            // stays muted and secondary.
            color:
              face.cta === null ? "var(--mv3-accent-text)" : "var(--mv3-muted)",
            padding: "6px 4px",
            fontFamily: "inherit",
            cursor: "pointer",
            WebkitTapHighlightColor: "transparent",
          }}
        >
          {face.dismiss}
        </button>
      </div>
    </div>
  );
}
