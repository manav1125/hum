/**
 * Marketplace data hooks — thin wrappers over the generated daemon SDK.
 *
 * Explore streams per source: one query per enabled source (via
 * `useQueries`), so results from fast sources render while big repos are
 * still indexing — the daemon caches each source index for 24h.
 */

import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  marketplaceInstalledGetOptions,
  marketplaceInstalledGetQueryKey,
  marketplaceInstallPostMutation,
  marketplaceItemsGetOptions,
  marketplaceItemsGetQueryKey,
  marketplaceSourcesDeleteMutation,
  marketplaceSourcesGetOptions,
  marketplaceSourcesGetQueryKey,
  marketplaceSourcesPostMutation,
  marketplaceUpdatePostMutation,
  marketplaceUpdatesGetOptions,
  marketplaceUpdatesGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  MarketplaceInstallPostResponses,
  MarketplaceItemsGetResponses,
  MarketplaceSourcesGetResponses,
  MarketplaceInstalledGetResponses,
  MarketplaceUpdatesGetResponses,
} from "@/generated/daemon/types.gen";

export type MarketplaceItem =
  MarketplaceItemsGetResponses[200]["items"][number];
export type MarketplaceSource =
  MarketplaceSourcesGetResponses[200]["sources"][number];
export type InstalledSkill =
  MarketplaceInstalledGetResponses[200]["installed"][number];
export type UpdateCheck =
  MarketplaceUpdatesGetResponses[200]["updates"][number];
export type InstallResponse = MarketplaceInstallPostResponses[200];

export function useMarketplaceSources(assistantId: string) {
  const query = useQuery({
    ...marketplaceSourcesGetOptions({
      path: { assistant_id: assistantId },
    }),
    staleTime: 30_000,
  });
  return {
    sources: query.data?.sources ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/** One query per enabled source — the Explore grid streams per source. */
export function useSourceItems(
  assistantId: string,
  sources: MarketplaceSource[],
) {
  const enabled = sources.filter((s) => s.enabled);
  const queries = useQueries({
    queries: enabled.map((source) => ({
      ...marketplaceItemsGetOptions({
        path: { assistant_id: assistantId },
        query: { source: source.address },
      }),
      staleTime: 5 * 60_000,
      retry: 1,
    })),
  });
  return enabled.map((source, i) => ({
    source,
    items: (queries[i].data?.items ?? []) as MarketplaceItem[],
    isLoading: queries[i].isLoading,
    isError: queries[i].isError,
  }));
}

export function useInstalled(assistantId: string) {
  const query = useQuery({
    ...marketplaceInstalledGetOptions({
      path: { assistant_id: assistantId },
    }),
    staleTime: 15_000,
  });
  return {
    installed: query.data?.installed ?? [],
    isLoading: query.isLoading,
  };
}

/** Update availability — fetched on demand (it re-resolves every source). */
export function useUpdates(assistantId: string, enabled: boolean) {
  const query = useQuery({
    ...marketplaceUpdatesGetOptions({
      path: { assistant_id: assistantId },
    }),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return {
    updates: query.data?.updates ?? [],
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}

function useInvalidateMarketplace(assistantId: string) {
  const queryClient = useQueryClient();
  const path = { assistant_id: assistantId };
  return () => {
    void queryClient.invalidateQueries({
      queryKey: marketplaceSourcesGetQueryKey({ path }),
    });
    void queryClient.invalidateQueries({
      queryKey: marketplaceInstalledGetQueryKey({ path }),
    });
    void queryClient.invalidateQueries({
      queryKey: marketplaceUpdatesGetQueryKey({ path }),
    });
    // Per-source item queries carry query params — match on the base key.
    void queryClient.invalidateQueries({
      predicate: (q) =>
        Array.isArray(q.queryKey) &&
        (q.queryKey[0] as { _id?: string })?._id === "marketplaceItemsGet",
    });
  };
}

export function useAddSource(assistantId: string) {
  const invalidate = useInvalidateMarketplace(assistantId);
  return useMutation({
    ...marketplaceSourcesPostMutation(),
    onSuccess: invalidate,
  });
}

export function useRemoveSource(assistantId: string) {
  const invalidate = useInvalidateMarketplace(assistantId);
  return useMutation({
    ...marketplaceSourcesDeleteMutation(),
    onSuccess: invalidate,
  });
}

export function useInstallSkill(assistantId: string) {
  const invalidate = useInvalidateMarketplace(assistantId);
  return useMutation({
    ...marketplaceInstallPostMutation(),
    onSuccess: (data) => {
      // Only refetch after a real install — the confirmation-payload phase
      // changes nothing on disk.
      if ((data as InstallResponse | undefined)?.ok) invalidate();
    },
  });
}

export function useApplyUpdate(assistantId: string) {
  const invalidate = useInvalidateMarketplace(assistantId);
  return useMutation({
    ...marketplaceUpdatePostMutation(),
    onSuccess: invalidate,
  });
}

/** Reusable "marketplaceItemsGet" key check helper for tests. */
export const __internal = { marketplaceItemsGetQueryKey };
