/**
 * The `⌗` state — an arrival Cue read and could not make sense of.
 *
 * The backend half of this shipped first and is correct: an arrival Cue could
 * not comprehend never enters the task list (`listWorkItems` excludes it unless
 * a caller opts in with `includeUnComprehended`). What was missing was the
 * other side — the surface that says where those items went. Without it, mail
 * arrived, comprehension failed, and the item vanished with no count anywhere.
 * This module is that other side. It does not undo the exclusion; it renders it.
 *
 * ## `⌗` is not `?`
 *
 * Two different admissions, and conflating them is what made this gap look
 * covered:
 *
 *   · amber `?` — *"I don't know where this goes."* Cue read the message, knows
 *     what it wants, and cannot pick a home for it. That is filing confidence
 *     (`isBelowConfidence`, and the unfiled `?` on HQ's Came-in rows).
 *   · `⌗` — *"I don't know what this is."* Cue read the message and could not
 *     name an action at all. It has no opinion, so it offers none.
 *
 * ## `low_confidence` is the only unreadable verdict
 *
 * The daemon stores four comprehension verdicts and only ONE of them means the
 * model read the message and came up short:
 *
 *   · `low_confidence` — read, and no action could be named. **This is `⌗`.**
 *   · `failed`         — the model never produced a usable answer (timeout,
 *                        parse failure, unreachable). During an outage EVERY
 *                        arrival is `failed`, so this stays an ordinary task.
 *   · `skipped`        — comprehension was off, or the item changed mid-read.
 *                        Not asked is not confused.
 *   · `comprehended`   — read, and the title now says what to do.
 *
 * `work-item-store.ts` encodes the same rule server-side (`UNCOMPREHENDED_
 * STATUSES = ["low_confidence"]`), and the two must not drift: widening this
 * predicate to `failed` would empty the Came-in strip into the `⌗` bucket for
 * the whole duration of a model outage — precisely when Cue is least able to
 * explain itself. `uncomprehended.test.ts` mutation-checks that boundary.
 *
 * ## Why the count is scanned rather than read off the census
 *
 * `arrivals/comprehension/health` returns a `byStatus.low_confidence` census
 * and it was tempting to headline that number. It is the wrong number here: it
 * counts comprehension ROWS written in a window, including items long since
 * filed or archived, so the header would claim a count the rows below it could
 * not account for. HQ has already shipped that bug once (the needs-you headline
 * read 6 while the sidebar badge read 5, both reading real data that measured
 * different things). So the header count and the rows come from ONE scan: if
 * Cue cannot name the item, it does not count it.
 */

import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

import {
  arrivalsGetOptions,
  workitemsByIdComprehensionGetOptions,
  workitemsByIdGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { HqWorkItem } from "./use-missions";

/**
 * The one comprehension verdict that means "I read it and could not tell what
 * it needs". Mirrors `UNCOMPREHENDED_STATUSES` in the daemon's work-item store.
 */
export const UNREADABLE_STATUS = "low_confidence";

/**
 * True only for the verdict that earns `⌗`.
 *
 * Deliberately a whitelist of one rather than "not comprehended": `failed` and
 * `skipped` both mean the model never got to read the message, and an item the
 * model never read is an ordinary task with its subject line for a title.
 */
export function isUnComprehended(status: string | null | undefined): boolean {
  return status === UNREADABLE_STATUS;
}

/**
 * The header count, in Cue's own voice. First person because it is a claim
 * about Cue, not about the mail — "2 unreadable" blames the sender.
 *
 * Returns null at zero: a comprehension failure rate of nothing is not a fact
 * worth a slot, and a `0` beside the other counts reads like a broken feed.
 */
export function unreadableLabel(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return `${count} I couldn't read`;
}

/** What the arrivals scan knows before any verdict has been asked for. */
export interface UnreadableCandidate {
  workItemId: string;
  arrivalId: string;
  /** The subject exactly as it arrived. Never a summary — that is the point. */
  subject: string;
  /** The first of the body Cue stored, if any. Also verbatim. */
  snippet: string | null;
  senderName: string | null;
  senderAddress: string | null;
  /** e.g. `watcher:gmail`. */
  channel: string;
  receivedAt: number;
}

/** A candidate the comprehension verdict confirmed, with its excluded item. */
export interface UnreadableArrival extends UnreadableCandidate {
  /**
   * The excluded work item itself, fetched one at a time because the list reads
   * (rightly) will not return it. The row needs it to act: every verb here is a
   * PATCH, and this daemon's PATCH takes a whole item.
   */
  item: HqWorkItem;
}

/**
 * Statuses that mean the owner has already dealt with it.
 *
 * A blocklist rather than an allowlist, and that direction is deliberate: this
 * whole feature exists because an item disappeared silently, so an unfamiliar
 * status must keep the row VISIBLE. Fail-open is the only safe default for a
 * surface whose job is "nothing vanished".
 *
 * Without this the `⌗` row would be immortal. Comprehension does not re-run on
 * archive, so an archived un-comprehended arrival stays `low_confidence` and
 * would keep matching the scan forever — the verbs would appear to do nothing.
 */
const SETTLED_STATUSES: ReadonlySet<string> = new Set([
  "done",
  "archived",
  "cancelled",
]);

/**
 * Narrow `GET work-items/:id`.
 *
 * That route declares no response body, so the generated client types it
 * `unknown` — the one place in this flow where the compiler cannot help. A
 * shape that does not carry an id and a status is not a work item, and
 * returning null rather than casting keeps a malformed payload from becoming a
 * row that cannot be acted on.
 */
function workItemFrom(data: unknown): HqWorkItem | null {
  if (typeof data !== "object" || data === null) return null;
  const item = (data as { item?: unknown }).item;
  if (typeof item !== "object" || item === null) return null;
  const record = item as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.status !== "string") {
    return null;
  }
  return item as HqWorkItem;
}

