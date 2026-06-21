/**
 * Unit tests for the work-item → FeedItem mapping (Part A).
 *
 * These are pure functions — no DB, no clock dependence beyond the supplied
 * `now` — so they exercise the deterministic Home-feed aggregation directly.
 */

import { describe, expect, it } from "bun:test";

import type { WorkItem } from "../work-items/work-item-store.js";
import type { FeedItem } from "./feed-types.js";
import {
  dedupeFeedItems,
  mergeWorkItemsIntoFeed,
  sourceTypeToCategory,
  WORK_ITEM_FEED_PREFIX,
  workItemToFeedItem,
} from "./work-item-feed.js";

const NOW = new Date("2026-06-20T12:00:00Z");

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi-1",
    taskId: "task-1",
    title: "Reply to Jane in #eng",
    notes: "She asked about the Q3 budget.",
    status: "queued",
    priorityTier: 1,
    sortIndex: null,
    lastRunId: null,
    lastRunConversationId: null,
    lastRunStatus: null,
    sourceType: "slack",
    sourceId: "C123",
    requiredTools: null,
    approvedTools: null,
    approvalStatus: "none",
    createdAt: Date.parse("2026-06-20T09:00:00Z"),
    updatedAt: Date.parse("2026-06-20T09:00:00Z"),
    ...overrides,
  };
}

function makeFeedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "action-board:2026-06-20:0",
    type: "notification",
    priority: 80,
    summary: "An email card",
    timestamp: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    status: "new",
    category: "email",
    ...overrides,
  };
}

describe("sourceTypeToCategory", () => {
  it("maps known messaging sources to channel categories", () => {
    expect(sourceTypeToCategory("slack")).toBe("slack");
    expect(sourceTypeToCategory("telegram-bot")).toBe("telegram");
    expect(sourceTypeToCategory("whatsapp")).toBe("whatsapp");
    expect(sourceTypeToCategory("gmail")).toBe("email");
    expect(sourceTypeToCategory("google-calendar")).toBe("scheduling");
  });

  it("defaults unknown / null sources to task", () => {
    expect(sourceTypeToCategory(null)).toBe("task");
    expect(sourceTypeToCategory("something-else")).toBe("task");
  });
});

describe("workItemToFeedItem", () => {
  it("maps a queued slack work-item to a channel-categorized card with one-click action", () => {
    const card = workItemToFeedItem(makeWorkItem(), NOW);
    expect(card.id).toBe(`${WORK_ITEM_FEED_PREFIX}wi-1`);
    expect(card.category).toBe("slack");
    expect(card.title).toBe("Reply to Jane in #eng");
    expect(card.summary).toBe("She asked about the Q3 budget.");
    expect(card.urgency).toBe("medium");
    expect(card.actions).toHaveLength(1);
    expect(card.actions![0].id).toBe("primary");
    expect(card.actions![0].prompt).toContain("wi-1");
    expect(card.metadata?.kind).toBe("work-item");
    expect(card.metadata?.sourceId).toBe("C123");
  });

  it("maps priority tiers to urgency", () => {
    expect(workItemToFeedItem(makeWorkItem({ priorityTier: 0 }), NOW).urgency).toBe(
      "high",
    );
    expect(workItemToFeedItem(makeWorkItem({ priorityTier: 2 }), NOW).urgency).toBe(
      "low",
    );
  });

  it("falls back to placeholder summary when notes are empty", () => {
    const card = workItemToFeedItem(makeWorkItem({ notes: null }), NOW);
    expect(card.summary).toBe("Queued task waiting to run.");
  });
});

