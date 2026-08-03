/**
 * The Library's one fetch — `GET /v1/assistants/:id/outputs`, newest first.
 *
 * Both doors share this hook (and therefore one query key and one cache), so
 * the sheet that rises over a thing and the Work → Library view can never
 * disagree about what Cue has made.
 *
 * A failed fetch is an ERROR, not an empty gallery: `isError` is returned
 * separately so the surfaces can say "I couldn't load this" instead of
 * quietly claiming you have made nothing.
 */
import { useQuery } from "@tanstack/react-query";

import { outputsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

import type { LibraryEntry } from "./library-model";

/** The daemon caps at 200; the phone gallery asks for the cap. */
const LIMIT = 200;

export function useLibraryOutputs(assistantId: string | null | undefined): {
  entries: LibraryEntry[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const query = useQuery({
    ...outputsGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { limit: LIMIT },
    }),
    enabled: Boolean(assistantId),
    staleTime: 30_000,
  });
  return {
    entries: query.data?.outputs ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}
