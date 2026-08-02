/**
 * Position 4 — the one sentence pill, and the door to HQ.
 *
 * §4 keeps the delivery sentence on the canvas but demotes it from a card to a
 * pill. HQ's own note beside `DeliverySentence` predicted this: *"when the
 * landing surface ships, this line lifts out of HQ and becomes the door."*
 * That is what this is. It is not a second rendering of HQ's line — it is the
 * same line, moved, which is why §4's admission test still answers `false` for
 * it.
 *
 * The sentence **is** the door. No companion "show me" button: two affordances
 * for one intent is the clutter §4 is removing.
 *
 * ## Never a fake number
 *
 * Both counts are `number | null`. `null` means *we could not ask* — a failed
 * or still-loading query contributes nothing to the sentence rather than a
 * zero, because a zero here is a claim ("nothing needs you") and it is the
 * single most expensive lie this surface could tell.
 *
 * This is a stricter contract than the rail badge's, which collapses an error
 * to `0`. Both read the same two queries and react-query dedupes them, so in
 * the healthy case the pill and the badge cannot disagree; in the *unhealthy*
 * case the pill says it could not read while the badge shows nothing. The rail
 * is owned elsewhere and was not changed here.
 */

import { useQuery } from "@tanstack/react-query";

import {
  pendinginteractionsGetOptions,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";

const POLL_MS = 60_000;

/** Local midnight, in epoch ms. */
export function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface CanvasDoor {
  /** Work Cue finished today, or `null` when the store could not be read. */
  delivered: number | null;
  /** Things waiting on the user, or `null` when the stores could not be read. */
  needsYou: number | null;
  /** The rendered sentence. */
  sentence: string;
  /**
   * `true` while nothing has answered yet. The pill holds rather than
   * asserting "I couldn't read your work" at the speed of a page load.
   */
  isPending: boolean;
}

/**
 * "While you slept: 3 done, 2 need you."
 *
 * Lifted verbatim in behaviour from HQ's `deliverySentence` so the two cannot
 * drift into different voices — including the rule that a zero delivered count
 * leads with Cue owning the empty result rather than with the reader's debt.
 * Opening the product on an accusation is the inbox feeling the whole surface
 * exists to remove.
 */
export function doorSentence(
  delivered: number | null,
  needsYou: number | null,
  /** Hoisted by the caller — reading the clock during render is impure. */
  hour: number,
): string {
  const lead = hour < 12 ? "While you slept" : "Today so far";

  if (delivered == null && needsYou == null)
    return "I couldn't read your work just now.";

  if (delivered == null) {
    return needsYou === 0
      ? "Nothing needs you."
      : `${needsYou} ${needsYou === 1 ? "thing needs" : "things need"} you.`;
  }

  if (delivered === 0) {
    if (needsYou == null) return "I haven't finished anything yet.";
    return needsYou === 0
      ? "Nothing needs you. I'll bring you something when it lands."
      : `I haven't finished anything yet — ${needsYou} still ${needsYou === 1 ? "needs" : "need"} you.`;
  }

  const done = `${lead}: ${delivered} done`;
  if (needsYou == null) return `${done}.`;
  return needsYou === 0
    ? `${done}. Nothing needs you.`
    : `${done}, ${needsYou} need you.`;
}

export function useCanvasDoor(
  assistantId: string | null,
  /** Stamped once by the caller so the sentence does not move mid-session. */
  nowMs: number,
): CanvasDoor {
  const enabled = Boolean(assistantId);
  const path = { assistant_id: assistantId ?? "" };

  const review = useQuery({
    ...workitemsGetOptions({ path, query: { status: "awaiting_review" } }),
    enabled,
    refetchInterval: POLL_MS,
    staleTime: 15_000,
  });

  const interactions = useQuery({
    ...pendinginteractionsGetOptions({ path }),
    enabled,
    refetchInterval: POLL_MS,
    staleTime: 10_000,
  });

  const done = useQuery({
    ...workitemsGetOptions({ path, query: { status: "done" } }),
    enabled,
    refetchInterval: POLL_MS,
    staleTime: 15_000,
  });

  // Both halves of needs-you must have answered before the number is real. One
  // half plus a silence is a smaller number than the truth, which reads as
  // "less needs you than actually does" — the wrong direction to be wrong in.
  const needsYou =
    review.isSuccess && interactions.isSuccess
      ? (review.data.items?.length ?? 0) +
        (interactions.data.interactions?.length ?? 0)
      : null;

  const todayStart = startOfToday(nowMs);
  const delivered = done.isSuccess
    ? (done.data.items ?? []).filter(
        (item) => (item.updatedAt ?? item.createdAt) >= todayStart,
      ).length
    : null;

  const isPending =
    enabled &&
    !review.isSuccess &&
    !review.isError &&
    !done.isSuccess &&
    !done.isError;

  return {
    delivered,
    needsYou,
    sentence: doorSentence(delivered, needsYou, new Date(nowMs).getHours()),
    isPending,
  };
}