describe("mergeWorkItemsIntoFeed", () => {
  it("appends queued work-items as feed cards", () => {
    const merged = mergeWorkItemsIntoFeed([makeFeedItem()], [makeWorkItem()], NOW);
    expect(merged).toHaveLength(2);
    expect(merged[1].id).toBe(`${WORK_ITEM_FEED_PREFIX}wi-1`);
  });

  it("dedups a work-item whose work-item:<id> card already exists", () => {
    const existing = makeFeedItem({ id: `${WORK_ITEM_FEED_PREFIX}wi-1` });
    const merged = mergeWorkItemsIntoFeed([existing], [makeWorkItem()], NOW);
    expect(merged).toHaveLength(1);
  });

  it("dedups a work-item whose source thread is already a triage card", () => {
    // A synthesized channel-triage card for the same Slack conversation.
    const triageCard = makeFeedItem({
      id: "action-board:2026-06-20:0",
      category: "slack",
      metadata: { channel: "slack", sourceConversationId: "C123" },
    });
    const merged = mergeWorkItemsIntoFeed([triageCard], [makeWorkItem()], NOW);
    expect(merged).toHaveLength(1);
  });

  it("keeps a work-item when its source differs from existing cards", () => {
    const triageCard = makeFeedItem({
      metadata: { channel: "slack", sourceConversationId: "C999" },
    });
    const merged = mergeWorkItemsIntoFeed([triageCard], [makeWorkItem()], NOW);
    expect(merged).toHaveLength(2);
  });

  it("collapses the same logical task enqueued under several work-item ids", () => {
    // Three queued work-items for the SAME commitment, each with its own UUID
    // (the agent re-enqueued it). They share a title; they're untitled-task
    // items (no channel source), so the title-based content key collapses them.
    const wis = ["5bd5b526", "0144e2ed", "538fffa3"].map((id) =>
      makeWorkItem({
        id,
        title: "Send OTP to Aileen for Guillermo's flight",
        sourceType: null,
        sourceId: null,
      }),
    );
    const merged = mergeWorkItemsIntoFeed([], wis, NOW);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe("Send OTP to Aileen for Guillermo's flight");
  });

  it("drops an exact-id duplicate present on disk and still queued", () => {
    // A work-item card already persisted on disk AND the same id still in the
    // queued set: the unioned list must not show it twice.
    const persisted = makeFeedItem({
      id: `${WORK_ITEM_FEED_PREFIX}538fffa3`,
      title: "Send OTP to Aileen for Guillermo's flight",
    });
    const merged = mergeWorkItemsIntoFeed(
      [persisted],
      [makeWorkItem({ id: "538fffa3" })],
      NOW,
    );
    expect(merged.filter((i) => i.id === `${WORK_ITEM_FEED_PREFIX}538fffa3`)).toHaveLength(
      1,
    );
  });
});

describe("dedupeFeedItems", () => {
  it("removes exact-id duplicates, keeping the higher-priority instance", () => {
    const low = makeFeedItem({ id: "x", title: "Task X", priority: 40 });
    const high = makeFeedItem({ id: "x", title: "Task X", priority: 90 });
    const deduped = dedupeFeedItems([low, high]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].priority).toBe(90);
  });

  it("collapses logical duplicates (distinct ids, same title + channel)", () => {
    const a = makeFeedItem({
      id: `${WORK_ITEM_FEED_PREFIX}a`,
      title: "Send OTP to Aileen for Guillermo's flight",
      category: "task",
      priority: 60,
    });
    const b = makeFeedItem({
      id: `${WORK_ITEM_FEED_PREFIX}b`,
      title: "send otp to aileen for guillermo's flight", // case-insensitive
      category: "task",
      priority: 80,
    });
    const deduped = dedupeFeedItems([a, b]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].priority).toBe(80);
  });

  it("does NOT collapse genuinely distinct titles", () => {
    const a = makeFeedItem({ id: "a", title: "Reply to Jane", category: "email" });
    const b = makeFeedItem({ id: "b", title: "Prep for standup", category: "scheduling" });
    expect(dedupeFeedItems([a, b])).toHaveLength(2);
  });

  it("does NOT collapse same title across different channels", () => {
    const slack = makeFeedItem({
      id: "a",
      title: "Follow up",
      metadata: { sourceType: "slack" },
    });
    const email = makeFeedItem({
      id: "b",
      title: "Follow up",
      metadata: { sourceType: "gmail" },
    });
    expect(dedupeFeedItems([slack, email])).toHaveLength(2);
  });

  it("preserves first-occurrence order", () => {
    const items = [
      makeFeedItem({ id: "1", title: "First" }),
      makeFeedItem({ id: "2", title: "Second" }),
      makeFeedItem({ id: "1", title: "First" }),
    ];
    const deduped = dedupeFeedItems(items);
    expect(deduped.map((i) => i.title)).toEqual(["First", "Second"]);
  });
});
