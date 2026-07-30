/**
 * Tests for the "Teach Cue something" action on `MemoriesPage`.
 *
 * Regression guard: the header pill and the first-run empty-state button used
 * to `navigate("/assistant/")`, which RESUMES the user's last conversation
 * (often a stale thread) instead of starting a fresh teaching flow. Both now
 * call `onTeachCue`, which:
 *   1. parks a gentle teaching prompt ("Remember that ") in the shared
 *      pending-deep-link store (a prefill, not an auto-send), and
 *   2. navigates to a BRAND-NEW draft conversation
 *      (`/assistant/conversations/<uuid>`) — never `/assistant/`.
 *
 * The memory-items query and mobile hook are mocked so the page renders
 * without a live gateway; navigation is captured via a mocked `useNavigate`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";

const navigateMock = mock((_to: string) => {});

const actualRouter = await import("react-router");
mock.module("react-router", () => ({
  ...actualRouter,
  useNavigate: () => navigateMock,
}));

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => false,
  useMobileLayout: () => false,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "asst-test",
}));

const emptyItemsRef = { value: true };
mock.module(
  "@/domains/intelligence/memories/hooks/use-memory-items-query",
  () => ({
    useMemoryItemsQuery: () => ({
      data: emptyItemsRef.value
        ? { items: [], kindCounts: {} }
        : {
            items: [
              {
                id: "m1",
                kind: "preference",
                statement: "Prefers concise replies",
                subject: "you",
                confidence: 0.9,
                reinforcementCount: 2,
                sourceType: "chat",
                firstSeenAt: Date.now(),
                lastSeenAt: Date.now(),
              },
            ],
            kindCounts: {},
          },
      isLoading: false,
      isError: false,
      refetch: () => {},
    }),
  }),
);

const { MemoriesPage } = await import("@/domains/intelligence/memories-page");

const renderPage = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MemoriesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  navigateMock.mockClear();
  usePendingDeepLinkStore.getState().consumePendingComposerMessage();
});

afterEach(() => {
  cleanup();
});

describe("MemoriesPage — Teach Cue something", () => {
  test("header pill opens a FRESH conversation and prefills the composer", () => {
    emptyItemsRef.value = false; // non-empty list → header pill is present
    renderPage();

    fireEvent.click(screen.getByText(/Teach Cue something/i));

    // Navigated to a fresh draft conversation, NOT the resume-last route.
    expect(navigateMock).toHaveBeenCalledTimes(1);
    const target = navigateMock.mock.calls[0][0] as string;
    expect(target).toStartWith("/assistant/conversations/");
    expect(target).not.toBe("/assistant/");

    // Parked a teaching prefill for the composer to pick up on mount.
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      "Remember that ",
    );
  });

  test("first-run empty-state button uses the same fresh-conversation behavior", () => {
    emptyItemsRef.value = true; // firstRun empty state → "Teach Cue something" CTA
    renderPage();

    // Two matches exist (header pill + empty-state CTA); click the last one.
    const buttons = screen.getAllByText(/Teach Cue something/i);
    fireEvent.click(buttons[buttons.length - 1]);

    const target = navigateMock.mock.calls[0][0] as string;
    expect(target).toStartWith("/assistant/conversations/");
    expect(target).not.toBe("/assistant/");
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      "Remember that ",
    );
  });
});
