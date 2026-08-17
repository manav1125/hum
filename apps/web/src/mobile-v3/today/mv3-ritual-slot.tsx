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
 */
const WASH = {
  backgroundImage:
    "linear-gradient(155deg, rgba(61,110,232,.17), rgba(61,110,232,.05))",
  border: "1px solid rgba(61,110,232,.42)",
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

  return (
    <div
      data-slot="mv3-ritual"
      data-ritual={face.kind}
      style={{
        position: "relative",
        ...WASH,
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
            // Amber ONLY when the sub-line is the needs-you fact. The weekly's
            // sub-line is a description of the surface, and description does
            // not get to wear the colour that means "answer me".
            color:
              face.needsYou > 0
                ? "var(--mv3-amber-text)"
                : "var(--mv3-pill-text)",
          }}
        >
          {face.sub}
        </div>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 11 }}>
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
            color: "var(--mv3-muted)",
            padding: "6px 4px",
            fontFamily: "inherit",
            cursor: "pointer",
            WebkitTapHighlightColor: "transparent",
          }}
        >
          Later
        </button>
      </div>
    </div>
  );
}