/**
 * How far back the scan looks, and how many rows it will pull.
 *
 * Bounded on purpose. The Came-in strip is a picture of today, and an unbounded
 * scan here would be both a slow first paint and a lane that grows without
 * limit — the deck-never-grows invariant applies to what we FETCH as much as to
 * what we render.
 */
export const SCAN_WINDOW_HOURS = 24;
export const SCAN_LIMIT = 50;

export interface UnreadableArrivalsResult {
  /** Newest first. The header count is `items.length`, never a separate query. */
  items: UnreadableArrival[];
  count: number;
  isLoading: boolean;
  /** The scan itself failed. Distinct from "the scan found nothing". */
  isError: boolean;
}

/**
 * Find the arrivals Cue could not read.
 *
 * Three steps, and the middle one is the one that decides:
 *
 *  1. **Narrow.** List surfaced arrivals in the window. Anything whose work
 *     item is already in the caller's task list was plainly readable — the
 *     daemon would have excluded it otherwise — so it needs no further asking.
 *     `knownWorkItemIds` can be partial or absent without making this wrong: an
 *     un-comprehended item can never appear in it (the store excludes it from
 *     every list read), so this step can only ever cost an extra request, never
 *     drop a true `⌗`.
 *  2. **Confirm.** Ask each survivor for its comprehension verdict and keep
 *     only `low_confidence`. Absence from a list is circumstantial; the verdict
 *     is the evidence, and a 404 (no comprehension record at all) means the
 *     item never went through a watcher and is an ordinary task.
 *  3. **Fetch the item.** Only for the confirmed set, and for two reasons: the
 *     row's verbs need a whole item to PATCH, and its status is what retires
 *     the row once the owner has dealt with it.
 */
export function useUnreadableArrivals(
  assistantId: string,
  {
    knownWorkItemIds,
    enabled = true,
  }: { knownWorkItemIds?: ReadonlySet<string>; enabled?: boolean } = {},
): UnreadableArrivalsResult {
  const arrivals = useQuery({
    ...arrivalsGetOptions({
      path: { assistant_id: assistantId },
      query: {
        disposition: "surfaced",
        windowHours: SCAN_WINDOW_HOURS,
        limit: SCAN_LIMIT,
      },
    }),
    enabled: enabled && assistantId.length > 0,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });

  const candidates = useMemo<UnreadableCandidate[]>(() => {
    const rows = arrivals.data?.arrivals ?? [];
    const seen = new Set<string>();
    const out: UnreadableCandidate[] = [];
    for (const row of rows) {
      const workItemId = row.workItemId;
      if (!workItemId) continue;
      // In the task list ⇒ the daemon let it through ⇒ Cue read it.
      if (knownWorkItemIds?.has(workItemId)) continue;
      // Grouped arrivals share one work item; the `⌗` row is per item, not per
      // message, or a chatty robot would render the same confusion five times.
      if (seen.has(workItemId)) continue;
      seen.add(workItemId);
      out.push({
        workItemId,
        arrivalId: row.id,
        subject: row.title,
        snippet: row.snippet ?? null,
        senderName: row.senderName ?? null,
        senderAddress: row.senderAddress ?? null,
        channel: row.channel,
        receivedAt: row.createdAt,
      });
    }
    return out.sort((a, b) => b.receivedAt - a.receivedAt);
  }, [arrivals.data, knownWorkItemIds]);

  const verdicts = useQueries({
    queries: candidates.map((candidate) => ({
      ...workitemsByIdComprehensionGetOptions({
        path: { assistant_id: assistantId, id: candidate.workItemId },
      }),
      // A verdict is written once per read pass and 404s when there is none.
      // Retrying a 404 on every candidate would turn a quiet deck into a
      // request storm for no new information.
      retry: false,
      staleTime: 5 * 60_000,
    })),
  });

  // `useQueries` hands back a fresh array on every render, so it can never be a
  // dependency. These joined strings are: they change exactly when an answer
  // changes, and not once otherwise.
  const verdictKey = verdicts
    .map((v) => v.data?.comprehension?.status ?? "")
    .join("|");

  const confirmed = useMemo(
    () =>
      candidates.filter((_, i) =>
        isUnComprehended(verdicts[i]?.data?.comprehension?.status),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candidates, verdictKey],
  );

  const details = useQueries({
    queries: confirmed.map((candidate) => ({
      ...workitemsByIdGetOptions({
        path: { assistant_id: assistantId, id: candidate.workItemId },
      }),
      retry: false,
      staleTime: 30_000,
    })),
  });

  const detailKey = details
    .map((d) => workItemFrom(d.data)?.status ?? "")
    .join("|");

  const items = useMemo(() => {
    const out: UnreadableArrival[] = [];
    confirmed.forEach((candidate, i) => {
      const item = workItemFrom(details[i]?.data);
      if (!item) return;
      if (SETTLED_STATUSES.has(item.status)) return;
      out.push({ ...candidate, item });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmed, detailKey]);

  return {
    items,
    count: items.length,
    isLoading:
      arrivals.isLoading ||
      verdicts.some((v) => v.isLoading) ||
      details.some((d) => d.isLoading),
    isError: arrivals.isError,
  };
}
