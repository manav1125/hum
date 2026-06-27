/**
 * Visual previews for the Create surface.
 *
 * Each Create mode (and several individual templates) gets a self-contained
 * inline-SVG thumbnail that *shows* the kind of artifact it produces — a mini
 * slide deck, a chart/metric mockup, a document layout, a report brief, an
 * image swatch, a play-frame, a lead table. No external assets, no network:
 * everything is drawn with primitives so it always renders, and every colour
 * is a `@vellumai/design-library` CSS variable (with safe fallbacks) so the
 * previews track light/dark mode automatically.
 *
 * Usage:
 *   - `previewForTemplate(modeId, templateId)` → the most specific preview.
 *   - `<CreatePreview kind="slides" />` for direct rendering.
 *
 * The SVGs are decorative (`aria-hidden`); the card title/description carry the
 * accessible name, so screen readers aren't spammed with shape descriptions.
 */

import type { ReactNode } from "react";

/* ----------------------------------------------------------------------- */
/* Palette — every colour resolves to a design-library token (dark-aware). */
/* ----------------------------------------------------------------------- */

const C = {
  /** Card-internal panel fill (slightly lifted off the card surface). */
  panel: "var(--surface-lift, #ffffff)",
  /** The card surface itself — used for insets / gaps. */
  base: "var(--surface-base, #f6f5f4)",
  /** Hairlines and frame strokes. */
  line: "var(--border-base, #e7e5e3)",
  /** Brand accent — primary ink for charts, fills, active states. */
  accent: "var(--accent-cue, #3d6ee8)",
  accentStrong: "var(--accent-cue-strong, #2b53c4)",
  accentViolet: "var(--accent-cue-violet, #7f77dd)",
  /** Muted ink for "text" rules in mockups. */
  ink: "var(--text-muted, #6b7280)",
  inkDim: "var(--text-dim, #9aa0a6)",
};

/** Shared frame: a rounded preview canvas with the card's lifted surface. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 320 168"
      width="100%"
      role="img"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid slice"
      style={{ display: "block", borderRadius: 10 }}
    >
      <rect x="0" y="0" width="320" height="168" rx="10" fill={C.panel} />
      {children}
      {/* Inner hairline keeps the thumb crisp on any surface. */}
      <rect
        x="0.5"
        y="0.5"
        width="319"
        height="167"
        rx="9.5"
        fill="none"
        stroke={C.line}
        strokeWidth="1"
      />
    </svg>
  );
}

/* ----------------------------------------------------------------------- */
/* Per-mode previews                                                        */
/* ----------------------------------------------------------------------- */

/** Slides → a presented slide with a thumbnail filmstrip below. */
function SlidesPreview({ variant }: { variant?: string }) {
  return (
    <Frame>
      {/* Hero slide */}
      <rect
        x="20"
        y="18"
        width="200"
        height="96"
        rx="6"
        fill={C.base}
        stroke={C.line}
      />
      <rect x="34" y="34" width="78" height="9" rx="2" fill={C.accent} />
      <rect x="34" y="50" width="150" height="5" rx="2" fill={C.ink} opacity="0.5" />
      <rect x="34" y="60" width="120" height="5" rx="2" fill={C.ink} opacity="0.3" />
      {/* a little chart or bullets depending on variant */}
      {variant === "qbr" ? (
        <>
          <rect x="34" y="80" width="14" height="22" rx="2" fill={C.accent} opacity="0.85" />
          <rect x="54" y="88" width="14" height="14" rx="2" fill={C.accentViolet} opacity="0.8" />
          <rect x="74" y="74" width="14" height="28" rx="2" fill={C.accent} />
          <rect x="94" y="84" width="14" height="18" rx="2" fill={C.accentViolet} opacity="0.7" />
        </>
      ) : (
        <>
          <circle cx="40" cy="86" r="3" fill={C.accent} />
          <rect x="50" y="83" width="120" height="5" rx="2" fill={C.ink} opacity="0.35" />
          <circle cx="40" cy="98" r="3" fill={C.accent} />
          <rect x="50" y="95" width="100" height="5" rx="2" fill={C.ink} opacity="0.35" />
        </>
      )}
      {/* Right-edge "next slide" peek */}
      <rect x="230" y="26" width="70" height="80" rx="5" fill={C.base} stroke={C.line} />
      <rect x="242" y="38" width="40" height="6" rx="2" fill={C.accentViolet} opacity="0.8" />
      <rect x="242" y="50" width="46" height="4" rx="2" fill={C.ink} opacity="0.3" />
      <rect x="242" y="58" width="46" height="4" rx="2" fill={C.ink} opacity="0.3" />
      <rect x="242" y="78" width="46" height="20" rx="3" fill={C.accent} opacity="0.18" />
      {/* Filmstrip */}
      <rect x="20" y="126" width="40" height="26" rx="4" fill={C.accent} opacity="0.9" />
      <rect x="68" y="126" width="40" height="26" rx="4" fill={C.base} stroke={C.line} />
      <rect x="116" y="126" width="40" height="26" rx="4" fill={C.base} stroke={C.line} />
      <rect x="164" y="126" width="40" height="26" rx="4" fill={C.base} stroke={C.line} />
    </Frame>
  );
}

