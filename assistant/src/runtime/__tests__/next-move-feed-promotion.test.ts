/**
 * HQ's most prominent card must never render with no way to act.
 *
 * `◆ YOUR NEXT MOVE` is the top of HQ. A feed item promoted into it can only
 * ever offer `open_thread`, and the card navigates by `sourceConversationId`
 * — deliberately, because an earlier version offered the button without one
 * and rendered a live control wired to nothing.
 *
 * Action-board feed items never set a conversation id. So promoting one
 * produced a card with a headline, a line of reasoning, and **no button at
 * all** — on the surface the owner looks at first, in the slot reserved for
 * the single most important thing Cue has for them.
 *
 * The client gate was right. The mistake was upstream: offering a candidate
 * whose only action could never fire. This is the same rule one step earlier —
 * don't offer an affordance for something that isn't there.
 *
 * Found while retiring the action board, which turned out to have been deleted
 * from the web months ago; this was the live wreckage left underneath it.
 */

import { describe, expect, test } from "bun:test";

import type { FeedItem } from "../../home/feed-types.js";
import { isPromotableFeedItem } from "../next-move.js";

/** A feed item that is promotable in every respect the caller controls. */
function item(extra: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "feed-1",
    title: "Three replies are waiting",
    summary: "Two from people you know.",
    status: "new",
    createdAt: new Date("2026-08-03T09:00:00Z").toISOString(),
    actions: [{ id: "open", label: "Open", kind: "open_thread" }],
    conversationId: "conv-1",
    ...extra,
  } as FeedItem;
}

describe("isPromotableFeedItem", () => {
  test("a complete item is promotable", () => {
    expect(isPromotableFeedItem(item())).toBe(true);
  });

  test("no conversation id means no promotion — this is the bug", () => {
    // The card cannot navigate without one, so the button will not render,
    // so the card would be inert. Every action-board item looks like this.
    expect(isPromotableFeedItem(item({ conversationId: undefined }))).toBe(
      false,
    );
    expect(isPromotableFeedItem(item({ conversationId: "" }))).toBe(false);
  });

  test("an item with no actions is not promotable", () => {
    expect(isPromotableFeedItem(item({ actions: [] }))).toBe(false);
    expect(isPromotableFeedItem(item({ actions: undefined }))).toBe(false);
  });

  test("only items still needing attention are promotable", () => {
    // The real union is new | seen | acted_on | dismissed. Spelled out rather
    // than cast, so adding a fifth status fails here and someone has to decide
    // which side of the line it sits on.
    expect(isPromotableFeedItem(item({ status: "new" }))).toBe(true);
    expect(isPromotableFeedItem(item({ status: "seen" }))).toBe(true);
    expect(isPromotableFeedItem(item({ status: "acted_on" }))).toBe(false);
    expect(isPromotableFeedItem(item({ status: "dismissed" }))).toBe(false);
  });

  test("every condition is independently necessary", () => {
    // Guards against a future simplification that collapses the three checks
    // into one and quietly loses the conversation-id half — which is the only
    // one that was ever missing.
    expect(
      isPromotableFeedItem(item({ conversationId: undefined, actions: [] })),
    ).toBe(false);
    expect(
      isPromotableFeedItem(
        item({ status: "acted_on", conversationId: "conv-1" }),
      ),
    ).toBe(false);
  });
});
