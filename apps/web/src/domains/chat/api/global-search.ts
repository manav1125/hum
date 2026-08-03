/**
 * Global search — the one fetch, and an outcome that cannot lie about it.
 *
 * This module used to return `EMPTY_RESULTS` whenever the request failed, so a
 * 500, a dropped connection and an expired session all arrived at the UI as the
 * same four empty arrays: "nothing found". That is a failure reported as an
 * absence — telling someone their data does not exist when the truth is that we
 * could not look. It is the defect class that has cost this product a contact
 * pipeline that wrote nothing, an auto-filer that filed nothing, and a feedback
 * form that posted to a 404 while saying "sent".
 *
 * So `searchGlobal` returns a DISCRIMINATED OUTCOME. There is no shape a caller
 * can destructure that quietly turns a failure into zero rows — to read results
 * at all you must first narrow on `status`, and the compiler makes you.
 *
 * Four statuses, because there are four genuinely different things that happen:
 *
 *   · `ok`          — the index answered. `results` may be empty, and empty here
 *                     honestly means nothing matched.
 *   · `error`       — the fetch failed. NOTHING was searched. Cue says so in its
 *                     own words, first person, and the surface paints it red.
 *   · `unavailable` — no assistant is resolved yet, so searching is not possible.
 *                     Not a fault to alarm anyone about; a muted explanation.
 *   · `cancelled`   — a superseded keystroke. Also not a search — which is why it
 *                     is not folded into `ok` with an empty array. That fold is
 *                     the same lie in miniature, and only stays invisible for as
 *                     long as every caller remembers to discard it.
 *
 * Both search surfaces come through here: the desktop ⌘K palette
 * (`components/command-palette/`) and the phone's pull-down search
 * (`mobile-v3/states/search-source.ts`). One fetch, one error vocabulary.
 */
import { searchGlobalGet } from "@/generated/daemon/sdk.gen";
import type { SearchGlobalGetResponse } from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Search results grouped by category, as returned by the daemon's
 * `GET /v1/search/global` endpoint. Re-exported from the generated SDK types
 * so consumers import from the domain module, not `@/generated/` directly.
 */
export type GlobalSearchResponse = SearchGlobalGetResponse["results"];

/** Every category the daemon can actually search. There is no fifth. */
export const SEARCH_CATEGORIES = [
  "conversations",
  "memories",
  "schedules",
  "contacts",
] as const;

export type SearchCategory = (typeof SEARCH_CATEGORIES)[number];

/**
 * What a search actually produced. Narrow on `status` before touching results —
 * that requirement is the point of the type.
 */
export type GlobalSearchOutcome =
  | { status: "ok"; query: string; results: GlobalSearchResponse }
  | {
      status: "error";
      query: string;
      /** Cue's own words, verbatim, ready to render. */
      message: string;
      /** Present when the server answered with a status code. */
      httpStatus?: number;
    }
  | { status: "unavailable"; query: string; message: string }
  | { status: "cancelled"; query: string };

// ---------------------------------------------------------------------------
// Cue's words
// ---------------------------------------------------------------------------

/**
 * Cue reports its own errors first, verbatim, first person. The status code is
 * included when we have one so a support conversation starts with a fact.
 */
export function searchFailureMessage(httpStatus?: number): string {
  return `I couldn't reach my search index${
    httpStatus ? ` (${httpStatus})` : ""
  }. Nothing was searched.`;
}

export const SEARCH_UNAVAILABLE_MESSAGE =
  "I'm not connected to your Cue yet, so I can't search.";

/** "conversations, schedules and people" — for the honest empty-state line. */
export function describeCategories(
  categories: readonly SearchCategory[],
): string {
  const labels = categories.map((c) => CATEGORY_LABEL[c]);
  if (labels.length === 0) return "nothing";
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

const CATEGORY_LABEL: Record<SearchCategory, string> = {
  conversations: "conversations",
  memories: "memories",
  schedules: "schedules",
  contacts: "people",
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface SearchGlobalOptions {
  limit?: number;
  signal?: AbortSignal;
  /** Defaults to every searchable category. */
  categories?: readonly SearchCategory[];
}

/**
 * Perform a global search across the daemon's indexed data for the given
 * assistant.
 *
 * Never fabricates an empty result: a failure comes back as `status: "error"`
 * and a cancellation as `status: "cancelled"`.
 */
export async function searchGlobal(
  assistantId: string | null | undefined,
  query: string,
  options?: SearchGlobalOptions,
): Promise<GlobalSearchOutcome> {
  const trimmed = query.trim();

  if (!assistantId) {
    return {
      status: "unavailable",
      query: trimmed,
      message: SEARCH_UNAVAILABLE_MESSAGE,
    };
  }

  const categories = options?.categories ?? SEARCH_CATEGORIES;

  try {
    const { data, response } = await searchGlobalGet({
      path: { assistant_id: assistantId },
      query: {
        q: trimmed,
        limit: options?.limit ?? 20,
        categories: categories.join(","),
      },
      throwOnError: false,
      signal: options?.signal,
    });

    // A superseded debounce is not a failure and must not paint one. Checked on
    // the SIGNAL rather than on the error's shape: the generated client swallows
    // the abort into its `{ error }` channel, so `instanceof DOMException` alone
    // would let a cancelled keystroke render as an outage.
    if (aborted(options?.signal)) {
      return { status: "cancelled", query: trimmed };
    }

    if (!response?.ok || !data) {
      const httpStatus = response?.status;
      console.error("[global-search] search failed", {
        assistantId,
        query: trimmed,
        httpStatus,
      });
      return {
        status: "error",
        query: trimmed,
        message: searchFailureMessage(httpStatus),
        ...(httpStatus === undefined ? {} : { httpStatus }),
      };
    }

    return { status: "ok", query: trimmed, results: data.results };
  } catch (err) {
    if (aborted(options?.signal) || isAbortError(err)) {
      return { status: "cancelled", query: trimmed };
    }
    console.error("[global-search] search failed", {
      assistantId,
      query: trimmed,
      err,
    });
    return {
      status: "error",
      query: trimmed,
      message: searchFailureMessage(),
    };
  }
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isAbortError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: unknown }).name === "AbortError"
  );
}
