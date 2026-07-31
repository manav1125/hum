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
} as const;

export const mono = "'DM Mono', ui-monospace, monospace";
export const serif = "'Instrument Serif', Georgia, serif";
