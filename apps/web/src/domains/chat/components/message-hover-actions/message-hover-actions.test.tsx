import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageHoverActions } from "@/domains/chat/components/message-hover-actions/message-hover-actions";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { textBody } from "@/domains/chat/utils/message-test-helpers";
import { useBookmarkStore } from "@/stores/bookmark-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

describe("MessageHoverActions", () => {
  test("renders the timestamp even when no actions are available", () => {
    const message: DisplayMessage = {
      id: "m1",
      role: "assistant",
      timestamp: Date.UTC(2026, 0, 2, 12, 34),
      ...textBody(""),
    };
    const html = renderToStaticMarkup(
      <MessageHoverActions message={message} />,
    );

    expect(html).toContain("title=");
    expect(html).toContain("select-none");
  });

  test("renders inspect action for user messages when provided", () => {
    const message: DisplayMessage = {
      id: "m2",
      role: "user",
      timestamp: Date.UTC(2026, 0, 2, 12, 34),
      ...textBody("hello"),
    };
    const html = renderToStaticMarkup(
      <MessageHoverActions message={message} onInspect={() => {}} />,
    );

    expect(html).toContain('title="Inspect"');
  });

  test("renders the retry action only when onRetry is provided", () => {
    const message: DisplayMessage = {
      id: "m3",
      role: "assistant",
      timestamp: Date.UTC(2026, 0, 2, 12, 34),
      ...textBody("answer"),
    };
    const without = renderToStaticMarkup(
      <MessageHoverActions message={message} />,
    );
    expect(without).not.toContain('title="Retry"');

    const withRetry = renderToStaticMarkup(
      <MessageHoverActions message={message} onRetry={() => {}} />,
    );
    expect(withRetry).toContain('title="Retry"');
  });
});

describe("MessageHoverActions bookmark toggle", () => {
  // DOM render (not static markup): zustand's SSR path reads the store's
  // INITIAL state, so seeded test state is only visible to a client render.
  const assistantMessage = (id: string): DisplayMessage => ({
    id,
    role: "assistant",
    timestamp: Date.UTC(2026, 0, 2, 12, 34),
    ...textBody("answer"),
  });

  beforeEach(() => {
    useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
    useClientFeatureFlagStore.setState({ bookmarks: true });
    // `loadedAssistantId` matches the active assistant so the mount effect's
    // `loadBookmarks` no-ops instead of firing a network request.
    useBookmarkStore.setState({
      bookmarks: [],
      bookmarkedMessageIds: new Set<string>(),
      loadedAssistantId: "asst-1",
    });
  });

  afterEach(() => {
    cleanup();
  });

  const bookmarkButton = (container: HTMLElement) =>
    container.querySelector(
      'button[title="Bookmark message"], button[title="Remove bookmark"]',
    );

  test("renders the bookmark action for a persisted message", () => {
    const { container } = render(
      <MessageHoverActions message={assistantMessage("m10")} />,
    );
    expect(bookmarkButton(container)?.getAttribute("title")).toBe(
      "Bookmark message",
    );
  });

  test("shows the remove state when the message is bookmarked", () => {
    useBookmarkStore.setState({
      bookmarkedMessageIds: new Set(["m11"]),
    });
    const { container } = render(
      <MessageHoverActions message={assistantMessage("m11")} />,
    );
    expect(bookmarkButton(container)?.getAttribute("title")).toBe(
      "Remove bookmark",
    );
  });

  test("hidden for optimistic (unpersisted) rows", () => {
    const { container } = render(
      <MessageHoverActions
        message={{ ...assistantMessage("m12"), isOptimistic: true }}
      />,
    );
    expect(bookmarkButton(container)).toBeNull();
  });

  test("hidden when the bookmarks flag is off", () => {
    useClientFeatureFlagStore.setState({ bookmarks: false });
    const { container } = render(
      <MessageHoverActions message={assistantMessage("m13")} />,
    );
    expect(bookmarkButton(container)).toBeNull();
  });
});
