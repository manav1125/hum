/**
 * Tests for `useQuickAddTask` — the project-board quick-add path.
 *
 * The contract under test (regression for the "Add task creates nothing"
 * bug): one `POST work-items` call carrying BOTH the title and the projectId
 * (no create→find→patch dance), and a failed create must surface through
 * `isError` rather than being silently swallowed.
 *
 * The daemon HTTP layer is mocked at the generated client (`client.post`),
 * mirroring `src/assistant/operational-status.test.tsx`.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

const postMock = mock(async (_opts: unknown) => ({
  data: { item: { id: "wi-1", status: "queued" } },
  error: undefined,
  response: new Response(null, { status: 200 }),
}));

mock.module("@/generated/daemon/client.gen", () => ({
  client: { post: postMock },
}));

import { useQuickAddTask } from "@/pages/projects/use-quick-add";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  postMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("useQuickAddTask", () => {
  test("creates the task with title + projectId in a single POST", async () => {
    const { result } = renderHook(() => useQuickAddTask("asst-1", "proj-1"), {
      wrapper,
    });

    let succeeded = false;
    result.current.add("Draft the launch email", {
      onSuccess: () => {
        succeeded = true;
      },
    });

    await waitFor(() => expect(succeeded).toBe(true));

    expect(postMock).toHaveBeenCalledTimes(1);
    const opts = postMock.mock.calls[0][0] as {
      url: string;
      path: Record<string, string>;
      body: Record<string, unknown>;
    };
    expect(opts.url).toBe("/v1/assistants/{assistant_id}/work-items");
    expect(opts.path).toEqual({ assistant_id: "asst-1" });
    expect(opts.body).toEqual({
      title: "Draft the launch email",
      projectId: "proj-1",
    });
    expect(result.current.isError).toBe(false);
  });

  test("surfaces a failed create through isError instead of swallowing it", async () => {
    postMock.mockImplementationOnce(async () => {
      throw new Error("403 Forbidden");
    });

    const { result } = renderHook(() => useQuickAddTask("asst-1", "proj-1"), {
      wrapper,
    });

    let succeeded = false;
    result.current.add("Doomed task", {
      onSuccess: () => {
        succeeded = true;
      },
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(succeeded).toBe(false);

    // Dismissing the input clears the shown error.
    result.current.reset();
    await waitFor(() => expect(result.current.isError).toBe(false));
  });
});
