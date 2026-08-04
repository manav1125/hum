/**
 * Drive the uploads half of Library search.
 *
 * Deliberately separate from the main results, which are a synchronous filter
 * over an already-fetched array. That separation is what makes failing open
 * structural rather than a promise: this hook owns its own state, and there is
 * no code path by which its failure can empty the list beside it.
 *
 * Debounced, and every superseded request is aborted — `runUploadSearch`
 * returns `null` for a cancellation, and a `null` is dropped rather than
 * painted, so a fast typist never sees a stale answer or an empty one.
 */
import { useEffect, useState } from "react";

import {
  runUploadSearch,
  UPLOAD_SEARCH_DEBOUNCE_MS,
  type UploadSearchState,
} from "./library-search";

export function useUploadSearch(
  assistantId: string | null | undefined,
  query: string,
  /** False while the surface is closed, so a hidden sheet issues no requests. */
  enabled = true,
): UploadSearchState {
  const [state, setState] = useState<UploadSearchState>({ status: "idle" });
  const trimmed = query.trim();

  useEffect(() => {
    if (!enabled || !trimmed) {
      setState({ status: "idle" });
      return;
    }

    let live = true;
    const controller = new AbortController();
    // Shown immediately so the section does not pop in only once the answer
    // lands — and so "still looking" is distinguishable from "nothing".
    setState({ status: "searching", query: trimmed });

    const timer = setTimeout(() => {
      void runUploadSearch(assistantId, trimmed, controller.signal).then(
        (next) => {
          // `null` is a superseded keystroke. Keep what we had.
          if (live && next) setState(next);
        },
      );
    }, UPLOAD_SEARCH_DEBOUNCE_MS);

    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [assistantId, trimmed, enabled]);

  return state;
}
