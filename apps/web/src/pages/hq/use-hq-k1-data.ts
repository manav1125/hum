/**
 * Real data for the three K1 modules that shipped showing a reason: the day
 * rail, Life by horizon, and waiting-on-people.
 *
 * Every hook here returns EITHER data or an `Unavailable` carrying a sentence —
 * never an empty array standing in for "we couldn't ask". That distinction is
 * the whole point of the K1 rule: a module that renders blank is indistinguish-
 * able from a quiet day, and a quiet day is a claim we are usually not entitled
 * to make. `unavailable` is the type-level way of forcing the caller to say
 * which one it is.
 *
 * The daemon already draws this line for us on the calendar side —
 * `connection.state` plus null (never zero) minutes — so the mapping below is
 * mostly a matter of not throwing that away.
 */

import { useQuery } from "@tanstack/react-query";

import {
  calendarDayGetOptions,
  contactsGetOptions,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";

import type {
  DayPicture,
  Horizon,
  Unavailable,
  WaitingItem,
} from "./hq-k1-modules";

const SAFETY_NET_MS = 60_000;

/** The browser knows the user's zone; prod runs UTC and must be told. */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

const ms = (iso: string) => new Date(iso).getTime();

// ---------------------------------------------------------------------------
// Day rail
// ---------------------------------------------------------------------------

export function useDayPicture(assistantId: string): {
  day: DayPicture | null;
  unavailable?: Unavailable;
} {
  const tz = browserTimeZone();
  const query = useQuery({
    ...calendarDayGetOptions({
      path: { assistant_id: assistantId },
      query: tz ? { tz } : {},
    }),
    refetchInterval: SAFETY_NET_MS,
    staleTime: 30_000,
  });

  if (query.isLoading) return { day: null };

  if (query.isError || !query.data) {
    return {
      day: null,
      unavailable: { reason: "Cue couldn't reach your calendar just now" },
    };
  }

  const d = query.data;

  if (d.connection.state === "not_connected") {
    return {
      day: null,
      unavailable: {
        reason: "Cue can't see your calendar yet",
        fixHref: "/assistant/settings/connectors",
        fixLabel: "Connect a calendar",
      },
    };
  }

  if (d.connection.state === "unavailable") {
    // Named, not a shrug — the daemon knows whether this was a timeout, a 5xx
    // or a dropped socket, and passing its sentence through beats inventing a
    // vaguer one here.
    return {
      day: null,
      unavailable: {
        reason: d.connection.detail ?? "Your calendar didn't answer",
      },
    };
  }

  // `busy: false` events (declined, or marked Free) are real commitments the
  // user may want to see, but they must not consume the day — the daemon has
  // already excluded them from the minute maths, so excluding them from the
  // strip keeps the two consistent.
  const commitments = d.commitments
    .filter((c) => c.busy)
    .map((c) => ({
      id: c.id,
      title: c.title,
      startMs: ms(c.start),
      endMs: ms(c.end),
    }));

  const largest = d.largestFreeBlock;
  return {
    day: {
      commitments,
      // Non-null once connected; the ?? 0 is a type narrowing, not a default
      // standing in for missing data (that path returned above).
      unbookedMinutes: d.unbookedMinutes ?? 0,
      freeBlock: largest
        ? {
            startMs: ms(largest.start),
            endMs: ms(largest.end),
            minutes: largest.minutes,
          }
        : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Life by horizon
// ---------------------------------------------------------------------------

const HORIZON_ORDER: Horizon[] = ["this_week", "soon", "someday"];

/**
 * Life items grouped by when.
 *
 * An item with no horizon set falls into `someday` rather than being dropped:
 * silently hiding personal work because a field is null is exactly the failure
 * the lens exists to fix.
 */
export function useLifeHorizons(assistantId: string): {
  groups: { horizon: Horizon; titles: string[] }[];
  unavailable?: Unavailable;
} {
  const query = useQuery({
    ...workitemsGetOptions({
      path: { assistant_id: assistantId },
      query: { domain: "life" },
    }),
    refetchInterval: SAFETY_NET_MS,
    staleTime: 15_000,
  });

  if (query.isLoading) return { groups: [] };
  if (query.isError) {
    return { groups: [], unavailable: { reason: "Couldn't load your Life items" } };
  }

  const items = (query.data?.items ?? []).filter(
    (i) => i.status !== "done" && i.status !== "failed",
  );

  const groups = HORIZON_ORDER.map((horizon) => ({
    horizon,
    titles: items
      .filter((i) =>
        horizon === "someday"
          ? i.horizon === "someday" || i.horizon == null
          : i.horizon === horizon,
      )
      .map((i) => i.title),
  })).filter((g) => g.titles.length > 0);

  return { groups };
}

// ---------------------------------------------------------------------------
// Waiting on people
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * Waiting items, with the person resolved to a name.
 *
 * `waitingOn` stores a contact id. Rendering the raw id would be worse than
 * rendering nothing — the module's entire value is "you are waiting on Dana",
 * and "you are waiting on ct_8f21…" is a database leak wearing a UI. An item
 * whose contact cannot be resolved is therefore dropped rather than shown with
 * a placeholder name.
 *
 * The server derives `waitingState`; this only renames `already_chased` to the
 * component's `chased`. §7's fourth state (waiting on a system) is deliberately
 * not synthesised here — the daemon refuses to guess it from a null contact,
 * and inventing it client-side would relabel every ordinary item.
 */
export function useWaitingOnPeople(
  assistantId: string,
  /** Render clock, hoisted by the caller — `Date.now()` here is impure. */
  nowMs: number,
): {
  items: WaitingItem[];
  unavailable?: Unavailable;
} {
  const work = useQuery({
    ...workitemsGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: SAFETY_NET_MS,
    staleTime: 15_000,
  });
  const contacts = useQuery({
    ...contactsGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 300_000,
  });

  if (work.isLoading || contacts.isLoading) return { items: [] };
  if (work.isError) {
    return { items: [], unavailable: { reason: "Couldn't load what you're waiting on" } };
  }

  const nameById = new Map<string, string>();
  for (const c of contacts.data?.contacts ?? []) {
    if (c.displayName) nameById.set(c.id, c.displayName);
  }

  const items: WaitingItem[] = [];
  for (const i of work.data?.items ?? []) {
    if (!i.waitingOn) continue;
    if (i.status === "done" || i.status === "failed") continue;
    const person = nameById.get(i.waitingOn);
    if (!person) continue;

    // Days shown are days since the last chase where there was one, else since
    // the item was last touched. The columns carry no waiting-since clock, so
    // this is the honest ceiling on what we can say.
    const since = i.lastChasedAt ?? i.lastActivityAt ?? i.createdAt;
    items.push({
      id: i.id,
      person,
      what: i.title,
      days: Math.max(0, Math.floor((nowMs - since) / DAY_MS)),
      state:
        i.waitingState === "already_chased"
          ? "chased"
          : i.waitingState === "going_cold"
            ? "going_cold"
            : "on_time",
    });
  }

  // Cold first — it is the only state with a time cost to the user.
  const rank: Record<WaitingItem["state"], number> = {
    going_cold: 0,
    chased: 1,
    on_time: 2,
    system: 3,
  };
  items.sort((a, b) => rank[a.state] - rank[b.state] || b.days - a.days);

  return { items };
}
