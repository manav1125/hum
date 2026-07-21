/**
 * Pure formatting/derivation helpers for the mobile Usage & spend screen
 * (round-4 frame 61). Kept out of the page component so the chart math —
 * the part the mock itself got wrong (0-height percentage bars) — is
 * testable in isolation.
 */

import type { UsageDayBucket } from "./usage-types";

/** 2 400 000 → "2.4M" · 512 340 → "512.3k" · 930 → "930". */
export function formatTokensCompact(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count >= 1_000_000) {
    return `${trimTrailingZero((count / 1_000_000).toFixed(1))}M`;
  }
  if (count >= 1_000) {
    return `${trimTrailingZero((count / 1_000).toFixed(1))}k`;
  }
  return String(Math.round(count));
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

/** Daemon actor keys are snake_case subsystem ids ("main_agent"). */
export function humanizeUsageActor(group: string): string {
  const cleaned = group.replace(/[_-]+/g, " ").trim();
  if (!cleaned) return "Unknown";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export interface SpendBar {
  bucketId: string;
  /** Short axis label ("Mon" / "14" / "6a"). */
  label: string;
  /** Whether the axis label renders (sparse labeling on dense charts). */
  showLabel: boolean;
  costUsd: number;
  eventCount: number;
  /** 0–100 — bar height as % of the peak bucket. */
  heightPct: number;
  isPeak: boolean;
}

/**
 * Bucket list → bar models. Heights are % of the peak bucket's cost, with a
 * 6% visible floor for any non-zero bucket (a $0.001 day must still paint).
 * Peak = highest cost; ties resolve to the earliest bucket.
 */
export function buildSpendBars(
  buckets: readonly UsageDayBucket[],
  granularity: "daily" | "hourly",
): SpendBar[] {
  if (buckets.length === 0) return [];
  const maxCost = Math.max(...buckets.map((b) => b.totalEstimatedCostUsd));
  const peakIndex =
    maxCost > 0
      ? buckets.findIndex((b) => b.totalEstimatedCostUsd === maxCost)
      : -1;
  const labelEvery = labelStride(buckets.length);
  return buckets.map((bucket, i) => {
    const cost = bucket.totalEstimatedCostUsd;
    const raw = maxCost > 0 ? (cost / maxCost) * 100 : 0;
    return {
      bucketId: bucket.bucketId,
      label: barLabel(bucket, granularity, buckets.length),
      showLabel: i % labelEvery === 0 || i === peakIndex,
      costUsd: cost,
      eventCount: bucket.eventCount,
      heightPct: cost > 0 ? Math.max(raw, 6) : 0,
      isPeak: i === peakIndex,
    };
  });
}

/** ≤10 bars label all; ~24 (hourly) every 4th; ~30 (30d) every 5th. */
function labelStride(count: number): number {
  if (count <= 10) return 1;
  if (count <= 24) return 4;
  return 5;
}

function barLabel(
  bucket: UsageDayBucket,
  granularity: "daily" | "hourly",
  bucketCount = 7,
): string {
  if (granularity === "hourly") {
    // Hourly bucket dates look like "2026-07-20 14:00" (or carry an hour in
    // bucketId "…|14"). Render a compact 12h label.
    const match =
      /\b([01]?\d|2[0-3]):00$/.exec(bucket.date) ??
      /\|(\d{1,2})$/.exec(bucket.bucketId);
    if (match) {
      const hour = Number(match[1]);
      if (Number.isFinite(hour)) {
        if (hour === 0) return "12a";
        if (hour === 12) return "12p";
        return hour < 12 ? `${hour}a` : `${hour - 12}p`;
      }
    }
    return bucket.displayLabel ?? bucket.date;
  }
  const ts = Date.parse(`${bucket.date}T00:00:00`);
  if (Number.isFinite(ts)) {
    const d = new Date(ts);
    // A week reads as weekdays ("Mon"); a month as days-of-month ("14").
    return bucketCount > 10
      ? String(d.getDate())
      : d.toLocaleDateString(undefined, { weekday: "short" });
  }
  return bucket.displayLabel ?? bucket.date;
}

/**
 * The narrated caption under the chart — real data only ("Busiest day Thu —
 * $1.12 · 214 calls"). When the user taps another bar, the caption narrates
 * that bucket instead.
 */
export function spendCaption(
  bar: SpendBar,
  granularity: "daily" | "hourly",
): string {
  const unit = granularity === "hourly" ? "Busiest hour" : "Busiest day";
  const calls = `${bar.eventCount} ${bar.eventCount === 1 ? "call" : "calls"}`;
  const cost = `$${bar.costUsd.toFixed(2)}`;
  if (bar.isPeak) {
    return `${unit} ${bar.label} — ${cost} · ${calls}`;
  }
  return `${bar.label} — ${cost} · ${calls}`;
}
