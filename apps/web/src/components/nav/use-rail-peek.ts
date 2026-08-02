/**
 * The live data behind the rail's three-item peek.
 *
 * Two lanes, two different questions, two different sorts — which is the point
 * of v15's rule 2. HQ answers *what is most urgent*; Work answers *what has
 * something live*. Sorting both by the same key would have made one of the two
 * lanes a worse version of the other.
 *
 * Three invariants this file exists to hold:
 *
 * 1. **Never invent a count.** Each lane's `total` is the SAME number the rail
 *    renders in the badge beside the label — HQ's from `useNeedsYouBadge`,
 *    Work's from `useNavCounts` — so "N more in HQ ›" is arithmetic on the
 *    badge rather than a second, independently-derived number. This codebase
 *    has already shipped the bug where those two disagreed.
 * 2. **A lane that cannot read says so.** On a failed fetch the lane reports
 *    `unreadable`, never an empty list. "Nothing needs you" is the most
 *    expensive thing this rail could say falsely.
 * 3. **No new traffic.** Every query here re-uses an options factory the rail
 *    (or HQ) already calls with identical keys, so React Query dedupes them.
 *    The peek runs on every authenticated route; it does not get to add a
 *    round trip.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import {
  pendinginteractionsGetOptions,
  projectsGetOptions,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  peekDeadline,
  type PeekItem,
  type PeekLane,
} from "@/components/nav/nav-model";
import { useNavCounts } from "@/components/nav/use-nav-counts";
import { useNeedsYouBadge } from "@/hooks/use-needs-you-badge";
// The narrowing for the pending-interaction payload lives with the surface
// that decides them. Importing it (rather than re-deriving the same three
// fields here) is deliberate: a second copy of "what counts as an approval" is
// precisely how the deck and the badge drifted apart last time.
import { readPausedApprovals } from "@/pages/hq/paused-approvals";

const POLL_MS = 60_000;

export interface RailPeek {
  hq: PeekLane;
  work: PeekLane;
}

/** A work item as far as the peek is concerned. */
interface UrgencyCandidate {
  id: string;
  title?: string | null;
  dueAt?: number | null;
  priorityTier?: number | null;
  updatedAt?: number | null;
}

/**
 * Most urgent first: a real deadline beats no deadline, sooner beats later,
 * then the explicit priority tier, then the thing that has sat longest.
 *
 * Nulls sort LAST rather than first — an item with no due date is not urgent,
 * it is merely undated, and treating "unknown" as "now" is how an undated
 * backlog item ends up displacing a 10:30 deadline.
 */
export function byUrgency(a: UrgencyCandidate, b: UrgencyCandidate): number {
  const da = a.dueAt ?? null;
  const db = b.dueAt ?? null;
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  }
  const pa = a.priorityTier ?? Number.MAX_SAFE_INTEGER;
  const pb = b.priorityTier ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  return (a.updatedAt ?? 0) - (b.updatedAt ?? 0);
}

/** The three counts that make a thing "live", in the order they matter. */
export interface LivenessCandidate {
  id: string;
  title: string;
  awaitingReview: number;
  running: number;
  queued: number;
}

/** True when the thing has anything in play at all. */
export function isLive(t: LivenessCandidate): boolean {
  return t.awaitingReview + t.running + t.queued > 0;
}

/**
 * Liveness order: waiting on you, then working, then queued, then alphabetical
 * so the list does not reshuffle between polls when nothing has changed.
 */
export function byLiveness(a: LivenessCandidate, b: LivenessCandidate): number {
  if (a.awaitingReview !== b.awaitingReview)
    return b.awaitingReview - a.awaitingReview;
  if (a.running !== b.running) return b.running - a.running;
  if (a.queued !== b.queued) return b.queued - a.queued;
  return a.title.localeCompare(b.title);
}

/**
 * The one line a Work row is allowed on the right.
 *
 * Every state carries a glyph, so the row still reads correctly with no colour
 * at all — the counts alone would make "1 needs you" and "1 running" identical
 * to a screen reader and to anyone who cannot separate the two tints.
 */
