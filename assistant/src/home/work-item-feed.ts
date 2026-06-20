/**
 * Surface queued work-items on the Home feed.
 *
 * The work queue (`work-items/work-item-store.ts`) is a separate store that
 * backs the Activity page. Items the agent adds there — e.g. "reply to this
 * Slack thread" — never showed on Home, because Home renders only the
 * on-disk `home-feed.json`. This module bridges the gap: it maps queued
 * work-items into `FeedItem`s so `handleGetHomeFeed` can union them with the
 * action-board cards.
 *
 * This is a **deterministic** path — no model is involved. The mapping is a
 * pure function (`workItemToFeedItem`), exported for unit testing.
 *
 * Dedup: the aggregator drops any work-item whose `work-item:<id>` id already
 * exists in the on-disk feed, and also drops work-items whose run already
 * landed an action-board/triage card for the same source (so the same Slack
 * thread isn't listed twice — once as the queued work item and once as a
 * synthesized triage card).
 */

import type { WorkItem } from "../work-items/work-item-store.js";
import type { FeedItem, FeedItemCategory, FeedItemUrgency } from "./feed-types.js";

/** Stable id prefix for work-item-derived feed cards. */
export const WORK_ITEM_FEED_PREFIX = "work-item:";

/**
 * Map a work-item's `priorityTier` (0 = high, 1 = medium, 2 = low) to a feed
 * urgency. Tiers outside the known range fall back to "low".
 */
function tierToUrgency(tier: number): FeedItemUrgency {
  if (tier <= 0) return "high";
  if (tier === 1) return "medium";
  return "low";
}

/** Sort priority in [0,100], higher = more important. Mirrors the urgency. */
function tierToPriority(tier: number): number {
  if (tier <= 0) return 84;
  if (tier === 1) return 68;
  return 54;
}

/**
 * Map a work-item's `sourceType` to a feed category so the Home queue can
 * render a channel-accurate icon + provenance chip. Unknown / absent sources
 * default to "task".
 */
export function sourceTypeToCategory(
  sourceType: string | null,
): FeedItemCategory {
  switch ((sourceType ?? "").toLowerCase()) {
    case "slack":
      return "slack";
    case "telegram":
    case "telegram-bot":
      return "telegram";
    case "whatsapp":
      return "whatsapp";
    case "gmail":
    case "outlook":
    case "email":
      return "email";
    case "calendar":
    case "google-calendar":
    case "scheduling":
      return "scheduling";
    default:
      return "task";
  }
}

/**
 * Convert a single queued work-item into a Home `FeedItem`. Pure — no I/O,
 * no clock reads beyond the supplied `now`. The one-click action seeds a
 * conversation that runs the work item (the same prompt-driven primitive the
 * email cards use); the prompt names the item + its id so "run it" is
 * self-contained.
 */
export function workItemToFeedItem(item: WorkItem, now: Date): FeedItem {
  const category = sourceTypeToCategory(item.sourceType);
  // Fall back to `now` when a queued item somehow lacks a creation time.
  const createdIso = new Date(item.createdAt ?? now).toISOString();
  const summary =
    (item.notes ?? "").trim().length > 0
      ? item.notes!.trim()
      : "Queued task waiting to run.";

  return {
    id: `${WORK_ITEM_FEED_PREFIX}${item.id}`,
    type: "notification",
    priority: tierToPriority(item.priorityTier),
    title: item.title,
    summary,
    timestamp: createdIso,
    createdAt: createdIso,
    status: "new",
    category,
    urgency: tierToUrgency(item.priorityTier),
    fromAssistant: true,
    actions: [
      {
        id: "primary",
        label: "Run it",
        prompt: `Run the queued task "${item.title}" (work item ${item.id}). ${summary}`,
      },
    ],
    metadata: {
      kind: "work-item",
      workItemId: item.id,
      ...(item.sourceType ? { sourceType: item.sourceType } : {}),
      ...(item.sourceId ? { sourceId: item.sourceId } : {}),
    },
  };
}

/**
 * Union the on-disk feed items with queued work-items mapped to FeedItems.
 *
 * Dedup rules (deterministic):
 *   - Skip any work-item whose `work-item:<id>` already exists in `feedItems`.
 *   - Skip any work-item whose `sourceType` + `sourceId` already matches the
 *     source of an existing feed item (so a synthesized triage card and the
 *     queued work item for the same Slack/Telegram message don't both show).
 *
 * Returns a new array; inputs are not mutated. The caller is responsible for
 * any final sort (the writer/route already sorts by priority).
 */
export function mergeWorkItemsIntoFeed(
  feedItems: FeedItem[],
  workItems: WorkItem[],
  now: Date,
): FeedItem[] {
  const existingIds = new Set(feedItems.map((i) => i.id));
  const existingSources = new Set<string>();
  for (const i of feedItems) {
    const md = i.metadata as
      | {
          sourceType?: unknown;
          sourceId?: unknown;
          channel?: unknown;
          sourceConversationId?: unknown;
        }
      | undefined;
    const srcType =
      typeof md?.sourceType === "string"
        ? md.sourceType
        : typeof md?.channel === "string"
          ? md.channel
          : undefined;
    const srcId =
      typeof md?.sourceId === "string"
        ? md.sourceId
        : typeof md?.sourceConversationId === "string"
          ? md.sourceConversationId
          : undefined;
    if (srcType && srcId) existingSources.add(`${srcType}:${srcId}`);
  }

  const mapped: FeedItem[] = [];
  for (const wi of workItems) {
    const id = `${WORK_ITEM_FEED_PREFIX}${wi.id}`;
    if (existingIds.has(id)) continue;
    if (wi.sourceType && wi.sourceId) {
      if (existingSources.has(`${wi.sourceType}:${wi.sourceId}`)) continue;
    }
    mapped.push(workItemToFeedItem(wi, now));
  }

  return [...feedItems, ...mapped];
}
