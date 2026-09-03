/**
 * Compact branded cover card for the MOBILE Library (Cue-Surfaces S3).
 *
 * Renders a fast, iframe-free artifact tile: a 104pt gradient/color cover
 * derived from the artifact *type* (kind → gradient + glyph + badge), then a
 * 12.5pt title, a mono date, and an optional ⟡ provenance tag. Covers use
 * fixed brand colors per type (they read well on both light + dark), while the
 * card chrome (bg / border / title / date) is theme-aware via `--mv1-*` tokens.
 *
 * A caller may supply `coverImageUrl` (e.g. a course's first slide) — it
 * replaces the glyph art but keeps the badge and a legibility scrim, and the
 * themed cover is the fallback if the image never loads. `onOpenProvenance`
 * makes the ⟡ tag its own click target (e.g. jump to the source chat), which
 * is why the card root is a div holding two sibling buttons — a button inside
 * a button is invalid HTML and unreachable to keyboards.
 *
 * This is the mobile counterpart to `library-app-card` / `library-document-card`
 * — those keep their live-preview thumbnails on desktop; mobile swaps in this
 * compact cover so the grid stays fast (no per-artifact iframes).
 */

import { useState } from "react";

const mono = "'DM Mono', ui-monospace, monospace";
const serif = "'Instrument Serif', Georgia, serif";

/** Coarse artifact kinds we can theme a cover for. */
export type CoverKind =
  | "Deck"
  | "Doc"
  | "Dash"
  | "Site"
  | "Video"
  | "App"
  | "Course";

interface CoverTheme {
  /** Cover background (gradient or solid) — fixed brand color per type. */
  background: string;
  /** Badge text color (sits on the badge chip). */
  badgeFg: string;
  /** Badge chip background. */
  badgeBg: string;
  /** Short label shown in the top-right badge. */
  badge: string;
  /** Decorative glyph/eyebrow color inside the cover. */
  accent: string;
  /** Large decorative glyph rendered center-ish in the cover. */
  glyph: string;
}

/**
 * Type → cover treatment. Colors mirror the design's four example covers
 * (green-black Site, navy Dash, gold Deck, dark-gold Video) and extend the
 * palette to Doc/App so every artifact gets a tasteful, consistent cover
 * without bespoke per-artifact art.
 */
const COVER_THEME: Record<CoverKind, CoverTheme> = {
  Site: {
    background: "linear-gradient(150deg,#1C2A22,#0F1A14)",
    badgeFg: "#0F1A14",
    badgeBg: "#8FBFA1",
    badge: "Site",
    accent: "#8FBFA1",
    glyph: "◈",
  },
  Deck: {
    background: "linear-gradient(150deg,#14110C,#241C10)",
    badgeFg: "#241C10",
    badgeBg: "#C99A4E",
    badge: "Deck",
    accent: "#C99A4E",
    glyph: "▤",
  },
  Dash: {
    background: "#101826",
    badgeFg: "#101826",
    badgeBg: "#7FA0E6",
    badge: "Dash",
    accent: "#7FA0E6",
    glyph: "▦",
  },
  Doc: {
    background: "linear-gradient(150deg,#141C2C,#0E1420)",
    badgeFg: "#0E1420",
    badgeBg: "#8FA6E6",
    badge: "Doc",
    accent: "#8FA6E6",
    glyph: "❡",
  },
  Video: {
    background: "radial-gradient(circle at 50% 42%,#1A140A,#0A0C10 70%)",
    badgeFg: "#0A0C10",
    badgeBg: "#C99A4E",
    badge: "Video",
    accent: "#C99A4E",
    glyph: "⏵",
  },
  App: {
    background: "linear-gradient(150deg,#101826,#0C121B)",
    badgeFg: "#0C121B",
    badgeBg: "#7FA0E6",
    badge: "App",
    accent: "#7FA0E6",
    glyph: "▧",
  },
  // Cue Learn classrooms — navy ground with the Learn wordmark's blue/violet
  // pair; the diamond glyph echoes the mortarboard in the Cue Learn mark.
  Course: {
    background: "linear-gradient(150deg,#131A2E,#0D1120)",
    badgeFg: "#0D1120",
    badgeBg: "#8FA0E8",
    badge: "Course",
    accent: "#7F77DD",
    glyph: "◆",
  },
};

export interface LibraryCoverCardProps {
  kind: CoverKind;
  title: string;
  /** Preformatted, upper-cased mono date (e.g. "4 JUL"). Computed by caller. */
  dateLabel: string;
  /** Optional ⟡ provenance tag text (without the lozenge). */
  provenance?: string;
  /** Makes the ⟡ provenance tag a click target (e.g. open the source chat). */
  onOpenProvenance?: () => void;
  /** Real cover art (e.g. a course's first slide); themed cover on failure. */
  coverImageUrl?: string;
  onOpen: () => void;
}

