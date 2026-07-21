/**
 * Today hero collapse physics — round-4 frame 60's in-frame spec, implemented
 * EXACTLY (docs/design/mobile-round4, "COLLAPSE PHYSICS — IMPLEMENT EXACTLY"):
 *
 *   One page scroll (no inner region). Hero zone: 285px → 56px over scrollY
 *   0→200, interpolated linearly, transform/opacity only.
 *   0–80:    orbit chips fade out (opacity 1→0, scale .92); rings fade to .3.
 *   40–160:  center ring scales 80→30px, translates to bar-left slot;
 *            greeting cross-fades to "Today" 16/700 (greeting out 40–100,
 *            title in 100–160).
 *   120–200: status caption morphs into "working on N ›" right-slot;
 *            hairline + blur backdrop fade in.
 *   Scroll up past −40 (rubber-band) re-expands with the same curve.
 *   Reduced motion: two static states, 200ms cross-fade at threshold 100.
 *
 * Pure scroll-position → value maps, kept free of React/DOM so the numbers
 * are unit-testable; mv3-today.tsx drives element styles from these inside a
 * rAF scroll handler (transform/opacity only — WKWebView guardrails).
 */

/** Full collapse range (scrollY px). */
export const COLLAPSE_RANGE = 200;
/** Hero zone extents (px) — realized by scroll consumption, never height animation. */
export const HERO_EXPANDED_PX = 285;
export const HERO_CONDENSED_PX = 56;
/** Center ring extents (px). */
export const RING_EXPANDED_PX = 80;
export const RING_CONDENSED_PX = 30;
/** Reduced motion: the two-static-states flip threshold + cross-fade length. */
export const REDUCED_MOTION_THRESHOLD = 100;
export const REDUCED_MOTION_FADE_MS = 200;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Linear segment progress: 0 before `from`, 1 past `to`. */
export function seg(y: number, from: number, to: number): number {
  return clamp01((y - from) / (to - from));
}

/** 0–80 — orbit chips: opacity 1→0, scale 1→.92. */
export function chipFade(y: number): { opacity: number; scale: number } {
  const t = seg(y, 0, 80);
  return { opacity: 1 - t, scale: 1 - 0.08 * t };
}

/** 0–80 — guide rings fade to .3. */
export function guideRingOpacity(y: number): number {
  return 1 - 0.7 * seg(y, 0, 80);
}

/** 40–160 — center-ring morph progress (drives scale + translate together). */
export function ringProgress(y: number): number {
  return seg(y, 40, 160);
}

/** 40–160 — ring scale 80→30px expressed as a transform scale factor. */
export function ringScale(y: number): number {
  const p = ringProgress(y);
  return 1 - (1 - RING_CONDENSED_PX / RING_EXPANDED_PX) * p;
}

/** 40–100 — greeting (large title) fades out. */
export function greetingOpacity(y: number): number {
  return 1 - seg(y, 40, 100);
}

/** 100–160 — condensed "Today" 16/700 fades in. */
export function condensedTitleOpacity(y: number): number {
  return seg(y, 100, 160);
}

/** 120–200 — status caption fades out as the right slot takes over. */
export function captionOpacity(y: number): number {
  return 1 - seg(y, 120, 200);
}

/** 120–200 — "working on N ›" right slot fades in. */
export function condensedRightOpacity(y: number): number {
  return seg(y, 120, 200);
}

/** 120–200 — condensed-bar hairline + blur backdrop fade in. */
export function barChromeOpacity(y: number): number {
  return seg(y, 120, 200);
}

/**
 * 150–190 — the ring HANDOFF: the morphing hero ring lives inside the page
 * scroller (UNDER the bar's blur chrome), so once the chrome starts becoming
 * opaque the in-scroller ring would drown behind it. By y≈150 the morph has
 * all but landed in the slot (p=0.92), so the two rings coincide — the hero
 * ring fades out and the bar's own 30px ring (above the chrome) fades in,
 * an invisible swap that also frees the morph from compensating arbitrarily
 * long scrolls. Opacity-only.
 */
export function ringHandoff(y: number): number {
  return seg(y, 150, 190);
}

/**
 * Measured geometry for the ring morph — captured once per mount/resize with
 * transforms cleared (never per frame):
 *   heroCx / heroCyDoc — the hero ring's untransformed center (x in viewport
 *   space, y in DOCUMENT space: rect.top + scrollTop).
 *   barCx / barCy — the condensed bar's 30px slot center, viewport space
 *   (the bar is an overlay pinned to the screen).
 */
export interface RingGeometry {
  heroCx: number;
  heroCyDoc: number;
  barCx: number;
  barCy: number;
}

/**
 * The 40–160 morph: translate the (scrolling) hero ring into the (pinned)
 * bar-left slot. Because the hero ring rides the scroller, its viewport y is
 * `heroCyDoc − scrollY`; past p=1 the growing compensation keeps it pinned in
 * the slot however far the page scrolls. Transform-only.
 */
export function ringTransform(
  y: number,
  g: RingGeometry,
): { tx: number; ty: number; scale: number } {
  const p = ringProgress(y);
  const heroCyViewport = g.heroCyDoc - y;
  return {
    tx: (g.barCx - g.heroCx) * p,
    ty: (g.barCy - heroCyViewport) * p,
    scale: ringScale(y),
  };
}

/** Reduced motion: the two static states, flipped at threshold 100. */
export function reducedMode(y: number): "expanded" | "condensed" {
  return y >= REDUCED_MOTION_THRESHOLD ? "condensed" : "expanded";
}
