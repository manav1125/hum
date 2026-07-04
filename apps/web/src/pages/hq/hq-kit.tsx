/**
 * HQ visual kit — the ring language, mission palette, and micro-chrome shared
 * by the HQ deck, the pulse, and Mission detail.
 *
 * Faithful to the locked Cue-HQ-Build design doc: serif display headings,
 * DM Mono microlabels, status rings that NEVER fake a number (phase 1 is
 * status-only — a full ring tinted by the honest state: ✓ on track,
 * ! needs you, ◼ blocked), and the dark "rings hero" gradient card that stays
 * dark in both themes. Colors ride the theme-aware `--mv1-*` vars plus the
 * HQ-local `--hq-teal` accent injected by `<HqStyle/>`.
 */

import type { CSSProperties, ReactNode } from "react";

import { C, mono, serif } from "@/domains/activity/theme";

export { C, mono, serif };

/** The honest phase-1 ring state. */
export type RingStatus = "on_track" | "needs_you" | "blocked";

export const RING_META: Record<
  RingStatus,
  { glyph: string; label: string; color: string }
> = {
  on_track: { glyph: "✓", label: "on track", color: C.green },
  needs_you: { glyph: "!", label: "needs you", color: C.amber },
  blocked: { glyph: "◼", label: "blocked", color: C.danger },
};

/**
 * Per-mission hue for the concentric hero rings + sidebar dots. Status colors
 * (amber/danger) override the hue when a mission isn't on track, per the doc.
 */
const MISSION_HUES = [
  "var(--mv1-blue)",
  "var(--hq-teal)",
  "var(--mv1-violet)",
  "var(--mv1-green)",
  "var(--mv1-blue-strong)",
  "var(--mv1-violet-strong)",
];

export function missionHue(index: number): string {
  return MISSION_HUES[index % MISSION_HUES.length];
}

/** The dark hero gradient — deliberately constant across themes (per doc). */
export const HERO_GRADIENT = "linear-gradient(150deg, #16202E, #0C121B)";

/** HQ-local keyframes + accent vars. Mount once per HQ page. */
export function HqStyle() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: [
          ":root{--hq-teal:#0E8C8C;--hq-teal-bright:#19B3B3;}",
          '[data-theme="dark"],[data-theme="velvet"]{--hq-teal:#2CC4C4;--hq-teal-bright:#2CC4C4;}',
          "@keyframes hqBar{0%,100%{height:5px}50%{height:13px}}",
          "@keyframes hqBlink{0%,100%{opacity:1}50%{opacity:.35}}",
          "@keyframes hqReveal{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}",
          '[data-slot="hq-stream"]>*{animation:hqReveal .45s cubic-bezier(.22,.61,.36,1) both}',
          '[data-slot="hq-stream"]>*:nth-child(2){animation-delay:.05s}',
          '[data-slot="hq-stream"]>*:nth-child(3){animation-delay:.1s}',
          '[data-slot="hq-stream"]>*:nth-child(4){animation-delay:.15s}',
          "@media (prefers-reduced-motion:reduce){[data-slot^='hq-'] *{animation:none !important}}",
          // Two-column deck collapses to a single column under 980px; hero
          // stacks under 640px (the 390px story).
          '@media (max-width:980px){[data-slot="hq-columns"]{grid-template-columns:1fr !important}}',
          '@media (max-width:640px){[data-slot="hq-hero-card"]{flex-direction:column !important;text-align:center;}[data-slot="hq-hero-lines"]{width:100%}[data-slot="hq-page-pad"]{padding:16px 14px 60px !important}[data-slot="hq-title"]{font-size:28px !important}}',
          '@media (max-width:640px){[data-slot="hq-detail-hero"]{flex-direction:column !important;align-items:flex-start !important}}',
        ].join("\n"),
      }}
    />
  );
}

/** Mono all-caps microlabel (the "COMMAND / NEEDS YOU" voice). */
export function MicroLabel({
  children,
  color = C.t3,
  style,
}: {
  children: ReactNode;
  color?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        fontFamily: mono,
        fontSize: 10,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * A single status ring. Phase 1 is status-only: the arc is FULL (never a
 * made-up sweep) and tinted by the honest state, with the state glyph in the
 * middle — exactly the "Day one, rings don't show a percentage" frame.
 */
export function StatusRing({
  status,
  size = 44,
  stroke = 5,
  glyphSize,
}: {
  status: RingStatus;
  size?: number;
  stroke?: number;
  glyphSize?: number;
}) {
  const meta = RING_META[status];
  const r = size / 2 - stroke - 1;
  return (
    <div
      role="img"
      aria-label={`Mission ${meta.label}`}
      style={{ position: "relative", width: size, height: size, flexShrink: 0 }}
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        style={{ transform: "rotate(-90deg)" }}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={C.sunken}
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={meta.color}
          strokeWidth={stroke}
          strokeLinecap="round"
        />
      </svg>
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: glyphSize ?? Math.round(size * 0.3),
          color: meta.color,
        }}
      >
        {meta.glyph}
      </div>
    </div>
  );
}

/**
 * The concentric rings hero visual — one full ring per mission (outer-in),
 * tinted mission-hue when on track and status-tinted otherwise, with the
 * serif "N/M — ON TRACK" stack in the middle. Renders on the dark hero card.
 */
