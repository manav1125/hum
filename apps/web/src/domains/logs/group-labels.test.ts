/**
 * Group-label rendering, focused on the last line of defense for vendor
 * discretion.
 *
 * The picker no longer offers `model` / `provider` on a managed instance and
 * a deep link carrying either is coerced away (`usage-tab-state.test.ts`).
 * This layer covers the paths that bypass both: the old-daemon group-by
 * fallback, which can land on `model` without anyone choosing it, and any
 * future caller that forgets. A raw slug must not reach the DOM even then.
 */

import { describe, expect, test } from "bun:test";

import { NEUTRAL_MODEL_LABEL } from "@/assistant/use-managed-mode";
import {
  decorateUsageBreakdownGroups,
  isVendorUsageGroupBy,
  resolveUsageGroupLabel,
} from "@/domains/logs/group-labels";
import type { UsageGroupBreakdown } from "@/domains/logs/usage-types";

function group(name: string): UsageGroupBreakdown {
  return {
    group: name,
    groupId: name,
    groupKey: name,
    totalInputTokens: 10,
    totalOutputTokens: 10,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalEstimatedCostUsd: 1,
    eventCount: 1,
  };
}

describe("isVendorUsageGroupBy", () => {
  test("model and provider are the vendor's own identifiers", () => {
    expect(isVendorUsageGroupBy("model")).toBe(true);
    expect(isVendorUsageGroupBy("provider")).toBe(true);
  });

  test("dimensions describing the user's own work are not", () => {
    expect(isVendorUsageGroupBy("task")).toBe(false);
    expect(isVendorUsageGroupBy("profile")).toBe(false);
    expect(isVendorUsageGroupBy("schedule")).toBe(false);
    expect(isVendorUsageGroupBy("conversation")).toBe(false);
  });
});

describe("resolveUsageGroupLabel vendor discretion", () => {
  test("a model row renders neutrally on a managed instance", () => {
    const label = resolveUsageGroupLabel(
      "model",
      group("deepseek/deepseek-v4-pro"),
      { hideVendor: true },
    );
    expect(label).toBe(NEUTRAL_MODEL_LABEL);
    expect(label.toLowerCase()).not.toContain("deepseek");
  });

  test("a provider row too", () => {
    expect(
      resolveUsageGroupLabel("provider", group("openrouter"), {
        hideVendor: true,
      }).toLowerCase(),
    ).not.toContain("openrouter");
  });

  test("self-host still sees exactly what it is paying for", () => {
    expect(
      resolveUsageGroupLabel("model", group("deepseek/deepseek-v4-pro"), {
        hideVendor: false,
      }),
    ).toBe("deepseek/deepseek-v4-pro");
  });

  test("an absent hideVendor reads as self-host — this helper is not the gate", () => {
    // The gate is `hideVendorUi()` at the call site; this argument only
    // carries its answer. Defaulting to "show" here keeps the helper honest
    // about who decides.
    expect(resolveUsageGroupLabel("model", group("some/model"), {})).toBe(
      "some/model",
    );
  });

  test("non-vendor dimensions keep their metadata-driven labels", () => {
    expect(
      resolveUsageGroupLabel("task", group("mainAgent"), {
        hideVendor: true,
        callSites: {
          mainAgent: {
            id: "mainAgent",
            displayName: "Chat",
            description: "",
            domain: "chat",
          },
        },
      }),
    ).toBe("Chat");
  });
});

describe("decorateUsageBreakdownGroups", () => {
  test("collapses every model row to the neutral label on managed", () => {
    const decorated = decorateUsageBreakdownGroups(
      [group("deepseek/deepseek-v4-pro"), group("anthropic/claude-opus-4-6")],
      "model",
      { hideVendor: true },
    );
    expect(decorated.map((g) => g.group)).toEqual([
      NEUTRAL_MODEL_LABEL,
      NEUTRAL_MODEL_LABEL,
    ]);
  });
});
