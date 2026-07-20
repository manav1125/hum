import { useCallback, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  homeFeedByIdActionsByActionIdPost,
  homeFeedByIdPatch,
  homeFeedGet,
} from "@/generated/daemon/sdk.gen";
import {
  homeFeedGetQueryKey,
  homeFeedGetSetQueryData,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  HomeFeedGetResponse,
  HomeFeedByIdPatchData,
} from "@/generated/daemon/types.gen";
import { useBusSubscription } from "@/hooks/use-bus-subscription";

/**
 * React Query hook for the home feed.
 *
 * Tracks time-away via the layout-scoped event bus (`"app.hidden"` +
 * `"app.resume"`) so the daemon can personalise the greeting and decide
 * which items to surface. The `"online"` resume signal is ignored for
 * elapsed-time tracking — only visibility / app-state transitions
 * record a `hiddenAt` mark, so a network blip while the tab is in the
 * foreground does not synthesise fake time-away.
 */
export function useHomeFeedQuery(assistantId: string | null) {
  const queryClient = useQueryClient();

  const hiddenAtRef = useRef<number | null>(null);
  const timeAwaySecondsRef = useRef(0);

  // Stable query key — timeAwaySeconds is a fetch-time side-channel
  // (passed via ref), not a cache dimension, so the key uses a fixed
  // placeholder to keep a single cache entry per assistant.
  const feedOpts = useMemo(
    () => ({
      path: { assistant_id: assistantId ?? "" },
      query: { timeAwaySeconds: 0 },
    }),
    [assistantId],
  );
  const feedQueryKey = useMemo(() => homeFeedGetQueryKey(feedOpts), [feedOpts]);

  useBusSubscription("app.hidden", () => {
    hiddenAtRef.current = Date.now();
  });

  useBusSubscription("app.resume", ({ signal }) => {
    if (signal === "online") return;
    if (hiddenAtRef.current === null) return;
    const elapsed = Math.round((Date.now() - hiddenAtRef.current) / 1000);
    timeAwaySecondsRef.current = elapsed;
    hiddenAtRef.current = null;

    if (assistantId) {
      void queryClient.invalidateQueries({ queryKey: feedQueryKey });
    }
  });

  const query = useQuery({
    queryKey: feedQueryKey,
    queryFn: async ({ signal }) => {
      const { data } = await homeFeedGet({
        path: { assistant_id: assistantId! },
        query: { timeAwaySeconds: timeAwaySecondsRef.current },
        signal,
        throwOnError: true,
      });
      return data;
    },
    enabled: Boolean(assistantId),
    // SSE keeps this fresh (`home_feed_updated` → invalidate in
    // use-stream-event-handler) and the `app.resume` subscription above
    // already invalidates on foregrounding with real time-away — a focus
    // refetch on top just re-downloads the ~39 KB feed on every
    // navigation/focus for nothing.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const updateStatus = useMutation({
    mutationFn: async ({
      itemId,
      status,
    }: {
      itemId: string;
      status: HomeFeedByIdPatchData["body"]["status"];
    }) => {
      const { data } = await homeFeedByIdPatch({
        path: { assistant_id: assistantId!, id: itemId },
        body: { status },
        throwOnError: true,
      });
      return data;
    },

    onMutate: async ({ itemId, status }) => {
      await queryClient.cancelQueries({ queryKey: feedQueryKey });

      const previous =
        queryClient.getQueryData<HomeFeedGetResponse>(feedQueryKey);

      homeFeedGetSetQueryData(queryClient, feedOpts, (old) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.map((item) =>
            item.id === itemId ? { ...item, status } : item,
          ),
        };
      });

      return { previous };
    },

    onError: (_err, _vars, context) => {
      if (context?.previous) {
        homeFeedGetSetQueryData(queryClient, feedOpts, context.previous);
      }
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: feedQueryKey });
    },
  });

  const triggerAction = useMutation({
    mutationFn: async ({
      itemId,
      actionId,
      mode,
    }: {
      itemId: string;
      actionId: string;
      /** How to execute. Omit/"smart" = route off the autonomy policy. */
      mode?: "smart" | "background" | "thread";
    }) => {
      const { data } = await homeFeedByIdActionsByActionIdPost({
        path: {
          assistant_id: assistantId!,
          id: itemId,
          actionId,
        },
        body: mode ? { mode } : {},
        throwOnError: true,
      });
      return data;
    },

    // No optimistic status flip: the resolved mode isn't known until the
    // response (background/needs_you keep the item around; only thread/
    // completed retire it). The server retires the card on a completed
    // background run; we just refetch on settle.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: feedQueryKey });
    },
  });

  const invalidate = useCallback(() => {
    if (!assistantId) return;
    void queryClient.invalidateQueries({ queryKey: feedQueryKey });
  }, [assistantId, queryClient, feedQueryKey]);

  return {
    ...query,
    updateStatus,
    triggerAction,
    invalidate,
  };
}
