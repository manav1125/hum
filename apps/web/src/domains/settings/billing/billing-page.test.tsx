/**
 * Tests for `ManagePlatformBillingLink` — the external billing link shown on
 * the self-host billing page (`billingGate === "disabled"` branch).
 *
 * Strategy: pre-populate the React Query cache with the daemon's
 * `config/platform` response so the component's `useQuery` resolves
 * synchronously (fresh within its `staleTime`, so no mount refetch), and
 * drive the active-assistant id through the zustand store the component
 * reads. Renders via `@testing-library/react` (happy-dom) — a DOM render,
 * not `renderToStaticMarkup`, because zustand's `useSyncExternalStore`
 * serves `getInitialState()` to server renders, which would hide the
 * per-test `setState` writes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";

import { ManagePlatformBillingLink } from "@/domains/settings/billing/billing-page";
import { configPlatformGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const ASSISTANT_ID = "asst-billing-test";

afterEach(() => {
  cleanup();
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

function makeClient(baseUrl?: string): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (baseUrl !== undefined) {
    client.setQueryData(
      configPlatformGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
      { baseUrl, success: true },
    );
  }
  return client;
}

function renderLink(client: QueryClient): HTMLElement {
  const { container } = render(
    <QueryClientProvider client={client}>
      <ManagePlatformBillingLink />
    </QueryClientProvider>,
  );
  return container;
}

function linkIn(container: HTMLElement): HTMLAnchorElement | null {
  return container.querySelector("a");
}

describe("ManagePlatformBillingLink", () => {
  test("links to <platform.baseUrl>/billing when the daemon reports one", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
    const container = renderLink(makeClient("https://justcue.ai"));
    const link = linkIn(container);
    expect(link?.getAttribute("href")).toBe("https://justcue.ai/billing");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.textContent).toContain("Manage billing on justcue.ai");
  });

  test("labels the link with a custom platform host", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
    const container = renderLink(makeClient("https://hq.example.com"));
    const link = linkIn(container);
    expect(link?.getAttribute("href")).toBe("https://hq.example.com/billing");
    expect(link?.textContent).toContain("Manage billing on hq.example.com");
  });

  test("falls back to justcue.ai when the daemon reports an internal default", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
    const container = renderLink(makeClient("https://platform.vellum.ai"));
    const link = linkIn(container);
    expect(link?.getAttribute("href")).toBe("https://justcue.ai/billing");
    expect(link?.textContent).toContain("Manage billing on justcue.ai");
  });

  test("renders the fallback immediately when no assistant is active", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
    const container = renderLink(makeClient());
    expect(linkIn(container)?.getAttribute("href")).toBe(
      "https://justcue.ai/billing",
    );
  });

  test("holds the link while the daemon read is still pending", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
    // No cached data → the query is pending on the initial render. Pin the
    // fetch (resolved by the generated client at call time via
    // `globalThis.fetch`) to a never-settling promise so the mount-triggered
    // request neither hits a real socket nor settles mid-test.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      new Promise<Response>(() => {})) as unknown as typeof globalThis.fetch;
    try {
      const container = renderLink(makeClient());
      expect(linkIn(container)).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
