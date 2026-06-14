import { useQuery } from "@tanstack/react-query";

import { memoryitemsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

import type { MemoryItem, MemoryItemsListResponse } from "../types";

/**
 * React Query hook for the assistant's memory items.
 *
 * Keyed by `assistantId` and gated on it (the query stays disabled until an
 * assistant is selected). The generated `memoryitemsGet` endpoint types its
 * `items` as `unknown[]`, so we narrow to `MemoryItem[]` in `select` — the
 * daemon serialises the 8-type memory model into the `MemoryItem` shape
 * declared in `../types`.
 */
export function useMemoryItemsQuery(assistantId: string | null) {
  return useQuery({
    ...memoryitemsGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    select: (data): MemoryItemsListResponse => ({
      items: (data.items ?? []) as MemoryItem[],
      total: data.total,
    }),
    enabled: Boolean(assistantId),
    staleTime: 30_000,
  });
}
