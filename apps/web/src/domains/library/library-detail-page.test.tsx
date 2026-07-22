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