/** Dashboards → metric cards + a line/bar chart. */
function DashboardPreview({ variant }: { variant?: string }) {
  return (
    <Frame>
      {/* Metric cards row */}
      {[20, 122, 224].map((x, i) => (
        <g key={x}>
          <rect x={x} y="18" width="76" height="44" rx="6" fill={C.base} stroke={C.line} />
          <rect x={x + 12} y="28" width="30" height="5" rx="2" fill={C.ink} opacity="0.4" />
          <rect
            x={x + 12}
            y="38"
            width="40"
            height="11"
            rx="2"
            fill={i === 0 ? C.accent : i === 1 ? C.accentViolet : C.ink}
            opacity={i === 2 ? 0.55 : 1}
          />
          <rect x={x + 12} y="53" width="22" height="4" rx="2" fill={C.accent} opacity="0.5" />
        </g>
      ))}
      {/* Chart panel */}
      <rect x="20" y="72" width="280" height="80" rx="6" fill={C.base} stroke={C.line} />
      {variant === "budget" ? (
        /* Pie-ish donut for budget tracker */
        <>
          <circle cx="64" cy="112" r="26" fill="none" stroke={C.line} strokeWidth="10" />
          <circle
            cx="64"
            cy="112"
            r="26"
            fill="none"
            stroke={C.accent}
            strokeWidth="10"
            strokeDasharray="100 163"
            strokeLinecap="round"
            transform="rotate(-90 64 112)"
          />
          <circle
            cx="64"
            cy="112"
            r="26"
            fill="none"
            stroke={C.accentViolet}
            strokeWidth="10"
            strokeDasharray="48 163"
            strokeLinecap="round"
            transform="rotate(45 64 112)"
          />
          <rect x="110" y="92" width="60" height="6" rx="2" fill={C.ink} opacity="0.35" />
          <rect x="110" y="106" width="80" height="6" rx="2" fill={C.ink} opacity="0.25" />
          <rect x="110" y="120" width="48" height="6" rx="2" fill={C.ink} opacity="0.25" />
        </>
      ) : (
        /* Line chart with gridlines + area */
        <>
          <line x1="34" y1="92" x2="288" y2="92" stroke={C.line} />
          <line x1="34" y1="112" x2="288" y2="112" stroke={C.line} />
          <line x1="34" y1="132" x2="288" y2="132" stroke={C.line} />
          <path
            d="M34 128 L78 116 L122 122 L166 98 L210 106 L254 86 L288 92"
            fill="none"
            stroke={C.accent}
            strokeWidth="2.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <path
            d="M34 128 L78 116 L122 122 L166 98 L210 106 L254 86 L288 92 L288 144 L34 144 Z"
            fill={C.accent}
            opacity="0.1"
          />
          {[34, 78, 122, 166, 210, 254, 288].map((cx, i) => (
            <circle key={cx} cx={cx} cy={[128, 116, 122, 98, 106, 86, 92][i]} r="2.5" fill={C.accent} />
          ))}
        </>
      )}
    </Frame>
  );
}

