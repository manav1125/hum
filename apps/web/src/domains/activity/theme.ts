/**
 * Shared inline palette + type tokens for the Activity surface.
 *
 * Mirrors the v0.3 design-matched surfaces (next-moves-page / impact-page /
 * dashboard). The `C` palette points at the theme-aware `--mv1-*` CSS vars
 * (src/index.css): in light themes they resolve to the exact v0.3 hexes the
 * surface was designed with; under dark/velvet they swap to the dark-book
 * equivalents so these pages follow the active theme instead of pasting a
 * light canvas onto dark chrome. Editorial serif + DM Mono label fonts.
 */

// The serif-HQ palette + type tokens now live at the top-level so non-activity
// HQ domains (calls, intelligence) can consume them without a cross-domain
// import. Re-exported here so activity's own consumers are unchanged.
export { C, mono, serif } from "@/lib/hq-theme";

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
