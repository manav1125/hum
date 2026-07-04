/**
 * Shared vocabulary for the Projects cowork surface — the category taxonomy,
 * a compact color/emoji palette, and small formatting helpers. Kept framework-
 * free so both the list, the detail board, and the new-project modal draw from
 * one source of truth.
 */

import { C } from "@/domains/activity/theme";

/** The four canonical category buckets the home groups by. */
export const CATEGORY_ORDER = ["personal", "professional", "other"] as const;

export type CategoryKey = (typeof CATEGORY_ORDER)[number] | "uncategorized";

export const CATEGORY_LABEL: Record<string, string> = {
  personal: "Personal",
  professional: "Professional",
  other: "Other",
  uncategorized: "Uncategorized",
};

/** Normalise a project's free-text category into a group bucket. */
export function categoryBucket(category: string | null): CategoryKey {
  if (!category) return "uncategorized";
  const c = category.trim().toLowerCase();
  if (c === "personal") return "personal";
  if (c === "professional" || c === "work") return "professional";
  if (c === "other" || c === "freeform") return "other";
  // Any free-text category still shows under "Other" so it's never lost.
  return "other";
}

/** Human label for a category value, falling back to the raw text. */
export function categoryLabel(category: string | null): string {
  if (!category) return "Uncategorized";
  const bucket = categoryBucket(category);
  if (bucket === "other" && category.trim().toLowerCase() !== "other") {
    // Preserve a bespoke free-text category verbatim.
    return category.trim();
  }
  return CATEGORY_LABEL[bucket] ?? category;
}

/** A calm swatch set that reads on both light and dark canvases. */
export const PROJECT_COLORS = [
  "#6366f1",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#8b5cf6",
  "#14b8a6",
] as const;

/** A small, work-flavoured emoji set for the picker. */
export const PROJECT_EMOJI = [
  "📁",
  "🚀",
  "💼",
  "🏠",
  "📊",
  "✍️",
  "🎯",
  "🧪",
  "💡",
  "📮",
  "🔧",
  "🌱",
  "📅",
  "🎨",
  "🔬",
  "💰",
] as const;

/** The lane definitions the project board renders, left → right. */
export const BOARD_LANES: ReadonlyArray<{
  key: "queued" | "running" | "review" | "done";
  statuses: readonly string[];
  label: string;
  accent: string;
}> = [
  {
    key: "queued",
    statuses: ["queued", "pending"],
    label: "Queued",
    accent: C.amber,
  },
  { key: "running", statuses: ["running"], label: "Running", accent: C.blue },
  {
    key: "review",
    statuses: ["awaiting_review"],
    label: "Review",
    accent: C.violet,
  },
  { key: "done", statuses: ["done"], label: "Done", accent: C.green },
];

export function laneForStatus(
  status: string,
): (typeof BOARD_LANES)[number]["key"] | null {
  for (const lane of BOARD_LANES) {
    if (lane.statuses.includes(status)) return lane.key;
  }
  return null;
}

export function statusTone(
  status: string,
): "green" | "blue" | "amber" | "violet" | "danger" | "neutral" {
  if (status === "done") return "green";
  if (status === "running") return "blue";
  if (status === "awaiting_review") return "violet";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "queued" || status === "pending") return "amber";
  return "neutral";
}
