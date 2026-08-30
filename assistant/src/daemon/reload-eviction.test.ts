/**
 * Saving a file must not kill work that is already running.
 *
 * Reload eviction aborts every subagent under the conversations it discards.
 * Subagents spawn asynchronously, so a parent waiting on a child is idle — and
 * reading that idleness as "nothing is happening here" is what let an owner
 * kill their own mid-task subagent by saving SOUL.md while watching it work.
 */

import { describe, expect, test } from "bun:test";

import { mayDiscardOnReload } from "./reload-eviction.js";

describe("mayDiscardOnReload", () => {
  test("an idle conversation with nothing under it can go", () => {
    expect(
      mayDiscardOnReload({ isProcessing: false, hasLiveChildren: false }),
    ).toBe(true);
  });

  test("a conversation mid-turn is kept", () => {
    expect(
      mayDiscardOnReload({ isProcessing: true, hasLiveChildren: false }),
    ).toBe(false);
  });

  test("an IDLE parent with a live subagent is kept", () => {
    // The whole bug. Async spawn leaves the parent idle between tool calls, so
    // this is the ordinary state of a conversation whose subagent is working.
    expect(
      mayDiscardOnReload({ isProcessing: false, hasLiveChildren: true }),
    ).toBe(false);
  });

  test("both busy is kept", () => {
    expect(
      mayDiscardOnReload({ isProcessing: true, hasLiveChildren: true }),
    ).toBe(false);
  });

  test("the same rule has to hold at the rebuild gate, not just the sweep", () => {
    // Marking the parent stale only defers the problem: the rebuild on next
    // access disposes it, which aborts the children too. Protecting one gate
    // and not the other relocates the death from file-save to the next touch.
    // This documents the pairing; the rebuild gate applies the identical
    // predicate in conversation-store's getOrCreateConversation.
    const parentWaitingOnChild = {
      isProcessing: false,
      hasLiveChildren: true,
    };
    expect(mayDiscardOnReload(parentWaitingOnChild)).toBe(false);
  });
});