export function RingsHero({
  rings,
  onTrack,
  total,
  size = 176,
}: {
  rings: Array<{ status: RingStatus; hue: string }>;
  onTrack: number;
  total: number;
  size?: number;
}) {
  const shown = rings.slice(0, 6);
  const stroke = shown.length > 4 ? 9 : 12;
  const gap = 4;
  const outer = 100 - stroke / 2;
  return (
    <div
      role="img"
      aria-label={`${onTrack} of ${total} missions on track`}
      style={{ position: "relative", width: size, height: size, flexShrink: 0 }}
    >
      <svg
        viewBox="0 0 200 200"
        width={size}
        height={size}
        style={{ transform: "rotate(-90deg)" }}
      >
        <g fill="none" strokeWidth={stroke} strokeLinecap="round">
          {shown.map((ring, i) => {
            const r = outer - i * (stroke + gap);
            if (r <= 12) return null;
            const color =
              ring.status === "on_track"
                ? ring.hue
                : RING_META[ring.status].color;
            return (
              <g key={i}>
                <circle cx={100} cy={100} r={r} stroke="rgba(255,255,255,.1)" />
                <circle cx={100} cy={100} r={r} stroke={color} />
              </g>
            );
          })}
        </g>
      </svg>
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
        }}
      >
        <span
          style={{ fontFamily: serif, fontSize: size * 0.16, lineHeight: 1 }}
        >
          {onTrack}/{total}
        </span>
        <span
          style={{
            fontFamily: mono,
            fontSize: 9,
            letterSpacing: "0.1em",
            color: "rgba(255,255,255,.6)",
            marginTop: 2,
          }}
        >
          ON TRACK
        </span>
      </div>
    </div>
  );
}

/** The Cue "C" aperture mark used in the capture bar (design-doc lockup). */
export function ApertureMark({ size = 20 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        position: "relative",
        width: size + 4,
        height: size + 4,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <span
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          boxShadow: `0 0 0 2px ${C.blue} inset`,
          mask: "radial-gradient(circle, transparent 52%, #000 53%)",
          WebkitMask: "radial-gradient(circle, transparent 52%, #000 53%)",
          transform: "rotate(40deg)",
        }}
      >
        <span
          style={{
            position: "absolute",
            width: "27%",
            height: "27%",
            borderRadius: "50%",
            background: C.blue,
            top: "8%",
            left: "8%",
            animation: "hqBlink 5s ease infinite",
          }}
        />
      </span>
    </span>
  );
}

/** Three animated "agent working" equalizer bars. */
export function LiveBars({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        gap: 2,
        alignItems: "flex-end",
        height: 13,
        flexShrink: 0,
      }}
    >
      {[0, 0.15, 0.3].map((delay) => (
        <b
          key={delay}
          style={{
            width: 3,
            background: color,
            borderRadius: 2,
            display: "block",
            animation: `hqBar 0.9s ease-in-out ${delay}s infinite`,
            height: 8,
          }}
        />
      ))}
    </span>
  );
}

/** Autonomy-mode display metadata (the "leash" language from the doc). */
export const MODE_META: Record<
  "observe" | "assist" | "autonomous",
  { glyph: string; label: string; blurb: string }
> = {
  observe: {
    glyph: "👁",
    label: "Observe",
    blurb: "Cue watches and drafts, never sends.",
  },
  assist: {
    glyph: "✎",
    label: "Assist",
    blurb:
      "Cue drafts everything and acts on routine, reversible things — anything that leaves the building waits for your yes.",
  },
  autonomous: {
    glyph: "⚡",
    label: "Autonomous",
    blurb: "Cue acts on its own, within the budget and never-lines you set.",
  },
};

/** `$1.3K` / `$40` compact money from cents. */
export function fmtCents(cents: number): string {
  const usd = cents / 100;
  if (usd >= 1000) {
    const k = usd / 1000;
    return `$${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}K`;
  }
  if (usd >= 100) return `$${Math.round(usd)}`;
  return `$${usd.toFixed(usd % 1 === 0 ? 0 : 2)}`;
}

/** Short horizon label from an epoch-ms target ("Sep 30" / "Sep 30, 2027"). */
export function horizonLabel(horizon: number | null): string | null {
  if (horizon == null || !Number.isFinite(horizon)) return null;
  const d = new Date(horizon);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Source-type → badge glyph + tint for the Came-in strip. */
export function sourceBadge(sourceType: string | null): {
  glyph: string;
  tint: string;
} {
  const t = (sourceType ?? "").toLowerCase();
  if (t.includes("mail") || t.includes("email"))
    return { glyph: "✉", tint: "#EA4335" };
  if (t.includes("slack")) return { glyph: "#", tint: "#4A154B" };
  if (t.includes("call") || t.includes("voice") || t.includes("meeting"))
    return { glyph: "☎", tint: "var(--hq-teal)" };
  if (t.includes("calendar")) return { glyph: "◱", tint: "#1A73E8" };
  if (t.includes("schedule") || t.includes("cron"))
    return { glyph: "◷", tint: "var(--mv1-violet)" };
  if (t.includes("watch")) return { glyph: "◉", tint: "var(--mv1-amber)" };
  if (t.includes("chat") || t.includes("conversation") || t.includes("user"))
    return { glyph: "◆", tint: "var(--mv1-blue)" };
  return { glyph: "↳", tint: "var(--mv1-t3)" };
}
