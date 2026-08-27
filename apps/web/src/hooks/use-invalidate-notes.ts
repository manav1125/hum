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
    void queryClient.invalidateQueries({ predicate: isNotesQuery });
}

/**
 * Whether a cached query is one of the Notes reads.
 *
 * **This matched nothing at all until 2026-08-27.** The predicate tested
 * `JSON.stringify(queryKey).includes("/notes")`, but a generated key is
 * `[{ _id: "notesGet", baseUrl, path: {...} }]` — the operation id has no
 * slash in it, and neither does anything else in the key. So every notes
 * mutation invalidated nothing: an imported note never appeared, a renamed
 * note kept its old title in the list, and the counts the header makes its
 * whole argument from went stale the moment anything changed.
 *
 * Matching the operation id is what the key actually offers. Anchored at the
 * start so `notesGet`, `notesByIdGet` and `notesExtractionsWaitingGet` are all
 * caught, without also catching some future `deniedNotesGet`.
 */
export function isNotesQuery(query: { queryKey: readonly unknown[] }): boolean {
  const head = query.queryKey[0];
  if (!head || typeof head !== "object") return false;
  const id = (head as { _id?: unknown })._id;
  return typeof id === "string" && id.startsWith("notes");
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
