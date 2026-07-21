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
  danger: "var(--mv1-danger)",
} as const;

export const mono = "'DM Mono', ui-monospace, monospace";
export const serif = "'Instrument Serif', Georgia, serif";
