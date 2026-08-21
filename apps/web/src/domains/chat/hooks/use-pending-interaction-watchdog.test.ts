/**
 * The fallback for an approval whose SSE event never landed.
 *
 * The reported failure: a run sits on "Working" for 30+ minutes with no
 * prompt, and the only way to see the Allow/Deny buttons is to open the same
 * conversation somewhere else. Both existing repairs miss it —
 * `restorePendingInteractions` fires on history load and stream reopen, and
 * the message-reconciliation loop stops after 60 seconds and reconciles
 * messages rather than interactions.
 */

import { describe, expect, test } from "bun:test";

import {
  PENDING_INTERACTION_POLL_MS,
  shouldPollForPendingInteraction,
} from "@/domains/chat/hooks/use-pending-interaction-watchdog";

const CONV = "conv-1";

function state(
  overrides: Partial<
    Parameters<typeof shouldPollForPendingInteraction>[0]
  > = {},
) {
  return {
    activeTurnId: "turn-1",
    hasPrompt: false,
    activeConversationId: CONV,
    conversationId: CONV,
    ...overrides,
  };
}

describe("shouldPollForPendingInteraction", () => {
  test("polls while a turn runs with nothing to answer", () => {
    // The reported case: the turn is live, the user has no buttons.
    expect(shouldPollForPendingInteraction(state())).toBe(true);
  });

  test("does not poll when no turn is running", () => {
    // Nothing is stuck; an idle conversation should cost no requests.
    expect(shouldPollForPendingInteraction(state({ activeTurnId: null }))).toBe(
      false,
    );
  });

  test("does not poll while a prompt is already on screen", () => {
    // Re-asking could only replace a live prompt with a copy of itself.
    expect(shouldPollForPendingInteraction(state({ hasPrompt: true }))).toBe(
      false,
    );
  });

  test("does not apply to a conversation the user has left", () => {
    // A timer that fires after the user navigates away must not put one
    // conversation's approval on top of another.
    expect(
      shouldPollForPendingInteraction(
        state({ activeConversationId: "conv-other" }),
      ),
    ).toBe(false);
  });

  test("a running turn with a prompt AND a switched conversation still does not poll", () => {
    expect(
      shouldPollForPendingInteraction(
        state({ hasPrompt: true, activeConversationId: "conv-other" }),
      ),
    ).toBe(false);
  });
});

describe("poll interval", () => {
  test("is slow enough to be invisible, fast enough to beat noticing by hand", () => {
    // The failure it replaces was measured in tens of minutes.
    expect(PENDING_INTERACTION_POLL_MS).toBeGreaterThanOrEqual(5_000);
    expect(PENDING_INTERACTION_POLL_MS).toBeLessThanOrEqual(30_000);
  });

  test("keeps checking past the 60s ceiling the reconciliation loop stops at", () => {
    // The message-reconciliation loop gives up at RECONCILE_MAX_MS (60s).
    // This watchdog has no lifetime bound at all — it stops when the turn
    // stops — so a stall longer than a minute still recovers.
    const ticksInFirstFiveMinutes = Math.floor(
      (5 * 60_000) / PENDING_INTERACTION_POLL_MS,
    );
    expect(ticksInFirstFiveMinutes).toBeGreaterThan(
      60_000 / PENDING_INTERACTION_POLL_MS,
    );
  });
});