/** Docs → a document page with a header band and text columns. */
function DocsPreview({ variant }: { variant?: string }) {
  return (
    <Frame>
      <rect x="64" y="14" width="192" height="140" rx="6" fill={C.base} stroke={C.line} />
      {/* Title */}
      <rect x="80" y="28" width="96" height="9" rx="2" fill={C.accent} />
      <rect x="80" y="42" width="150" height="4" rx="2" fill={C.ink} opacity="0.3" />
      {/* Paragraph rules */}
      {[58, 67, 76, 85].map((y) => (
        <rect
          key={y}
          x="80"
          y={y}
          width={y === 85 ? 120 : 160}
          height="4"
          rx="2"
          fill={C.ink}
          opacity="0.22"
        />
      ))}
      {variant === "one-pager" ? (
        /* Callout box for the strategy one-pager */
        <rect x="80" y="98" width="160" height="40" rx="4" fill={C.accent} opacity="0.1" stroke={C.accent} strokeOpacity="0.3" />
      ) : (
        <>
          {/* Subheading + second block */}
          <rect x="80" y="100" width="70" height="6" rx="2" fill={C.accentViolet} opacity="0.8" />
          {[112, 121, 130].map((y) => (
            <rect key={y} x="80" y={y} width={y === 130 ? 100 : 160} height="4" rx="2" fill={C.ink} opacity="0.22" />
          ))}
        </>
      )}
    </Frame>
  );
}