export function livenessMeta(t: LivenessCandidate): string | null {
  if (t.awaitingReview > 0) return `◈ ${t.awaitingReview} needs you`;
  if (t.running > 0) return `◉ ${t.running} running`;
  if (t.queued > 0) return `◇ ${t.queued} queued`;
  return null;
}

export function useRailPeek(
  assistantId: string | null,
  nowOverride?: number,
): RailPeek {
  const enabled = !!assistantId;
  const path = { assistant_id: assistantId ?? "" };
  // Captured once per mount rather than read during render: `Date.now()` in a
  // render body is impure (`react-hooks/purity`), and a deadline label that
  // silently re-derives on every unrelated re-render is the kind of thing that
  // makes "10:30" flicker to "overdue" mid-hover. The rail re-mounts often
  // enough, and each lane re-polls on a 60s interval regardless.
  const [mountedAt] = useState(() => Date.now());
  const now = nowOverride ?? mountedAt;

  // The badge counts. Reading them here (rather than counting the rows below)
  // is what makes the peek's arithmetic provably the badge's arithmetic.
  const needsYou = useNeedsYouBadge(assistantId);
  const navCounts = useNavCounts(assistantId);

  const interactions = useQuery({
    ...pendinginteractionsGetOptions({ path }),
    enabled,
    refetchInterval: POLL_MS,
    staleTime: 10_000,
  });

  const review = useQuery({
    ...workitemsGetOptions({ path, query: { status: "awaiting_review" } }),
    enabled,
    refetchInterval: POLL_MS,
    staleTime: 15_000,
  });

  const projects = useQuery({
    ...projectsGetOptions({ path }),
    enabled,
    refetchInterval: POLL_MS,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const hq = useMemo((): PeekLane => {
    if (!enabled) return { status: "loading", items: [], total: 0 };
    // Partial failure is still failure: the total is the sum of both queries,
    // so one broken half makes the whole lane's arithmetic untrustworthy.
    if (interactions.isError || review.isError)
      return { status: "unreadable", items: [], total: 0 };
    if (interactions.isPending || review.isPending)
      return { status: "loading", items: [], total: 0 };

    // Approvals first. A parked approval is a run that has STOPPED until
    // somebody answers, which outranks a finished run nobody has read.
    const approvals: PeekItem[] = readPausedApprovals(
      interactions.data?.interactions,
    ).map((a) => ({
      id: `approval:${a.requestId}`,
      title: a.label,
      meta: "waiting",
    }));

    const awaiting: PeekItem[] = [...(review.data?.items ?? [])]
      .sort(byUrgency)
      .map((item) => ({
        id: `item:${item.id}`,
        title: item.title || "Untitled",
        meta: peekDeadline(item.dueAt, now),
      }));

    return {
      status: "ready",
      items: [...approvals, ...awaiting],
      total: needsYou.count,
    };
  }, [
    enabled,
    interactions.isError,
    interactions.isPending,
    interactions.data,
    review.isError,
    review.isPending,
    review.data,
    needsYou.count,
    now,
  ]);

  const work = useMemo((): PeekLane => {
    if (!enabled) return { status: "loading", items: [], total: 0 };
    if (projects.isError) return { status: "unreadable", items: [], total: 0 };
    if (projects.isPending) return { status: "loading", items: [], total: 0 };

    const candidates: LivenessCandidate[] = (projects.data?.projects ?? [])
      .filter((p) => p.status !== "archived")
      .map((p) => ({
        id: p.id,
        title: p.title || "Untitled",
        awaitingReview: p.stats?.counts?.awaiting_review ?? 0,
        running: p.stats?.counts?.running ?? 0,
        queued: p.stats?.counts?.queued ?? 0,
      }));

    return {
      status: "ready",
      // Only things with something live. A thing with nothing in play is not
      // a worse candidate for the peek — it is not a candidate at all, and
      // padding the list to three with dormant rows would make the peek stop
      // meaning anything.
      items: candidates
        .filter(isLive)
        .sort(byLiveness)
        .map((t) => ({
          id: `thing:${t.id}`,
          title: t.title,
          meta: livenessMeta(t),
        })),
      total: navCounts.things,
    };
  }, [
    enabled,
    projects.isError,
    projects.isPending,
    projects.data,
    navCounts.things,
  ]);

  return { hq, work };
}
