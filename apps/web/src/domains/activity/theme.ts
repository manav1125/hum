/**
 * Shared inline palette + type tokens for the Activity surface.
 *
 * Mirrors the v0.3 design-matched surfaces (next-moves-page / impact-page /
 * dashboard): an inline-hex `C` palette so the surface renders identically
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

/** Small helpers shared by the section components for narrowing opaque payloads. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Best-effort epoch (ms or s) → "3m ago" / "in 2h" relative label. */
export function relativeTime(epoch: number | null | undefined): string | null {
  if (epoch == null || !Number.isFinite(epoch)) return null;
  // Daemon timestamps are inconsistent (some seconds, some ms). Normalise:
  // anything below ~10^12 is treated as seconds.
  const ms = epoch < 1e12 ? epoch * 1000 : epoch;
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const future = diff > 0;
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return future ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}