export function LibraryCoverCard({
  kind,
  title,
  dateLabel,
  provenance,
  onOpenProvenance,
  coverImageUrl,
  onOpen,
}: LibraryCoverCardProps) {
  const theme = COVER_THEME[kind];
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(coverImageUrl) && !imageFailed;
  // Course covers follow the handoff's cover grammar: the ground is ALWAYS
  // ink, slide art reads as a rotated paper card anchored lower-right, and
  // the badge is a violet keyline rather than a filled chip.
  const courseGrammar = kind === "Course";
  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{
        background: "var(--mv1-card)",
        border: "1px solid var(--mv1-line)",
        borderRadius: 14,
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full flex-col text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        style={{ cursor: "pointer" }}
      >
        {/* Branded cover — derived from artifact TYPE, no live iframe. */}
        <div
          style={{
            height: 104,
            width: "100%",
            background: theme.background,
            padding: "12px 13px",
            position: "relative",
            overflow: "hidden",
          }}
        >
          {showImage && courseGrammar ? (
            /* Slide art as a paper card dropped on the ink desk. */
            <img
              src={coverImageUrl}
              alt=""
              onError={() => setImageFailed(true)}
              style={{
                position: "absolute",
                right: -6,
                bottom: -10,
                width: "58%",
                aspectRatio: "16 / 9",
                objectFit: "cover",
                transform: "rotate(-3deg)",
                borderRadius: 6,
                background: "#F3EEE4",
                boxShadow: "0 14px 28px -14px rgba(0,0,0,.7)",
              }}
            />
          ) : showImage ? (
            <>
              <img
                src={coverImageUrl}
                alt=""
                onError={() => setImageFailed(true)}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
              {/* Scrim so the eyebrow/title stay legible over any slide. */}
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  inset: 0,
                  background:
                    "linear-gradient(180deg,rgba(10,12,18,.55),rgba(10,12,18,.15) 45%,rgba(10,12,18,.6))",
                }}
              />
            </>
          ) : null}
          {!courseGrammar ? (
            <div
              style={{
                fontFamily: mono,
                fontSize: 7.5,
                letterSpacing: ".14em",
                textTransform: "uppercase",
                color: theme.accent,
                position: "relative",
              }}
            >
              {kind}
            </div>
          ) : null}
          {!showImage || courseGrammar ? (
            <div
              aria-hidden
              style={{
                position: "absolute",
                ...(courseGrammar && showImage
                  ? { left: 12, bottom: 8, fontSize: 22, opacity: 0.85 }
                  : { right: 10, bottom: 6, fontSize: 44, opacity: 0.24 }),
                lineHeight: 1,
                color: theme.accent,
              }}
            >
              {theme.glyph}
            </div>
          ) : null}
          <div
            style={{
              fontFamily: serif,
              fontSize: 15,
              color: "#F3EEE4",
              lineHeight: 1.1,
              marginTop: courseGrammar ? 26 : 16,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              position: "relative",
              ...(courseGrammar && showImage ? { maxWidth: "50%" } : {}),
            }}
          >
            {title}
          </div>
          <span
            style={{
              position: "absolute",
              top: 10,
              ...(courseGrammar ? { left: 12 } : { right: 11 }),
              fontFamily: mono,
              fontSize: 7.5,
              letterSpacing: courseGrammar ? ".14em" : ".04em",
              textTransform: courseGrammar ? "uppercase" : undefined,
              ...(courseGrammar
                ? {
                    color: theme.accent,
                    background: "transparent",
                    border: `1px solid ${theme.accent}66`,
                  }
                : { color: theme.badgeFg, background: theme.badgeBg }),
              borderRadius: 5,
              padding: "3px 6px",
            }}
          >
            {theme.badge}
          </span>
        </div>

        {/* Meta — theme-aware chrome. */}
        <div style={{ padding: "10px 12px 0", width: "100%" }}>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: "var(--mv1-t1)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </div>
        </div>
      </button>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
          padding: "3px 12px 10px",
        }}
      >
        <span
          style={{
            fontFamily: mono,
            fontSize: 9,
            letterSpacing: ".04em",
            color: "var(--mv1-t3)",
          }}
        >
          {dateLabel}
        </span>
        {provenance && onOpenProvenance ? (
          <button
            type="button"
            onClick={onOpenProvenance}
            className="outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            style={{
              fontSize: 9,
              color: "var(--mv1-blue-strong)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: "60%",
              cursor: "pointer",
              textDecoration: "underline",
              textDecorationColor: "color-mix(in srgb, currentColor 40%, transparent)",
              textUnderlineOffset: 2,
              borderRadius: 4,
            }}
          >
            ⟡ {provenance}
          </button>
        ) : provenance ? (
          <span
            style={{
              fontSize: 9,
              color: "var(--mv1-blue-strong)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: "60%",
            }}
          >
            ⟡ {provenance}
          </span>
        ) : null}
      </div>
    </div>
  );
}
