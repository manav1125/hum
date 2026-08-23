import { useEffect } from "react";

import { useQuery } from "@tanstack/react-query";

import {
  pendinginteractionsGetOptions,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { setNeedsYou } from "@/runtime/needs-you";

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
  const count = approvals + awaitingReview;

  /**
   * Publish to the macOS menu bar from HERE, and only from here.
   *
   * The floating corner never appears unbidden — a panel that seizes focus
   * over your work to ask for money is the behaviour that gets an app quit —
   * so approvals reach the owner as a count they pull down instead. That
   * count has to be THIS one. Computing it a second time in main, or from a
   * different query, would give the menu bar a number that disagrees with the
   * sidebar, and two disagreeing counts mean neither is believed.
   *
   * No-op off Electron, so this is safe to run unconditionally.
   */
  useEffect(() => {
    const items = [
      // A parked approval names the tool it is waiting on where it has one:
      // "Approve web_fetch" is something someone can decide from a menu,
      // "Approve request" is not.
      ...(interactions.data?.interactions ?? []).map((item) => ({
        id: item.requestId,
        title: item.toolName
          ? `Approve ${item.toolName}`
          : "Waiting for your decision",
        detail: item.riskLevel ? `${item.riskLevel} risk` : "parked mid-run",
      })),
      ...(review.data?.items ?? []).map((item) => ({
        id: item.id,
        title: item.title,
        detail: "waiting for review",
      })),
    ];
    setNeedsYou({ count, items });
  }, [count, interactions.data, review.data]);

  return { count, approvals };
}
