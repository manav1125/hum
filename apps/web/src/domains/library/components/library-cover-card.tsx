/**
 * Compact branded cover card for the MOBILE Library (Cue-Surfaces S3).
 *
 * Renders a fast, iframe-free artifact tile: a 104pt gradient/color cover
 * derived from the artifact *type* (kind → gradient + glyph + badge), then a
 * 12.5pt title, a mono date, and an optional ⟡ provenance tag. Covers use
 * fixed brand colors per type (they read well on both light + dark), while the
 * card chrome (bg / border / title / date) is theme-aware via `--mv1-*` tokens.
 *
 * This is the mobile counterpart to `library-app-card` / `library-document-card`
 * — those keep their live-preview thumbnails on desktop; mobile swaps in this
 * compact cover so the grid stays fast (no per-artifact iframes).
 */

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
  onOpen: () => void;
}

export function LibraryCoverCard({
  kind,
  title,
  dateLabel,
  provenance,
  onOpen,
}: LibraryCoverCardProps) {
  const theme = COVER_THEME[kind];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col overflow-hidden text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      style={{
        background: "var(--mv1-card)",
        border: "1px solid var(--mv1-line)",
        borderRadius: 14,
        cursor: "pointer",
      }}
    >
      {/* Branded cover — derived from artifact TYPE, no live iframe. */}
      <div
        style={{
          height: 104,
          background: theme.background,
          padding: "12px 13px",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            fontFamily: mono,
            fontSize: 7.5,
            letterSpacing: ".14em",
            textTransform: "uppercase",
            color: theme.accent,
          }}
        >
          {kind}
        </div>
        <div
          aria-hidden
          style={{
            position: "absolute",
            right: 10,
            bottom: 6,
            fontSize: 44,
            lineHeight: 1,
            color: theme.accent,
            opacity: 0.24,
          }}
        >
          {theme.glyph}
        </div>
        <div
          style={{
            fontFamily: serif,
            fontSize: 15,
            color: "#F3EEE4",
            lineHeight: 1.1,
            marginTop: 16,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            position: "relative",
          }}
        >
          {title}
        </div>
        <span
          style={{
            position: "absolute",
            top: 10,
            right: 11,
            fontFamily: mono,
            fontSize: 7.5,
            letterSpacing: ".04em",
            color: theme.badgeFg,
            background: theme.badgeBg,
            borderRadius: 5,
            padding: "3px 6px",
          }}
        >
          {theme.badge}
        </span>
      </div>

      {/* Meta — theme-aware chrome. */}
      <div style={{ padding: "10px 12px", width: "100%" }}>
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 6,
            marginTop: 3,
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
          {provenance ? (
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
    </button>
  );
}
