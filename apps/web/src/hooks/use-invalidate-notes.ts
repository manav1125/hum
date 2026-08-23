/**
 * Refetch everything Notes shows, after any mutation.
 *
 * The counts are derived server-side — "62 notes · 78 tasks · 31 memories",
 * "Waiting on you · 3" — so refetching is how they stay honest. Patching them
 * optimistically would mean the client inventing a shape that might not match
 * what the daemon would say, and those numbers are the feature's central
 * claim.
 *
 * Top-level because both the Notes page and the corner mutate notes.
 */

import { useQueryClient } from "@tanstack/react-query";

/**
 * Invalidate every Notes query. Used after any mutation — the counts are
 * derived server-side, so refetching is how they stay honest rather than
 * being patched optimistically into a shape that might not match.
 */
export function useInvalidateNotes() {
  const queryClient = useQueryClient();
  return () =>
    void queryClient.invalidateQueries({
      predicate: (query) => JSON.stringify(query.queryKey).includes("/notes"),
    });
}

/**
 * Write a note.
 *
 * **Local first, and it never awaits the network.** The note is durable on
 * this device with an id it keeps forever before this function resolves, and
 * only then is a push queued. That ordering is the whole capture contract:
 * "your note is saved" is printed because it is true, not because a request
 * was optimistic.
 *
 * The push is idempotent on the minted id, so the queue may retry it freely.
 */
