/**
 * The automations hooks must address the PER-ASSISTANT route.
 *
 * Regression: these hooks posted to bare `/v1/watchers/list` and
 * `/v1/playbooks/list`. The self-hosted auth interceptor only recognises
 * `/v1/assistants/{id}/…`, so those requests went out with no Authorization
 * header and came back 401 — every watcher and playbook read and write failed
 * on a self-hosted instance, and the Automations surface rendered a confident
 * "WATCHERS · 0" instead of saying it could not load. Captured from the live
 * app: `401 POST /v1/watchers/list auth=NONE`.
 *
 * The assertion is on the URL the client is handed, because that is the exact
 * property the interceptor keys on.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

const ASSISTANT_ID = "asst-42";

const posted: { url: string; body: unknown }[] = [];
mock.module("@/generated/daemon/client.gen", () => ({
  client: {
    post: mock(async ({ url, body }: { url: string; body: unknown }) => {
      posted.push({ url, body });
      return { data: [], response: { ok: true, status: 200 } };
    }),
  },
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));

const {
  useWatchers,
  usePlaybooks,
  useWatcherProviders,
  useToggleWatcher,
  useDeleteWatcher,
  useTogglePlaybook,
  useDeletePlaybook,
  useCreateWatcher,
  useCreatePlaybook,
} = await import("./use-automations-data");

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  posted.length = 0;
});

describe("automations hooks address the per-assistant route", () => {
  test.each([
    ["watchers/list", useWatchers],
    ["playbooks/list", usePlaybooks],
    ["watchers/providers", useWatcherProviders],
  ])("%s reads under /v1/assistants/{id}/", async (tail, hook) => {
    renderHook(() => hook(), { wrapper });
    await waitFor(() => expect(posted.length).toBeGreaterThan(0));
    expect(posted[0].url).toBe(`/v1/assistants/${ASSISTANT_ID}/${tail}`);
  });

  // The mutation hooks take different variable shapes, so the table is typed
  // through a common "fire it" thunk rather than a union of mutate signatures.
  const writes: [string, () => { fire: () => void }][] = [
    [
      "watchers/update",
      () => {
        const m = useToggleWatcher();
        return { fire: () => m.mutate({ id: "w1", enabled: true }) };
      },
    ],
    [
      "watchers/delete",
      () => {
        const m = useDeleteWatcher();
        return { fire: () => m.mutate("w1") };
      },
    ],
    [
      "playbooks/update",
      () => {
        const m = useTogglePlaybook();
        return { fire: () => m.mutate({ id: "p1", enabled: true }) };
      },
    ],
    [
      "playbooks/delete",
      () => {
        const m = useDeletePlaybook();
        return { fire: () => m.mutate("p1") };
      },
    ],
  ];

  test.each(writes)(
    "%s writes under /v1/assistants/{id}/",
    async (tail, hook) => {
      const { result } = renderHook(hook, { wrapper });
      result.current.fire();
      await waitFor(() => expect(posted.length).toBeGreaterThan(0));
      expect(posted[0].url).toBe(`/v1/assistants/${ASSISTANT_ID}/${tail}`);
    },
  );

  test("creates also carry the assistant, and keep their bodies", async () => {
    const w = renderHook(() => useCreateWatcher(), { wrapper });
    w.result.current.mutate({ name: "Inbox", provider: "gmail" } as never);
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0].url).toBe(
      `/v1/assistants/${ASSISTANT_ID}/watchers/create`,
    );
    // The server-side contract is unchanged by the URL fix.
    expect(posted[0].body).toMatchObject({
      name: "Inbox",
      provider: "gmail",
      intake_mode: "came_in",
    });

    posted.length = 0;
    const p = renderHook(() => useCreatePlaybook(), { wrapper });
    p.result.current.mutate({
      name: "Reply",
      trigger_text: "invoice",
      action: "draft",
      autonomy_level: "draft",
      priority: 1,
    } as never);
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0].url).toBe(
      `/v1/assistants/${ASSISTANT_ID}/playbooks/create`,
    );
  });

  test("no call site posts to a bare /v1 automations path", async () => {
    renderHook(() => useWatchers(), { wrapper });
    renderHook(() => usePlaybooks(), { wrapper });
    await waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(2));
    for (const { url } of posted) {
      expect(url.startsWith("/v1/assistants/")).toBe(true);
    }
  });
});
