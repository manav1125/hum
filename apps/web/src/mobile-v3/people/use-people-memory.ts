/**
 * One request for a page of People cards.
 *
 * The People list used to fetch `contacts/:id/memory` once per rendered card,
 * which made the page size the N in an N+1: 15 cards meant 15 requests, and
 * "show more" meant 15 more. `POST people/memory/bulk` reads a whole page in
 * one call, so the page size is a design decision again instead of a
 * concurrency budget.
 *
 * The daemon caps a single call at `maxContacts` ids and **rejects** anything
 * larger rather than truncating — a short answer would arrive as contacts with
 * no rows, which is exactly what "nothing learned yet" looks like. So this
 * hook never builds a request over the cap: a page larger than the cap is
 * split into whole-cap chunks, which is one call per hundred people rather
 * than one per person. Truncating the id list here would have the same effect
 * the daemon refuses to have — cards reporting an absence nobody checked.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { peopleMemoryBulkPost } from "@/generated/daemon/sdk.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import { shouldRetryDaemonError } from "@/utils/daemon-errors";

import type { ContactMemoryReadEntry } from "./people-data";

/**
 * Ids per request. Mirrors the daemon's `CONTACT_MEMORY_BULK_MAX_CONTACTS`;
 * the daemon is the one that enforces it, this is the client refusing to build
 * a request it knows will be rejected.
 */
export const MEMORY_BULK_MAX_CONTACTS = 100;

export interface PeopleMemoryBulk {
  /** Per-contact verdicts, keyed by contact id. */
  byContact: Map<string, ContactMemoryReadEntry>;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

/**
 * Read memory for the given contacts in one call.
 *
 * `contactIds` is the page currently rendered. The query key is derived from
 * it, so growing the page issues exactly one more request — not one per new
 * card.
 */
export function usePeopleMemory(
  assistantId: string | undefined,
  contactIds: string[],
): PeopleMemoryBulk {
  // Order-independent key: the same page reordered is the same read.
  const key = useMemo(() => [...contactIds].sort().join(","), [contactIds]);
  const chunks = useMemo(() => {
    const out: string[][] = [];
    for (let i = 0; i < contactIds.length; i += MEMORY_BULK_MAX_CONTACTS) {
      out.push(contactIds.slice(i, i + MEMORY_BULK_MAX_CONTACTS));
    }
    return out;
  }, [contactIds]);

  const query = useQuery({
    queryKey: ["mv3-people-memory", assistantId ?? "", key],
    queryFn: async () => {
      const pages = await Promise.all(
        chunks.map(async (contactIds) => {
          const { data, error, response } = await peopleMemoryBulkPost({
            path: { assistant_id: assistantId! },
            body: { contactIds },
            throwOnError: false,
          });
          assertHasResponse(response, error, "Failed to read contact memory");
          if (!response.ok) {
            throw new ApiError(
              response.status,
              extractErrorMessage(
                error,
                response,
                `Failed to read contact memory (HTTP ${response.status})`,
              ),
            );
          }
          return data!.contacts;
        }),
      );
      return pages.flat();
    },
    enabled: Boolean(assistantId) && chunks.length > 0,
    retry: shouldRetryDaemonError,
    staleTime: 60_000,
  });

  const byContact = useMemo(() => {
    const map = new Map<string, ContactMemoryReadEntry>();
    for (const entry of query.data ?? []) map.set(entry.contactId, entry);
    return map;
  }, [query.data]);

  return {
    byContact,
    // With no ids there is nothing in flight and nothing to wait for; an
    // idle query must not leave every card stuck on "reading…".
    isLoading: chunks.length > 0 && query.isLoading,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}
