import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";

// The open call is the subject; everything else is scaffolding the route
// needs to mount.
let openCallCount = 0;
let openImpl: () => Promise<{ data: Record<string, unknown> }> = async () => ({
  data: { appId: "app-1", name: "App", html: "<p>hi</p>" },
});
mock.module("@/generated/daemon/sdk.gen", () => ({
  appsByIdOpenPost: async () => {
    openCallCount++;
    return openImpl();
  },
}));

mock.module("react-router", () => ({
  useParams: () => ({ appId: "app-1" }),
  useNavigate: () => () => {},
  Link: ({ to, children }: { to: string; children?: unknown }) =>
    createElement("a", { href: to }, children as never),
}));

mock.module("@vellumai/design-library", () => ({
  toast: { success: () => {}, error: () => {} },
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "asst-1",
}));

mock.module("@/components/app-viewer-container", () => ({
  AppViewerContainer: () => createElement("div", null, "viewer"),
}));

mock.module("@/hooks/use-edit-app", () => ({
  useEditApp: () => () => {},
}));

mock.module("@/utils/app-html-cache", () => ({
  primeAppHtmlCache: () => {},
}));

mock.module("@/utils/share-app", () => ({
  shareApp: async () => {},
}));

const { LibraryDetailPage, describeOpenFailure } = await import(
  "@/domains/library/library-detail-page"
);

beforeEach(() => {
  openCallCount = 0;
});

afterEach(() => {
  cleanup();
});

describe("describeOpenFailure", () => {
  // `appsByIdOpenPost({ throwOnError: true })` throws the *parsed error
  // body*, not an Error — so the old `err instanceof Error` check almost
  // never matched and a gateway 504 rendered as a contentless "Failed to
  // open app", indistinguishable from a genuinely missing app.
  test("surfaces the message from a thrown error body", () => {
    expect(describeOpenFailure({ error: "Gateway Timeout" })).toBe(
      "Gateway Timeout",
    );
  });

  test("surfaces a nested daemon error message", () => {
    expect(
      describeOpenFailure({ error: { code: "NOT_FOUND", message: "Not found" } }),
    ).toBe("Not found");
  });

  test("prefers a real Error's message", () => {
    expect(describeOpenFailure(new Error("Failed to fetch"))).toBe(
      "Failed to fetch",
    );
  });

  test("falls back when the thrown value carries nothing readable", () => {
    expect(describeOpenFailure({})).toBe("Failed to open app");
  });
});

describe("LibraryDetailPage provenance", () => {
  // The Library was a one-way door: an app opened here had no route back to
  // the thread that built it. The daemon only returns `sourceConversation`
  // once it has confirmed that thread still exists, so the link is either
  // real or absent — never a guess.
  test("links back to the conversation the app was built in", async () => {
    openImpl = async () => ({
      data: {
        appId: "app-1",
        name: "App",
        html: "<p>hi</p>",
        sourceConversation: { id: "conv-9", title: "Q3 planning" },
      },
    });

    render(createElement(LibraryDetailPage));

    const link = await screen.findByText("From Q3 planning");
    expect(link.closest("a")?.getAttribute("href")).toContain("conv-9");
  });

  test("names an untitled thread rather than showing a blank link", async () => {
    openImpl = async () => ({
      data: {
        appId: "app-1",
        name: "App",
        html: "<p>hi</p>",
        sourceConversation: { id: "conv-9", title: null },
      },
    });

    render(createElement(LibraryDetailPage));

    expect(await screen.findByText("From Untitled conversation")).toBeDefined();
  });

  test("shows no provenance when the daemon could not resolve the thread", async () => {
    openImpl = async () => ({
      data: { appId: "app-1", name: "App", html: "<p>hi</p>" },
    });

    render(createElement(LibraryDetailPage));

    await screen.findByText("viewer");
    expect(screen.queryByText(/^From /)).toBeNull();
  });
});

describe("LibraryDetailPage error state", () => {
  test("offers a retry that re-issues the open request", async () => {
    // A stalled daemon (504/transport drop) used to strand the user on a
    // terminal "Failed to open app / Back to Library" screen even though
    // the very next request would have succeeded.
    openImpl = async () => {
      throw { error: "Gateway Timeout" };
    };

    render(createElement(LibraryDetailPage));

    const retry = await screen.findByText("Try again");
    expect(screen.getByText("Gateway Timeout")).toBeDefined();
    expect(openCallCount).toBe(1);

    openImpl = async () => ({
      data: { appId: "app-1", name: "App", html: "<p>hi</p>" },
    });
    act(() => {
      retry.click();
    });

    await waitFor(() => {
      expect(openCallCount).toBe(2);
    });
    await waitFor(() => {
      expect(screen.getByText("viewer")).toBeDefined();
    });
  });
});
