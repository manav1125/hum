import { useQuery } from "@tanstack/react-query";

import {
  pendinginteractionsGetOptions,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";

/**
 * How many things are actually waiting on the user right now.
 *
 * Cue's whole premise is that it works while you're away — so "something needs
 * your decision" has to be visible from anywhere, not only from inside HQ. This
 * is the one source both the desktop sidebar and the mobile tab bar read, so
 * they can never disagree.
 *
 * Two real sources, matching what HQ itself shows:
 *   · pending interactions — an approval prompt parked mid-run, waiting on a
 *     decision (this is what a high-consequence action raises when it parks);
 *   · work items in `awaiting_review` — finished background runs whose result
 *     nobody has looked at yet.
 *
 * Deliberately NOT the old home-feed "unread" count: that read a retired
 * surface, and conversation-level unread logic excludes background/scheduled
 * runs by design — precisely the runs that need you.
 */
const POLL_MS = 60_000;

export function useNeedsYouBadge(assistantId: string | null): {
  /** Total items awaiting the user. 0 when nothing needs them. */
  count: number;
  /** Approvals parked mid-run — the urgent subset. */
  approvals: number;
} {
  const enabled = !!assistantId;

  const interactions = useQuery({
    ...pendinginteractionsGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled,
    refetchInterval: POLL_MS,
    staleTime: 10_000,
  });

  const review = useQuery({
    ...workitemsGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { status: "awaiting_review" },
    }),
    enabled,
    refetchInterval: POLL_MS,
    staleTime: 15_000,
  });

  const approvals = interactions.data?.interactions?.length ?? 0;
  const awaitingReview = review.data?.items?.length ?? 0;

  return { count: approvals + awaitingReview, approvals };
}
