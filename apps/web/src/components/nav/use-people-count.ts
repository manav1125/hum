/**
 * How many people Cue knows — the number beside the rail's `👤 People` row.
 *
 * ## What this used to be
 *
 * This file was `use-people-signal.ts`, and it fetched two things: the contact
 * count AND a sample of relationship memories, because the memory count fed
 * `shouldShowPeopleRow` — the gate that decided whether People appeared in the
 * sidebar at all. The owner removed that gate (see `nav-model.ts`), so the
 * memory sample has no reader left and is gone with it. What remains is the one
 * number the row actually renders.
 *
 * Dropping the sample also drops up to three `GET /contacts/:id/memory`
 * requests from every authenticated route, which is chrome cost this rail was
 * paying purely to answer a question nobody asks any more.
 *
 * ## The number is real or it is absent
 *
 * `null` until the read resolves, and `null` if it fails. The row renders no
 * badge in that case rather than a `0` — "nobody yet" and "I could not ask"
 * are different answers and only one of them is safe to show. Same invariant
 * `use-nav-counts.ts` holds for Work.
 */

import { useQuery } from "@tanstack/react-query";

import { contactsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

/**
 * Chrome, not a page. The answer changes on the timescale of someone new
 * turning up in your channels, not of a navigation.
 */
const STALE_MS = 10 * 60 * 1000;

/**
 * People Cue knows, excluding Cue itself and you.
 *
 * The same exclusion the People page applies: relationship memory is about
 * *other* people, so the assistant's own identity row and the guardian (you)
 * are not contacts for this purpose. Counting them would have a fresh install
 * claim two people, both of whom are the owner.
 *
 * @returns the count, or `null` while unread / unreadable.
 */
export function usePeopleCount(assistantId: string | null): number | null {
  const enabled = Boolean(assistantId);

  const contacts = useQuery({
    ...contactsGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled,
    staleTime: STALE_MS,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (!enabled || !contacts.isSuccess) return null;

  return (contacts.data?.contacts ?? []).filter(
    (c) => c.role !== "assistant" && c.role !== "guardian",
  ).length;
}