/** Research → a sourced brief card with citation chips. */
function ResearchPreview() {
  return (
    <Frame>
      <rect x="22" y="16" width="276" height="136" rx="6" fill={C.base} stroke={C.line} />
      {/* Brief header */}
      <circle cx="40" cy="34" r="8" fill={C.accent} opacity="0.18" />
      <path d="M37 34 l2.5 2.5 L44 31" fill="none" stroke={C.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="56" y="28" width="120" height="7" rx="2" fill={C.ink} opacity="0.5" />
      <rect x="56" y="39" width="80" height="4" rx="2" fill={C.ink} opacity="0.25" />
      {/* Two-column compare */}
      <rect x="38" y="60" width="118" height="74" rx="5" fill={C.panel} stroke={C.line} />
      <rect x="164" y="60" width="118" height="74" rx="5" fill={C.panel} stroke={C.line} />
      {[
        [50, 72, C.accent],
        [50, 84, C.ink],
        [50, 94, C.ink],
        [176, 72, C.accentViolet],
        [176, 84, C.ink],
        [176, 94, C.ink],
      ].map(([x, y, fill], i) => (
        <rect
          key={i}
          x={x as number}
          y={y as number}
          width={i % 3 === 0 ? 56 : 92}
          height={i % 3 === 0 ? 6 : 4}
          rx="2"
          fill={fill as string}
          opacity={i % 3 === 0 ? 0.85 : 0.22}
        />
      ))}
      {/* Citation chips */}
      <rect x="50" y="112" width="34" height="12" rx="6" fill={C.accent} opacity="0.14" />
      <rect x="90" y="112" width="34" height="12" rx="6" fill={C.accent} opacity="0.14" />
      <rect x="176" y="112" width="34" height="12" rx="6" fill={C.accentViolet} opacity="0.14" />
    </Frame>
  );
}

/** Images → a framed gradient swatch (generation output). */
function ImagePreview({ variant }: { variant?: string }) {
  const id = `img-grad-${variant ?? "default"}`;
  return (
    <Frame>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={C.accent} />
          <stop offset="55%" stopColor={C.accentViolet} />
          <stop offset="100%" stopColor={C.accentStrong} />
        </linearGradient>
      </defs>
      <rect x="22" y="16" width="276" height="136" rx="6" fill={C.base} stroke={C.line} />
      {variant === "logo" ? (
        /* Three logo swatches */
        <>
          {[40, 122, 204].map((x, i) => (
            <g key={x}>
              <rect x={x} y="44" width="76" height="80" rx="8" fill={C.panel} stroke={C.line} />
              {i === 0 && <circle cx={x + 38} cy="84" r="22" fill={`url(#${id})`} />}
              {i === 1 && <rect x={x + 18} y="64" width="40" height="40" rx="8" fill={C.accentViolet} />}
              {i === 2 && (
                <path d={`M${x + 18} 104 L${x + 38} 62 L${x + 58} 104 Z`} fill={C.accent} />
              )}
            </g>
          ))}
        </>
      ) : (
        <>
          <rect x="38" y="30" width="244" height="108" rx="5" fill={`url(#${id})`} />
          {/* glossy sun + horizon to read as an image */}
          <circle cx="224" cy="62" r="18" fill="#ffffff" opacity="0.85" />
          <path d="M38 122 L120 92 L168 110 L220 86 L282 112 L282 138 L38 138 Z" fill="#ffffff" opacity="0.18" />
          {variant === "social" && (
            <rect x="58" y="66" width="96" height="10" rx="3" fill="#ffffff" opacity="0.9" />
          )}
        </>
      )}
    </Frame>
  );
}

/** Canvas → a before/after split for image editing. */
function CanvasPreview({ variant }: { variant?: string }) {
  return (
    <Frame>
      <defs>
        <linearGradient id="canvas-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={C.accentViolet} />
          <stop offset="100%" stopColor={C.accent} />
        </linearGradient>
        <pattern id="checker" width="12" height="12" patternUnits="userSpaceOnUse">
          <rect width="12" height="12" fill={C.base} />
          <rect width="6" height="6" fill={C.line} />
          <rect x="6" y="6" width="6" height="6" fill={C.line} />
        </pattern>
      </defs>
      {/* "Before" original */}
      <rect x="22" y="22" width="132" height="124" rx="6" fill="url(#canvas-grad)" stroke={C.line} />
      <circle cx="88" cy="74" r="26" fill="#ffffff" opacity="0.75" />
      <path d="M30 130 L72 102 L100 118 L146 96 L146 140 L30 140 Z" fill="#ffffff" opacity="0.2" />
      {/* "After" — transparent/cutout or restyled */}
      <rect
        x="166"
        y="22"
        width="132"
        height="124"
        rx="6"
        fill={variant === "remove-bg" ? "url(#checker)" : C.panel}
        stroke={C.line}
      />
      {variant === "remove-bg" ? (
        <circle cx="232" cy="78" r="26" fill={C.accent} />
      ) : (
        <>
          <circle cx="232" cy="74" r="26" fill={C.accentViolet} />
          <path d="M174 130 L216 102 L244 118 L290 96 L290 140 L174 140 Z" fill={C.accent} opacity="0.5" />
        </>
      )}
      {/* Divider handle */}
      <rect x="158" y="22" width="2" height="124" fill={C.accent} />
      <circle cx="159" cy="84" r="9" fill={C.panel} stroke={C.accent} strokeWidth="2" />
      <path d="M155 80 l-3 4 l3 4 M163 80 l3 4 l-3 4" fill="none" stroke={C.accent} strokeWidth="1.5" strokeLinecap="round" />
    </Frame>
  );
}

/** Video → a play-frame with a scrub timeline. */
function VideoPreview() {
  return (
    <Frame>
      <defs>
        <linearGradient id="vid-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={C.accentStrong} />
          <stop offset="100%" stopColor={C.accentViolet} />
        </linearGradient>
      </defs>
      <rect x="22" y="16" width="276" height="98" rx="6" fill="url(#vid-grad)" stroke={C.line} />
      {/* Play button */}
      <circle cx="160" cy="65" r="22" fill="#ffffff" opacity="0.92" />
      <path d="M154 55 L172 65 L154 75 Z" fill={C.accentStrong} />
      {/* Timeline / scrubber */}
      <rect x="22" y="126" width="276" height="26" rx="5" fill={C.base} stroke={C.line} />
      <rect x="32" y="135" width="256" height="4" rx="2" fill={C.line} />
      <rect x="32" y="135" width="150" height="4" rx="2" fill={C.accent} />
      <circle cx="182" cy="137" r="6" fill={C.accent} />
      {/* clip markers */}
      <rect x="70" y="144" width="20" height="4" rx="2" fill={C.accentViolet} opacity="0.7" />
      <rect x="150" y="144" width="28" height="4" rx="2" fill={C.accent} opacity="0.7" />
      <rect x="230" y="144" width="18" height="4" rx="2" fill={C.accentViolet} opacity="0.7" />
    </Frame>
  );
}

/** Leads → a contact table mockup. */
function LeadsPreview() {
  const rows = [22, 24, 26, 28];
  return (
    <Frame>
      <rect x="22" y="16" width="276" height="136" rx="6" fill={C.base} stroke={C.line} />
      {/* Header row */}
      <rect x="22" y="16" width="276" height="26" rx="6" fill={C.accent} opacity="0.12" />
      <rect x="58" y="26" width="50" height="6" rx="2" fill={C.accent} opacity="0.8" />
      <rect x="150" y="26" width="40" height="6" rx="2" fill={C.accent} opacity="0.6" />
      <rect x="228" y="26" width="56" height="6" rx="2" fill={C.accent} opacity="0.6" />
      {/* Rows */}
      {rows.map((_, i) => {
        const y = 52 + i * 24;
        return (
          <g key={y}>
            {i > 0 && <line x1="22" y1={y - 6} x2="298" y2={y - 6} stroke={C.line} />}
            <circle cx="40" cy={y + 2} r="8" fill={i % 2 ? C.accentViolet : C.accent} opacity="0.85" />
            <rect x="58" y={y - 4} width="64" height="5" rx="2" fill={C.ink} opacity="0.55" />
            <rect x="58" y={y + 4} width="44" height="4" rx="2" fill={C.ink} opacity="0.25" />
            <rect x="150" y={y - 1} width="58" height="5" rx="2" fill={C.ink} opacity="0.35" />
            <rect x="228" y={y - 1} width="62" height="5" rx="2" fill={C.ink} opacity="0.3" />
          </g>
        );
      })}
    </Frame>
  );
}

/* ----------------------------------------------------------------------- */
/* Public component + lookup                                                */
/* ----------------------------------------------------------------------- */

export type PreviewKind =
  | "slides"
  | "data"
  | "docs"
  | "research"
  | "images"
  | "canvas"
  | "video"
  | "leads";

/** Renders the mode-level preview, with optional template variant tuning. */
export function CreatePreview({
  kind,
  variant,
}: {
  kind: PreviewKind;
  variant?: string;
}) {
  switch (kind) {
    case "slides":
      return <SlidesPreview variant={variant} />;
    case "data":
      return <DashboardPreview variant={variant} />;
    case "docs":
      return <DocsPreview variant={variant} />;
    case "research":
      return <ResearchPreview />;
    case "images":
      return <ImagePreview variant={variant} />;
    case "canvas":
      return <CanvasPreview variant={variant} />;
    case "video":
      return <VideoPreview />;
    case "leads":
      return <LeadsPreview />;
  }
}

/**
 * Maps a (modeId, templateId) pair to the best preview + variant. Template ids
 * cover BOTH the quick-start catalog (create-templates.ts) and the structured
 * form catalog (create-form-templates.ts, ids prefixed `form-`).
 */
export function previewForTemplate(
  modeId: string,
  templateId: string,
): { kind: PreviewKind; variant?: string } {
  const kind = (modeId as PreviewKind) ?? "slides";
  // Normalise the `form-` prefix so form + quick-start share variant logic.
  const t = templateId.replace(/^form-/, "");

  let variant: string | undefined;
  switch (modeId) {
    case "slides":
      if (t === "qbr" || t === "kpi") variant = "qbr";
      break;
    case "data":
      if (t === "budget-tracker" || t === "budget") variant = "budget";
      break;
    case "docs":
      if (t === "one-pager") variant = "one-pager";
      break;
    case "images":
      if (t === "logo-concepts" || t === "logo-concept") variant = "logo";
      else if (t === "social-graphic" || t === "social") variant = "social";
      break;
    case "canvas":
      if (t === "remove-bg") variant = "remove-bg";
      break;
  }
  return { kind, variant };
}
