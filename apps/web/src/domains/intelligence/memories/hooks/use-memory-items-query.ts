import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { memoryitemsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

import type { MemoryItem, MemoryItemsListResponse } from "../types";

/** Page size for the memory list — one fetch, no pagination UI (yet). */
const PAGE_LIMIT = 200;

/**
 * React Query hook for the assistant's memory items.
 *
 * Keyed by `assistantId` (+ the optional server-side `kind` filter) and gated
 * on the assistant id (the query stays disabled until an assistant is
 * selected). The generated `memoryitemsGet` endpoint types its `items` as
 * `unknown[]`, so we narrow to `MemoryItem[]` in `select` — the daemon
 * serialises the 8-type memory model into the `MemoryItem` shape declared in
 * `../types`.
 *
 * Server-driven, deliberately:
 * - `kind` is passed to the SERVER so a kind filter sees ALL memories of that
 *   kind, not just whichever happened to be on the loaded page.
 * - `kindCounts` and `total` come from the SERVER response (computed over all
 *   rows). Deriving them from the loaded page undercounts every kind that
 *   didn't make the first page — with 154 constantly-touched procedural
 *   skill-notices, that meant every other kind read 0. The page-derived
 *   fallback below only fires against older daemons that omit `kindCounts`.
 * - Default sort is `firstSeenAt desc` (creation recency). The daemon default
 *   (`lastSeenAt desc`) surfaces procedural skill-catalog notices first
 *   because their `lastAccessed` is bumped on every skill sync, burying what
 *   Cue actually remembers about the user.
 */
export function useMemoryItemsQuery(
  assistantId: string | null,
  kind?: string | null,
) {
  return useQuery({
    ...memoryitemsGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: {
        ...(kind ? { kind } : {}),
        sort: "firstSeenAt",
        order: "desc",
        limit: PAGE_LIMIT,
      },
    }),
    select: (data): MemoryItemsListResponse => {
      const items = (data.items ?? []) as MemoryItem[];
      let kindCounts: Record<string, number> | undefined = data.kindCounts;
      if (!kindCounts || Object.keys(kindCounts).length === 0) {
        // Older daemons only: approximate from the loaded page.
        kindCounts = {};
        for (const item of items) {
          kindCounts[item.kind] = (kindCounts[item.kind] ?? 0) + 1;
        }
      }
      return { items, total: data.total, kindCounts };
    },
    enabled: Boolean(assistantId),
    staleTime: 30_000,
    // Switching kind chips swaps the query key — keep the previous page (and
    // the stable global kindCounts) on screen instead of flashing to zeros.
    placeholderData: keepPreviousData,
  });
}
