import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import type { Conversation } from "@/types/conversation-types";

// ---------------------------------------------------------------------------
// Module mocks — spread the real modules, override only the seams under test
// (exhaustive mock factories rot; see repo test conventions).
// ---------------------------------------------------------------------------
const realMutationsModule = await import("@/utils/conversation-cache-mutations");
const realCacheModule = await import("@/utils/conversation-cache");
const realRefreshConversationRow = realMutationsModule.refreshConversationRow;
const realFindConversation = realCacheModule.findConversation;

let refreshRowSpy = mock(async (..._args: unknown[]) => {});
let findConversationResult: Conversation | undefined;

function cachedRow(overrides: Partial<Conversation> = {}): Conversation {
  return {
    conversationId: "conv-A",
    ...overrides,
  } as Conversation;
}

mock.module("@/utils/conversation-cache-mutations", () => ({
  ...realMutationsModule,
  refreshConversationRow: (...args: unknown[]) =>
    (refreshRowSpy as (...a: unknown[]) => Promise<void>)(...args),
}));
mock.module("@/utils/conversation-cache", () => ({
  ...realCacheModule,
  findConversation: () => findConversationResult,
}));

const { useConversationChangeEffects } = await import(
  "@/domains/chat/hooks/use-conversation-change-effects"
);

afterAll(() => {
  // Re-register the real modules so later files in a combined run (which
  // may test these modules for real) see the originals.
  mock.module("@/utils/conversation-cache-mutations", () => ({
    ...realMutationsModule,
    refreshConversationRow: realRefreshConversationRow,
  }));
  mock.module("@/utils/conversation-cache", () => ({
    ...realCacheModule,
    findConversation: realFindConversation,
  }));
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function renderEffects(
  assistantId: string | null,
  conversationId: string | null,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(
    ({ aid, cid }: { aid: string | null; cid: string | null }) =>
      useConversationChangeEffects(aid, cid),
    { wrapper, initialProps: { aid: assistantId, cid: conversationId } },
  );
}

beforeEach(() => {
  refreshRowSpy = mock(async () => {});
  findConversationResult = undefined;
});

afterEach(() => {
  cleanup();
});

describe("useConversationChangeEffects — row refresh on entry", () => {
  test("refreshes the conversation row when a conversation is entered", () => {
    /**
     * The cached row's `isProcessing` is only kept fresh while a consumer
     * for the conversation is mounted; a terminal event dropped while the
     * user was elsewhere latches it `true`. Re-entry must re-derive run
     * state from the server, or the Working banner shows for a finished run.
     */
    // GIVEN an entered conversation with a (possibly stale) cached row
    findConversationResult = cachedRow();
    renderEffects("asst-1", "conv-A");

    // THEN the row is refreshed from the server
    expect(refreshRowSpy).toHaveBeenCalledTimes(1);
    expect(refreshRowSpy.mock.calls[0]?.slice(1)).toEqual([
      "asst-1",
      "conv-A",
    ]);
  });

  test("refreshes again when switching to another conversation", () => {
    // GIVEN an entered conversation with a cached row
    findConversationResult = cachedRow();
    const { rerender } = renderEffects("asst-1", "conv-A");

    // WHEN the user switches to another conversation
    rerender({ aid: "asst-1", cid: "conv-B" });

    // THEN each entry re-derived its row
    expect(refreshRowSpy).toHaveBeenCalledTimes(2);
    expect(refreshRowSpy.mock.calls[1]?.slice(1)).toEqual([
      "asst-1",
      "conv-B",
    ]);
  });

  test("skips client-side draft conversations", () => {
    /**
     * A draft has no server row yet — refreshing would 404 and evict the
     * optimistic sidebar row.
     */
    // GIVEN the cache marks the entered conversation as a draft
    findConversationResult = cachedRow({
      conversationId: "draft-1",
      draft: true,
    });

    // WHEN the draft conversation is entered
    renderEffects("asst-1", "draft-1");

    // THEN no server refresh is attempted
    expect(refreshRowSpy).not.toHaveBeenCalled();
  });

  test("skips conversations no cache holds — useActiveConversation fetches those fresh", () => {
    /**
     * With no cached row there is nothing stale to fix, and the row-fetch
     * path in `useActiveConversation` pulls a fresh copy from the server;
     * refreshing an unknown (possibly draft) key here would only 404.
     */
    // GIVEN no cache holds the entered conversation
    findConversationResult = undefined;

    // WHEN it is entered
    renderEffects("asst-1", "conv-X");

    // THEN no refresh fires
    expect(refreshRowSpy).not.toHaveBeenCalled();
  });

  test("does nothing without an assistant or conversation", () => {
    // GIVEN no active conversation
    renderEffects("asst-1", null);
    // AND no resolved assistant
    renderEffects(null, "conv-A");

    // THEN no refresh fires
    expect(refreshRowSpy).not.toHaveBeenCalled();
  });
});
