/**
 * The ritual slot's data — and, just as importantly, the data it does NOT ask
 * for.
 *
 * Every read is gated on the window that could use it, so on a Tuesday
 * afternoon this hook issues no requests at all. That is not only a cost
 * argument: a slot that fetches whether or not it can render is a slot that
 * will eventually be rendered "just while we have the data", which is how a
 * permanent empty row gets built by accident.
 *
 * The brief rides `useMorningBrief` — the same hook, the same endpoint, the
 * same payload the Brief surface itself renders. The weekly rides the same two
 * generated queries the Weekly page uses, and folds them with the same pure
 * functions (`weekly/weekly-signal.ts`), so the teaser and the page cannot
 * report different weeks. The two figures R3 and R5 need — what arrived, and
 * what is being watched — ride the same queries the arrivals lane and the
 * Watching page already run, under the same keys, so nothing here is a second
 * source of truth for a number the rest of Today is also stating.
 *
 * React Query dedupes by key, so opening the surface from the slot re-uses the
 * response the slot already had rather than fetching it twice.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  actsSummaryGetOptions,
  arrivalsSummaryGetOptions,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { client } from "@/generated/daemon/client.gen";
import type { Watcher } from "@/mobile-v3/you/use-automations-data";
import { routes } from "@/utils/routes";

import { useMorningBrief } from "../brief/use-morning-brief";
import {
  countCleared,
  countSlipped,
  type WeeklyWorkItemLike,
} from "../weekly/weekly-signal";
import {
  hasSeenBrief as readHasSeenBrief,
  markFirstBriefMorning,
  NO_PROGRESS,
  readRitualProgress,
  ritualProgressVersion,
  subscribeRitualProgress,
} from "./ritual-progress";
import {
  briefFactsFrom,
  isBriefWindow,
  isWeeklyWindow,
  pickRitualFace,
  type RitualFace,
  type BriefIntake,
  type WeeklyFacts,
} from "./ritual-slot";

/**
 * The overnight window the intake figures are read over.
 *
 * 24 hours, because that is the window `GET /brief/morning` itself defaults to
 * (`SINCE_HOURS` in the daemon route). "One night in, and I've read 41 things"
 * has to be counted over the same night the rest of the brief is about, or the
 * introduction and the surface it introduces are describing different periods.
 */
const OVERNIGHT_HOURS = 24;

/**
 * Progress, as a subscribed snapshot.
 *
 * `useSyncExternalStore` rather than local state because the Brief page marks
 * itself read on mount, and that mark has to reach a Today that is still
 * mounted behind it — otherwise coming back from the brief shows the same card
 * still asking you to read the thing you just read.
 */
function useProgress(now: Date) {
  const version = useSyncExternalStore(
    subscribeRitualProgress,
    ritualProgressVersion,
    () => 0,
  );
  return useMemo(
    () => ({
      brief: readRitualProgress("brief", now),
      weekly: readRitualProgress("weekly", now),
      // R5's one extra boolean, read through the same subscription so the
      // stamp written below re-renders the slot rather than waiting for the
      // next unrelated render to notice it.
      seenBrief: readHasSeenBrief(now),
    }),
    // `version` is the invalidation signal; the values come from storage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [now, version],
  );
}

/**
 * What arrived overnight — R5's "41 things" and "twelve looked like yours".
 *
 * A pending or failed read is `null`, not zeroes, because the first-brief face
 * is composed FROM these figures: design's rule is that a serif sentence is not
 * licence to be vague, so a face that cannot count does not appear.
 *
 * Wanted only before the owner has met a brief. After that no face states an
 * intake number, and asking anyway would be a read a morning for a sentence
 * nobody will see.
 */
function useIntake(
  assistantId: string | null,
  enabled: boolean,
): BriefIntake | null {
  const on = enabled && Boolean(assistantId);
  const arrivals = useQuery({
    ...arrivalsSummaryGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { windowHours: OVERNIGHT_HOURS },
    }),
    enabled: on,
    staleTime: 60_000,
  });

  const data = arrivals.data;
  return useMemo(() => {
    if (!on || data === undefined) return null;
    return { read: data.arrived, yours: data.kept };
  }, [on, data]);
}

