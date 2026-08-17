/**
 * Shared serif-HQ inline palette + type tokens (lifted from domains/activity/theme
 * so multiple HQ domains — activity, calls, intelligence — can consume them without
 * a cross-domain import). The `C` palette points at the theme-aware `--mv1-*` CSS
 * vars (src/index.css). Editorial serif + DM Mono label fonts.
 */

export const C = {
  ink: "var(--mv1-t1)",
  blue: "var(--mv1-blue)",
  blueS: "var(--mv1-blue-strong)",
  blueW: "var(--mv1-blue-wash)",
  violet: "var(--mv1-violet)",
  violetS: "var(--mv1-violet-strong)",
  bg: "var(--mv1-canvas)",
  surface: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  green: "var(--mv1-green)",
  amber: "var(--mv1-amber)",
  teal: "var(--mv1-teal)",
  danger: "var(--mv1-danger)",
  /** Text leg for danger — small copy where colour is the only carrier (A1). */
  dangerText: "var(--mv1-danger-text)",
  red: "var(--mv1-red)",

  /* Text legs (design addendum A1). Everything above is a FILL leg — badge
   * grounds, glyph marks, rules, ring arcs, display type at 16px and up. Text
   * below 16px must use the `*Text` entry, which is the same hue a stop or two
   * darker and clears 4.5:1 on the light canvas; in dark these resolve to the
   * identical bright value, so the swap is light-only.
   *
   * The one exception: a fill leg may carry small text when an adjacent glyph
   * carries the same fact (the "‖" mark beside "Needs you"). Where colour is
   * the only carrier of the meaning, reach for the text leg. */
  blueText: "var(--mv1-blue-text)",
  violetText: "var(--mv1-violet-text)",
  amberText: "var(--mv1-amber-text)",
  tealText: "var(--mv1-teal-text)",
  greenText: "var(--mv1-green-text)",
  redText: "var(--mv1-red-text)",

  /* ── Ground and role (design v36/v37) ───────────────────────────────────
   *
   * The entries above name a HUE and leave the ground to whoever types them,
   * which is the shape design has now logged eleven recurrences of: *a value
   * correct for one ground or role applied to another*. These name the ground
   * instead, so the wrong value is not spellable in the right slot.
   *
   * Reach for `muted` by default. It is the theme-following alias, and a
   * surface whose ground does NOT follow the theme — a wash, a warm editorial
   * card, a permanent dark scrim — declares that ground once with
   * `data-ground="tint" | "paper" | "dark"` and everything inside it inherits
   * the right stop. That is design's "a tinted chip is a third ground": the
   * chip states what it is standing on, rather than each usage picking a hex.
   *
   * The `-on-` entries are INK. The lint (`local/no-on-token-as-ground`) fails
   * the build if one is painted as a background — two shipped bugs were
   * exactly that inversion. Definitions and measured ratios: src/index.css. */
  muted: "var(--muted)",
  mutedOnPaper: "var(--muted-on-paper)",
  mutedOnCanvas: "var(--muted-on-canvas)",
  mutedOnDark: "var(--muted-on-dark)",
  mutedOnTint: "var(--muted-on-tint)",

  /** Coloured control grounds, and the ink each one carries. Always a pair. */
  blueFill: "var(--blue-fill)",
  blueOnFill: "var(--blue-on-fill)",
  violetFill: "var(--violet-fill)",
  violetOnFill: "var(--violet-on-fill)",
  amberFill: "var(--amber-fill)",
  amberOnFill: "var(--amber-on-fill)",
  tealFill: "var(--teal-fill)",
  tealOnFill: "var(--teal-on-fill)",
  greenFill: "var(--green-fill)",
  greenOnFill: "var(--green-on-fill)",
  redFill: "var(--red-fill)",
  redOnFill: "var(--red-on-fill)",
  dangerFill: "var(--danger-fill)",
  dangerOnFill: "var(--danger-on-fill)",
} as const;

/**
 * The ground a subtree stands on, for surfaces whose ground does not follow
 * the theme. Spread onto the element that OWNS the ground — the chip, the
 * warm card, the dark scrim — and its descendants inherit the muted stop that
 * clears 4.5:1 there.
 *
 *   <span style={{ background: C.blueW, ...ground("tint") }}>
 *
 * The tint case is the one design added this round, and it is the one that
 * cannot be eyeballed: `#6B6B60` passes on paper (4.85:1) and fails on
 * paper-plus-a-wash (4.35:1), and the two grounds look near enough identical
 * in review that no amount of care separates them.
 */
export function ground(on: "paper" | "canvas" | "tint" | "dark") {
  return { "data-ground": on } as const;
}

export const mono = "'DM Mono', ui-monospace, monospace";
export const serif = "'Instrument Serif', Georgia, serif";
