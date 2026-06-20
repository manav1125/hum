/**
 * Shared inline palette + type tokens for the template-library dashboard.
 *
 * Mirrors the v0.3 design-matched surfaces (next-moves-page / impact-page /
 * memories-page): an inline-hex `C` palette so the surface renders identically
 * regardless of theme-variable wiring, plus the editorial serif + DM Mono
 * label fonts.
 */

export const C = {
  ink: "#1A2230",
  blue: "#3D6EE8",
  blueS: "#2B53C4",
  blueW: "#DBE4FB",
  violet: "#7F77DD",
  violetS: "#534AB7",
  bg: "#F4F6F9",
  surface: "#FFFFFF",
  sunken: "#EEF1F6",
  line: "#E5E9F0",
  line2: "#D7DDE7",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#8D99A5",
  green: "#277E41",
  amber: "#C98A1B",
  danger: "#DA491A",
} as const;

export const mono = "'DM Mono', ui-monospace, monospace";
export const serif = "'Instrument Serif', Georgia, serif";