/**
 * How many sources Cue is actually watching — R3's "6 sources, no movement".
 *
 * Wanted on EVERY morning the brief could be quiet, which is every morning:
 * that clause is the difference between a quiet night and a broken pipeline,
 * and gating it behind the first-brief read (as this hook first did) silently
 * dropped it from the face design drew it for.
 *
 * `undefined` is not zero. `?? []` here is exactly how a pending query becomes
 * a confident "0 sources, no movement" on a healthy morning — so a read that
 * has not landed yields `null` and the clause simply is not stated. And a
 * watcher that EXISTS is not a watcher that WORKS: the same
 * `enabled && !lastError` filter HQ's Watching lane applies, for the same
 * reason.
 */
function useSourceCount(
  assistantId: string | null,
  enabled: boolean,
): number | null {
  const on = enabled && Boolean(assistantId);
  // The Watching page's own key, so this shares its cache rather than opening
  // a second one. `watchers/list` is a POST route with no generated query.
  const watchers = useQuery({
    queryKey: ["automations", "watchers", assistantId ?? ""],
    enabled: on,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, response } = await client.post<Watcher[], unknown>({
        url: `/v1/assistants/${assistantId ?? ""}/watchers/list`,
        body: {},
        throwOnError: false,
      });
      if (!response?.ok) throw new Error(`watchers/list ${response?.status}`);
      return Array.isArray(data) ? data : [];
    },
  });

  const rows = watchers.data;
  if (!on || rows === undefined) return null;
  return rows.filter((w) => w.enabled && !w.lastError).length;
}

export function useRitualSlot(
  assistantId: string | null,
  /** Stamped once by the caller — reading the clock during render is impure. */
  now: Date,
): RitualFace | null {
  const briefWindow = isBriefWindow(now);
  const weeklyWindow = isWeeklyWindow(now);
  const progress = useProgress(now);

  const { brief } = useMorningBrief(briefWindow ? assistantId : null);

  const intake = useIntake(assistantId, briefWindow && !progress.seenBrief);
  const sources = useSourceCount(assistantId, briefWindow);

  const weeklyEnabled = weeklyWindow && Boolean(assistantId);
  const acts = useQuery({
    ...actsSummaryGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { days: 7 },
    }),
    enabled: weeklyEnabled,
  });
  const work = useQuery({
    ...workitemsGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: weeklyEnabled,
  });

  const nowMs = now.getTime();
  const weekly = useMemo<WeeklyFacts | null>(() => {
    // Omit rather than fake: a half-read week is not a week. Both reads have
    // to have landed before the slot is allowed to state a number.
    if (!weeklyEnabled) return null;
    if (acts.data === undefined || work.data === undefined) return null;
    const items = (work.data.items ?? []) as WeeklyWorkItemLike[];
    return {
      moved: (acts.data.acts ?? 0) + countCleared(items, nowMs),
      slipped: countSlipped(items, nowMs),
    };
  }, [weeklyEnabled, acts.data, work.data, nowMs]);

  const face = useMemo(
    () =>
      pickRitualFace({
        now,
        brief: briefFactsFrom(brief),
        weekly,
        intake,
        sources,
        hasSeenBrief: assistantId ? progress.seenBrief : true,
        briefProgress: assistantId ? progress.brief : NO_PROGRESS,
        weeklyProgress: assistantId ? progress.weekly : NO_PROGRESS,
        briefHref: routes.brief,
        weeklyHref: routes.weekly,
      }),
    [now, brief, weekly, intake, sources, progress, assistantId],
  );

  /**
   * The introduction happened — stamp the day.
   *
   * Written when the face is DECIDED rather than when the owner reacts to it,
   * because the exception design granted is a morning, not a tap: whether they
   * read it, pressed Later, or never came back, this owner has now met a brief
   * and tomorrow's is an ordinary one. Idempotent in the store, so a re-render
   * cannot move the stamp forward.
   */
  useEffect(() => {
    if (face?.state === "open" && face.tone === "first") {
      markFirstBriefMorning(now);
    }
  }, [face, now]);

  return face;
}
