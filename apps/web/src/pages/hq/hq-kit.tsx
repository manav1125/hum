/**
 * HQ visual kit — the ring language, mission palette, and micro-chrome shared
 * by the HQ deck, the pulse, and Mission detail.
 *
 * Faithful to the locked Cue-HQ-Build design doc: serif display headings,
 * DM Mono microlabels, status rings that NEVER fake a number — the arc IS the
 * status (v35 · V3, answer (a)): a full green ring + ✓ on track, a full amber
 * ring + ! when something waits on you, a long blue segment with live bars
 * while work is moving, a red stub + ◼ when blocked. No percentage anywhere,
 * because there is no connected metric to measure one from. The dark hero
 * gradient is still used by Mission detail, which draws the same arcs. The full-bleed concentric "rings hero" that lived here is gone: the
 * v33 HQ draws mission health once, as four status rings inside the Deck rail's
 * Missions tile, so the portfolio reads in a tile instead of a screen. Colors ride the theme-aware `--mv1-*` vars plus the
 * HQ-local `--hq-teal` accent injected by `<HqStyle/>`.
 */

import type { CSSProperties, ReactNode } from "react";

import { C, mono, serif } from "@/domains/activity/theme";

export { C, mono, serif };

/** The honest ring state. Never a percentage — see {@link StatusRing}. */
export type RingStatus = "on_track" | "needs_you" | "moving" | "blocked";

export const RING_META: Record<
  RingStatus,
  {
    glyph: string;
    label: string;
    color: string;
    /**
     * How much of the circle the arc covers, 0–1 — **the status, not a
     * quantity** (design V3, answer (a)).
     *
     * This is the one number in the ring language, and it is a constant per
     * state rather than anything measured: a full circle means settled, a long
     * segment means in motion, a stub means stopped. Because the sweep is a
     * property of the STATE, two blocked missions draw identical arcs and no
     * reader can mistake the geometry for progress. The moment a mission gains
     * a real connected metric, that mission's ring takes a measured fraction
     * here — and no other mission's does.
     */
    arc: number;
  }
> = {
  on_track: { glyph: "✓", label: "on track", color: C.green, arc: 1 },
  needs_you: { glyph: "!", label: "needs you", color: C.amber, arc: 1 },
  moving: { glyph: "", label: "moving", color: C.blue, arc: 0.76 },
  // A stub, not a ring: blocked is the one state that should look interrupted
  // rather than merely tinted.
  blocked: { glyph: "◼", label: "blocked", color: C.danger, arc: 0.17 },
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
          // Muted TEXT, and only text. Invariant 15: #5B5B68 has regressed four
          // times and is never a text colour (~2.5:1 on our dark grounds);
          // #8A8A7E and #A8A89C are ground/hairline colours, never type. The
          // global --mv1-t3 is a chrome grey that dips under 4:1 on the dark
          // canvas, so the Tier-3 rail — which is nothing BUT small grey text —
          // rides this token instead: #6B6B60 light (5.4:1), #9A9AA8 dark
          // (6.9:1).
          ":root{--hq-muted:#6B6B60;}",
          '[data-theme="dark"],[data-theme="velvet"]{--hq-muted:#9A9AA8;}',
          "@keyframes hqBar{0%,100%{height:5px}50%{height:13px}}",
          // The ring's bars scale rather than resize: a `height` keyframe
          // would overflow the ring at small sizes, and the whole point of the
          // moving mark is that it sits inside the arc.
          "@keyframes hqRingBar{0%,100%{transform:scaleY(.28)}50%{transform:scaleY(1)}}",
          "@keyframes hqBlink{0%,100%{opacity:1}50%{opacity:.35}}",
          "@keyframes hqReveal{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}",
          // Loading shimmer (design doc R5·A5 "headers first, shimmer where
          // data goes"). Rides theme vars so it reads in light and dark.
          "@keyframes hqShimmer{0%{background-position:-360px 0}100%{background-position:360px 0}}",
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

/**
 * One shimmering skeleton block (R5·A5). Structure lands first — headers are
 * real text; only the data slots shimmer. Never a spinner-in-space.
 */
export function Shimmer({
  height,
  width = "100%",
  radius = 10,
  circle = false,
  opacity = 1,
  style,
}: {
  height: number;
  width?: number | string;
  radius?: number;
  circle?: boolean;
  opacity?: number;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden
      style={{
        display: "block",
        height,
        width,
        flexShrink: 0,
        borderRadius: circle ? "50%" : radius,
        background: `linear-gradient(90deg, ${C.sunken} 25%, ${C.surface} 37%, ${C.sunken} 63%)`,
        backgroundSize: "360px 100%",
        animation: "hqShimmer 1.4s linear infinite",
        opacity,
        ...style,
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
 * Two live bars — the `moving` ring's mark.
 *
 * A glyph would have to say something ("→", "…") that the arc already says; the
 * bars say the one thing a static mark cannot, which is that this is happening
 * right now. They ride the `hqRingBar` keyframe, and the global
 * reduced-motion rule in {@link HqStyle} stops them animating without removing
 * them — the state stays legible when the motion does not run.
 */
export function ActivityBars({ color, height }: { color: string; height: number }) {
  return (
    <span
      aria-hidden
      data-slot="hq-ring-bars"
      style={{ display: "flex", gap: 1.5, height, alignItems: "center" }}
    >
      <span
        style={{
          width: 2,
          height: "100%",
          background: color,
          borderRadius: 1,
          animation: "hqRingBar 1.2s ease-in-out infinite",
        }}
      />
      <span
        style={{
          width: 2,
          height: "100%",
          background: color,
          borderRadius: 1,
          animation: "hqRingBar 1.2s ease-in-out .3s infinite",
        }}
      />
    </span>
  );
}

/**
 * A single status ring — **status-only, and the arc IS the status**.
 *
 * Design's V3 answer (a). The frame this replaces drew "74%" and "36%" swept
 * arcs, and there is no percentage to draw: mission progress has no connected
 * metric, so a swept arc would be a fabricated number wearing a chart's
 * clothes. Instead the sweep is a constant per state — full ring + ✓ on track,
 * a long segment with live bars while moving, a red stub + ◼ when blocked — so
 * the geometry reads as health at a glance and cannot be misread as a
 * measurement. `RING_META[...].arc` is the only place a fraction exists.
 *
 * Nothing here is carried by colour alone: each state has its own sweep and its
 * own mark, and the `aria-label` says the state in words.
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
  const circumference = 2 * Math.PI * r;
  // A full arc must not be drawn as a dash pattern: `strokeLinecap="round"` on
  // a 100%-length dash paints two caps over the same pixels and leaves a nick
  // at 12 o'clock. Only a partial arc gets a dasharray.
  const dash =
    meta.arc >= 1
      ? undefined
      : `${circumference * meta.arc} ${circumference * (1 - meta.arc)}`;
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
          strokeDasharray={dash}
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
        {/* Moving has no glyph: its mark is the motion itself (the same
            "the mark IS the state" rule the voice screen follows). Reduced
            motion falls back to a static pair of bars via `HqStyle`. */}
        {status === "moving" ? (
          <ActivityBars color={meta.color} height={Math.round(size * 0.24)} />
        ) : (
          meta.glyph
        )}
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
