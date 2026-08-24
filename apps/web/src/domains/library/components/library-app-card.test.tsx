/**
 * Apps are the bulk of the Library, and they were the one artifact type whose
 * card offered no way back to the thread that built it — documents and media
 * already did. The link existed only inside the opened app viewer, which meant
 * finding it required opening the app first.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";

mock.module("react-router", () => ({
  Link: ({ to, children }: { to: string; children?: unknown }) =>
    createElement("a", { href: to }, children as never),
}));

const { LibraryAppCard } = await import(
  "@/domains/library/components/library-app-card"
);

type CardApp = Parameters<typeof LibraryAppCard>[0]["app"];

const baseApp: CardApp = {
  id: "app-1",
  name: "Cue Success Dashboard",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  version: "1.0.0",
  contentId: "content-1",
};

function renderCard(app: CardApp) {
  return render(
    createElement(LibraryAppCard, {
      app,
      assistantId: "assistant-1",
      isPinned: false,
      onOpen: () => {},
      onPin: () => {},
    }),
  );
}

afterEach(() => {
  cleanup();
});

describe("LibraryAppCard provenance", () => {
  test("links back to the conversation that produced the app", () => {
    renderCard({
      ...baseApp,
      sourceConversation: { id: "conv-9", title: "Q3 planning" },
    });

    const label = screen.getByText("From Q3 planning");
    expect(label.closest("a")?.getAttribute("href")).toContain("conv-9");
  });

  test("names an untitled thread rather than rendering a blank link", () => {
    renderCard({
      ...baseApp,
      sourceConversation: { id: "conv-9", title: null },
    });

    expect(screen.getByText("From Untitled conversation")).toBeDefined();
  });

  // The daemon omits `sourceConversation` when the thread no longer exists.
  // A card must then show nothing rather than a link into a deleted thread.
  test("shows no provenance when the daemon could not resolve the thread", () => {
    renderCard(baseApp);

    expect(screen.getByText("Cue Success Dashboard")).toBeDefined();
    expect(screen.queryByText(/^From /)).toBeNull();
  });
});
