/**
 * The weekly review's two headline numbers, as pure functions.
 *
 * They were computed inline in `mv3-weekly-page.tsx`, which was correct while
 * the page was the only thing that knew them. The ritual slot on Today now
 * teases the same week ("Nine things moved. Two slipped."), and a teaser that
 * re-derives its numbers is how a card and the page it opens come to disagree
 * in front of the owner — the same failure that once had the HQ headline
 * reading 6 while the sidebar badge read 5, both from real data.
 *
 * So both read these. The definitions, and their honest limits, are unchanged:
 *
 *  · **cleared** — work items carry no `completedAt`, only `updatedAt`, and
 *    `workitemsGet` takes no date range. This is *done items whose row was
 *    last touched inside the window*, which is an approximation, and the page
 *    labels it as one on screen.
 *  · **slipped** — overdue, going cold, or nothing for `STALE_DAYS`.
 */

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
/** Nothing has touched it in this long → it slipped. */
export const STALE_DAYS = 5;

const DONE_STATUSES = new Set(["done", "completed"]);
const CLOSED_STATUSES = new Set(["done", "completed", "cancelled", "archived"]);

/**
 * The shape both callers pass — the fields of `workitemsGet`'s rows that these
 * two computations read, and nothing else. Structural, so the generated SDK's
 * row type satisfies it without either side importing the other's.
 */
export interface WeeklyWorkItemLike {
  id: string;
  title: string;
  status: string;
  updatedAt?: number | null;
  dueAt?: number | null;
  lastActivityAt?: number | null;
  waitingState?: string | null;
  ranProvenance?: string | null;
  completedElsewhere?: boolean | null;
}

/** "You cleared N" — done inside the window, by the owner rather than by Cue. */
export function countCleared(
  items: readonly WeeklyWorkItemLike[],
  now: number,
): number {
  return items.filter(
    (i) =>
      DONE_STATUSES.has(i.status) &&
      (i.updatedAt ?? 0) >= now - WEEK_MS &&
      (i.ranProvenance === "manual" || i.completedElsewhere === true),
  ).length;
}

/** What slipped, phrased — capped at `limit` for the page's list. */
export function listSlipped(
  items: readonly WeeklyWorkItemLike[],
  now: number,
  limit = 5,
): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  for (const i of items) {
    if (CLOSED_STATUSES.has(i.status)) continue;
    if (i.dueAt && i.dueAt < now) {
      out.push({
        id: i.id,
        text: `${i.title} — ${Math.floor((now - i.dueAt) / DAY_MS)}d past due`,
      });
      continue;
    }
    if (i.waitingState === "going_cold") {
      out.push({ id: i.id, text: `${i.title} — waiting, and going cold` });
      continue;
    }
    const idle = i.lastActivityAt ? now - i.lastActivityAt : 0;
    if (idle > STALE_DAYS * DAY_MS) {
      out.push({
        id: i.id,
        text: `${i.title} — nothing for ${Math.floor(idle / DAY_MS)} days`,
      });
    }
  }
  return out.slice(0, limit);
}

/**
 * How many slipped, uncapped.
 *
 * The slot's sentence must say the true number, not the page's display cap —
 * "Two slipped" is a fact about the week, while the list's five is a fact
 * about a phone screen.
 */
export function countSlipped(
  items: readonly WeeklyWorkItemLike[],
  now: number,
): number {
  return listSlipped(items, now, Number.MAX_SAFE_INTEGER).length;
}
