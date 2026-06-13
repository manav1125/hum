import type { FeedItem, FeedItemCategory } from "@vellumai/assistant-api";

/**
 * Client-side grouping of feed items by recency. Not part of the wire
 * contract — derived in the UI from each item's `createdAt`.
 */
export type FeedTimeGroup = "today" | "yesterday" | "older";

/**
 * Sort feed items by priority descending, then by createdAt descending.
 */
export function sortFeedItems(items: FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

/**
 * Bucket items into "today", "yesterday", or "older" based on createdAt
 * in the local timezone. Returns a Map preserving order. Empty groups
 * are omitted.
 */
export function groupByTime(items: FeedItem[]): Map<FeedTimeGroup, FeedItem[]> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
  );

  const groups: Record<FeedTimeGroup, FeedItem[]> = {
    today: [],
    yesterday: [],
    older: [],
  };

  for (const item of items) {
    const created = new Date(item.createdAt);
    if (created >= todayStart) {
      groups.today.push(item);
    } else if (created >= yesterdayStart) {
      groups.yesterday.push(item);
    } else {
      groups.older.push(item);
    }
  }

  const result = new Map<FeedTimeGroup, FeedItem[]>();
  if (groups.today.length > 0) result.set("today", groups.today);
  if (groups.yesterday.length > 0) result.set("yesterday", groups.yesterday);
  if (groups.older.length > 0) result.set("older", groups.older);

  return result;
}

/**
 * Filter items by category. If category is null, return all items.
 */
export function filterByCategory(
  items: FeedItem[],
  category: FeedItemCategory | null,
): FeedItem[] {
  if (category === null) return items;
  return items.filter((item) => (item.category ?? "system") === category);
}

/**
 * Exclude items with urgency "high" or "critical".
 */
export function excludeHighUrgency(items: FeedItem[]): FeedItem[] {
  return items.filter(
    (item) => item.urgency !== "high" && item.urgency !== "critical",
  );
}

/**
 * Pick the single "next move" to feature in the Home hero (FocusCard): the
 * highest-priority high/critical-urgency item that hasn't been dismissed or
 * acted on. Returns null when nothing is urgent — the hero is then omitted.
 *
 * These urgent items are excluded from the recap feed (`excludeHighUrgency`),
 * so featuring the top one here surfaces it without duplicating it below.
 */
export function selectNextMove(items: FeedItem[]): FeedItem | null {
  return sortUrgent(items)[0] ?? null;
}

/**
 * The remaining urgent items (after the next move) for the Now rail's "Cue
 * noticed" section. Like the next move, these are excluded from the recap feed,
 * so surfacing them here doesn't duplicate anything below.
 */
export function selectNoticed(
  items: FeedItem[],
  excludeId: string | undefined,
  limit = 2,
): FeedItem[] {
  return sortUrgent(items)
    .filter((item) => item.id !== excludeId)
    .slice(0, limit);
}

function sortUrgent(items: FeedItem[]): FeedItem[] {
  const urgent = items.filter(
    (item) =>
      (item.urgency === "high" || item.urgency === "critical") &&
      item.status !== "dismissed" &&
      item.status !== "acted_on",
  );
  return sortFeedItems(urgent);
}

/**
 * Return deduplicated list of categories present in the items.
 */
export function getPresentCategories(items: FeedItem[]): FeedItemCategory[] {
  const categories = new Set<FeedItemCategory>();
  for (const item of items) {
    categories.add(item.category ?? "system");
  }
  return [...categories];
}
