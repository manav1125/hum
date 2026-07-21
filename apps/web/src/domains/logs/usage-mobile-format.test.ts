import { describe, expect, test } from "bun:test";

import {
  buildSpendBars,
  formatTokensCompact,
  humanizeUsageActor,
  spendCaption,
} from "@/domains/logs/usage-mobile-format";
import type { UsageDayBucket } from "@/domains/logs/usage-types";

function bucket(partial: Partial<UsageDayBucket>): UsageDayBucket {
  return {
    bucketId: partial.date ?? "2026-07-13",
    date: "2026-07-13",
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCostUsd: 0,
    eventCount: 0,
    ...partial,
  };
}

describe("formatTokensCompact", () => {
  test("millions, thousands, small, zero", () => {
    expect(formatTokensCompact(2_400_000)).toBe("2.4M");
    expect(formatTokensCompact(1_000_000)).toBe("1M");
    expect(formatTokensCompact(512_340)).toBe("512.3k");
    expect(formatTokensCompact(930)).toBe("930");
    expect(formatTokensCompact(0)).toBe("0");
    expect(formatTokensCompact(Number.NaN)).toBe("0");
  });
});

describe("humanizeUsageActor", () => {
  test("snake_case actor ids read as labels", () => {
    expect(humanizeUsageActor("main_agent")).toBe("Main agent");
    expect(humanizeUsageActor("memory-extraction")).toBe("Memory extraction");
    expect(humanizeUsageActor("")).toBe("Unknown");
  });
});

describe("buildSpendBars", () => {
  const week = [
    bucket({ date: "2026-07-13", totalEstimatedCostUsd: 0.4, eventCount: 40 }),
    bucket({ date: "2026-07-14", totalEstimatedCostUsd: 1.12, eventCount: 214 }),
    bucket({ date: "2026-07-15", totalEstimatedCostUsd: 0.01, eventCount: 3 }),
    bucket({ date: "2026-07-16", totalEstimatedCostUsd: 0, eventCount: 0 }),
  ];

  test("bars are visible: % of peak with a floor, zero stays zero", () => {
    const bars = buildSpendBars(week, "daily");
    expect(bars[1].heightPct).toBe(100);
    expect(bars[1].isPeak).toBe(true);
    // 0.4/1.12 ≈ 35.7%
    expect(bars[0].heightPct).toBeCloseTo((0.4 / 1.12) * 100, 5);
    // Tiny non-zero day floors at 6% so it still paints.
    expect(bars[2].heightPct).toBe(6);
    expect(bars[3].heightPct).toBe(0);
  });

  test("all-zero window has no peak and no phantom bars", () => {
    const bars = buildSpendBars(
      [bucket({ date: "2026-07-13" }), bucket({ date: "2026-07-14" })],
      "daily",
    );
    expect(bars.every((b) => !b.isPeak)).toBe(true);
    expect(bars.every((b) => b.heightPct === 0)).toBe(true);
  });

  test("weekday labels for a week, day-of-month for a month", () => {
    const weekBars = buildSpendBars(week, "daily");
    // 2026-07-14 is a Tuesday.
    expect(weekBars[1].label).toBe(
      new Date(2026, 6, 14).toLocaleDateString(undefined, {
        weekday: "short",
      }),
    );
    const month = Array.from({ length: 30 }, (_, i) =>
      bucket({
        date: `2026-06-${String(i + 1).padStart(2, "0")}`,
        totalEstimatedCostUsd: 0.1,
        eventCount: 1,
      }),
    );
    const monthBars = buildSpendBars(month, "daily");
    expect(monthBars[13].label).toBe("14");
    // Sparse labeling: every 5th on a 30-bar chart.
    expect(monthBars.filter((b) => b.showLabel).length).toBeLessThan(10);
  });

  test("hourly labels compact to 12h", () => {
    const bars = buildSpendBars(
      [
        bucket({
          bucketId: "2026-07-20|14",
          date: "2026-07-20 14:00",
          totalEstimatedCostUsd: 0.2,
          eventCount: 4,
        }),
        bucket({
          bucketId: "2026-07-20|00",
          date: "2026-07-20 00:00",
          totalEstimatedCostUsd: 0.1,
          eventCount: 2,
        }),
      ],
      "hourly",
    );
    expect(bars[0].label).toBe("2p");
    expect(bars[1].label).toBe("12a");
  });
});

describe("spendCaption", () => {
  test("peak narrates 'Busiest day', others narrate the bucket", () => {
    const bars = buildSpendBars(
      [
        bucket({
          date: "2026-07-14",
          totalEstimatedCostUsd: 1.12,
          eventCount: 214,
        }),
        bucket({
          date: "2026-07-15",
          totalEstimatedCostUsd: 0.2,
          eventCount: 9,
        }),
      ],
      "daily",
    );
    expect(spendCaption(bars[0], "daily")).toBe(
      `Busiest day ${bars[0].label} — $1.12 · 214 calls`,
    );
    expect(spendCaption(bars[1], "daily")).toBe(
      `${bars[1].label} — $0.20 · 9 calls`,
    );
  });
});
