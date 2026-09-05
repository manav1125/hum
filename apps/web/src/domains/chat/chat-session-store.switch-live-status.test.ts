import { beforeEach, describe, expect, test } from "bun:test";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import {
  EMPTY_LIVE_STATUS,
  useLiveStatusStore,
} from "@/domains/chat/live-status-store";
import { useTurnStore } from "@/domains/chat/turn-store";

/**
 * Re-entering a conversation must not resurrect live-status signal from a
 * previous mount. The per-conversation live slice (steps, step counter,
 * thinking preview) survives the stream consumer unmounting — the terminal
 * event that would have cleared it is dropped while no consumer is mounted
 * for the conversation. Left in place, those stale steps dress up a
 * finished run as live work ("Working … 3 steps" for a run that completed
 * minutes ago — Learn UAT, mobile).
 */

const ASSISTANT_ID = "asst-1";
const CONVERSATION_ID = "conv-A";

function seedStaleSlice(conversationId: string) {
  const live = useLiveStatusStore.getState();
  live.noteTurnStart(conversationId);
  live.noteToolStart(conversationId, {
    toolUseId: "tool-1",
    toolName: "course_generation",
  });
  live.noteThinkingDelta(conversationId, "Submitting course generation…");
}

beforeEach(() => {
  useLiveStatusStore.getState().resetAll();
  useTurnStore.getState().resetTurn();
  // Fresh switch-coordination state so each test's switch is a real one.
  useChatSessionStore.setState({
    previousConversationId: null,
    previousAssistantId: null,
    draftConversationIdResolution: false,
  });
});

describe("switchToConversation — live-status slice", () => {
  test("clears the entered conversation's stale live slice", () => {
    // GIVEN a live slice left over from a previous mount of the conversation
    seedStaleSlice(CONVERSATION_ID);
    expect(
      useLiveStatusStore.getState().byConversation[CONVERSATION_ID]?.stepCount,
    ).toBe(1);

    // WHEN the user enters the conversation
    useChatSessionStore.getState().switchToConversation({
      assistantId: ASSISTANT_ID,
      activeConversationId: CONVERSATION_ID,
    });

    // THEN the slice is dropped — readers see the empty status
    expect(
      useLiveStatusStore.getState().byConversation[CONVERSATION_ID],
    ).toBeUndefined();
  });

  test("leaves OTHER conversations' live slices untouched", () => {
    // GIVEN live signal for a different (still-streaming) conversation
    seedStaleSlice("conv-B");

    // WHEN the user enters conversation A
    useChatSessionStore.getState().switchToConversation({
      assistantId: ASSISTANT_ID,
      activeConversationId: CONVERSATION_ID,
    });

    // THEN conversation B's signal survives
    const sliceB = useLiveStatusStore.getState().byConversation["conv-B"];
    expect(sliceB).toBeDefined();
    expect(sliceB).not.toEqual(EMPTY_LIVE_STATUS);
    expect(sliceB?.stepCount).toBe(1);
  });

  test("keeps the slice across a draft→server id resolution", () => {
    // GIVEN an entered conversation whose send resolved a draft id, with
    // live signal from the in-flight turn
    useChatSessionStore.getState().switchToConversation({
      assistantId: ASSISTANT_ID,
      activeConversationId: CONVERSATION_ID,
    });
    seedStaleSlice(CONVERSATION_ID);
    useChatSessionStore.getState().markDraftResolution();

    // WHEN the id-resolution re-invokes the switch (not a real switch)
    useChatSessionStore.getState().switchToConversation({
      assistantId: ASSISTANT_ID,
      activeConversationId: CONVERSATION_ID,
    });

    // THEN the live turn's signal is preserved
    expect(
      useLiveStatusStore.getState().byConversation[CONVERSATION_ID]?.stepCount,
    ).toBe(1);
  });
});
