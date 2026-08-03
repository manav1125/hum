/**
 * The Library's one fetch — `GET /v1/assistants/:id/library`, newest first.
 *
 * It used to be `GET /outputs`, and that was the bug the owner reported as
 * "library doesn't show all the real library files". `/outputs` is the
 * work-run deliverable registry: a row exists only when a work item RAN TO
 * COMPLETION and its run produced an attachment. On the owner's production
 * daemon that was 2 rows against 452 work items, so this hook returned two
 * cards — one of them a stray `browser-screenshot.jpeg` — while 66 apps, 13
 * documents and 35 generated files were never asked for. No clause filtered
 * them out; the query never reached them.
 *
 * `/library` is the composed scope (see the daemon's `library-store.ts`):
 * everything you made WITH Cue — its files, its documents, its apps, and the
 * deliverables runs registered — and not the files you uploaded to it.
 *
 * Both doors share this hook (and therefore one query key and one cache), so
 * the sheet that rises over a thing and the Work → Library view can never
 * disagree about what you have.
 *
 * A failed fetch is an ERROR, not an empty gallery: `isError` is returned
 * separately so the surfaces can say "I couldn't load this" instead of
 * quietly claiming you have made nothing.
 */
import { useQuery } from "@tanstack/react-query";

import { libraryGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

import type { LibraryEntry } from "./library-model";

/**
 * How many the phone asks for. Mirrored by `overflow-menu.tsx`'s
 * `LIBRARY_FETCH_LIMIT`, whose test reads this file and fails if the two
 * disagree — the Library row prints no number rather than a wrong one when
 * the count lands exactly on the cap.
 */
const LIMIT = 200;

export function useLibraryOutputs(assistantId: string | null | undefined): {
  entries: LibraryEntry[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const query = useQuery({
    ...libraryGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { limit: LIMIT },
    }),
    enabled: Boolean(assistantId),
    staleTime: 30_000,
  });
  return {
    entries: query.data?.items ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}
