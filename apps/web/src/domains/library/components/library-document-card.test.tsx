import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";

mock.module("react-router", () => ({
  Link: ({ to, children }: { to: string; children?: unknown }) =>
    createElement("a", { href: to }, children as never),
}));

const { LibraryDocumentCard } = await import(
  "@/domains/library/components/library-document-card"
);

type CardDocument = Parameters<typeof LibraryDocumentCard>[0]["document"];

const baseDocument: CardDocument = {
  surfaceId: "doc-1",
  conversationId: "conv-9",
  title: "Launch brief",
  wordCount: 120,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

afterEach(() => {
  cleanup();
});

describe("LibraryDocumentCard provenance", () => {
  // Chat → artifact already worked; the reverse did not. A document opened
  // from the Library had no route back to the thread that wrote it.
  test("links back to the conversation that produced the document", () => {
    render(
      createElement(LibraryDocumentCard, {
        document: {
          ...baseDocument,
          sourceConversation: { id: "conv-9", title: "Q3 planning" },
        },
        onOpen: () => {},
      }),
    );

    const label = screen.getByText("From Q3 planning");
    expect(label.closest("a")?.getAttribute("href")).toContain("conv-9");
  });

  test("names an untitled thread rather than rendering a blank link", () => {
    render(
      createElement(LibraryDocumentCard, {
        document: {
          ...baseDocument,
          sourceConversation: { id: "conv-9", title: null },
        },
        onOpen: () => {},
      }),
    );

    expect(screen.getByText("From Untitled conversation")).toBeDefined();
  });

  // The stored `conversationId` alone proves nothing — the thread may have
  // been deleted. The daemon omits `sourceConversation` in that case and the
  // card must show no link at all rather than one that lands nowhere.
  test("shows no provenance when the daemon could not resolve the thread", () => {
    render(
      createElement(LibraryDocumentCard, {
        document: baseDocument,
        onOpen: () => {},
      }),
    );

    expect(screen.getByText("Launch brief")).toBeDefined();
    expect(screen.queryByText(/^From /)).toBeNull();
  });
});
