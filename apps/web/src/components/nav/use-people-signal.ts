/**
 * The real numbers behind the People row's gate.
 *
 * Design would not let People into the sidebar on the strength of the code
 * existing: *"Promote it when contact memories are non-zero and growing
 * week-over-week — not when the code ships. A prominent destination with 2
 * rows teaches people the slot is worthless."* The live instance has 2
 * contacts and 0 memories, because contact extraction ran 697 times, completed
 * every time, and wrote nothing.
 *
 * So the row is built and the decision is deferred to the data. This hook
 * supplies the data; `shouldShowPeopleRow` in `nav-model.ts` is the one
 * predicate that reads it.
 *
 * ## Why the memory count is a sample
 *
 * There is no endpoint that reports a total. Relationship memories are only
 * readable per contact (`GET /contacts/:id/memory`), so a true count would be
 * one request per contact — unacceptable for chrome that renders on every
 * authenticated route.
 *
 * This probes the {@link PEOPLE_SIGNAL_SAMPLE} most recently-active contacts
 * instead. That is a deliberate bias, not a shortcut: if extraction is working
 * at all it will have written something about the people you actually talk to,
 * and if it has written nothing about *them* the row has not earned its slot
 * regardless of what sits in the tail. The sample is stated rather than hidden
 * because a count that looks total and isn't would be the same class of lie
 * this gate exists to prevent.
 */

import { useQueries, useQuery } from "@tanstack/react-query";

import {
  contactsByIdMemoryGetOptions,
  contactsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { PeopleSignal } from "@/components/nav/nav-model";

/** How many contacts get probed for relationship memory. */
export const PEOPLE_SIGNAL_SAMPLE = 3;

/**
 * Chrome, not a page. A long stale window keeps this to a handful of requests
 * per session; the answer changes on the timescale of extraction runs, not
 * navigations.
 */
const STALE_MS = 10 * 60 * 1000;

/**
 * `null` until the contact list resolves — which `shouldShowPeopleRow` reads as
 * "no evidence", so the row stays hidden through the first paint rather than
 * flashing in and out.
 */
export function usePeopleSignal(
  assistantId: string | null,
): PeopleSignal | null {
  const enabled = Boolean(assistantId);

  const contacts = useQuery({
    ...contactsGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled,
    staleTime: STALE_MS,
    refetchOnWindowFocus: false,
    retry: false,
  });

  // The same exclusion the People page applies: relationship memory is about
  // other people, so the assistant's own identity and the guardian (you) are
  // not contacts for this purpose. Counting them would let a fresh install
  // clear the gate with two rows that are both you.
  const people = (contacts.data?.contacts ?? []).filter(
    (c) => c.role !== "assistant" && c.role !== "guardian",
  );

  const sample = [...people]
    .sort(
      (a, b) =>
        (b.lastInteraction ?? 0) - (a.lastInteraction ?? 0) ||
        b.interactionCount - a.interactionCount,
    )
    .slice(0, PEOPLE_SIGNAL_SAMPLE);

  const memories = useQueries({
    queries: sample.map((contact) => ({
      ...contactsByIdMemoryGetOptions({
        path: { assistant_id: assistantId ?? "", id: contact.id },
      }),
      enabled,
      staleTime: STALE_MS,
      refetchOnWindowFocus: false,
      retry: false,
    })),
  });

  if (!enabled || !contacts.isSuccess) return null;

  return {
    contactCount: people.length,
    memoryCount: memories.reduce(
      (total, query) => total + (query.data?.memory?.length ?? 0),
      0,
    ),
  };
}
