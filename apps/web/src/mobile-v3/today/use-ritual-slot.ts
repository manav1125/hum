/**
 * The ritual slot's data — and, just as importantly, the data it does NOT ask
 * for.
 *
 * Both reads are gated on their own window, so on a Tuesday afternoon this
 * hook issues no requests at all. That is not only a cost argument: a slot
 * that fetches whether or not it can render is a slot that will eventually be
 * rendered "just while we have the data", which is how a permanent empty row
 * gets built by accident.
 *
 * The brief rides `useMorningBrief` — the same hook, the same endpoint, the
 * same payload the Brief surface itself renders. The weekly rides the same two
 * generated queries the Weekly page uses, and folds them with the same pure
 * functions (`weekly/weekly-signal.ts`), so the teaser and the page cannot
 * report different weeks.
 *
 * React Query dedupes by key, so opening the surface from the slot re-uses the
 * response the slot already had rather than fetching it twice.
 */
import { useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  actsSummaryGetOptions,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { routes } from "@/utils/routes";

import { useMorningBrief } from "../brief/use-morning-brief";
import {
  countCleared,
  countSlipped,
  type WeeklyWorkItemLike,
} from "../weekly/weekly-signal";
import {
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
  type WeeklyFacts,
} from "./ritual-slot";

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
    }),
    // `version` is the invalidation signal; the values come from storage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [now, version],
  );
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

  return useMemo(
    () =>
      pickRitualFace({
        now,
        brief: briefFactsFrom(brief),
        weekly,
        briefProgress: assistantId ? progress.brief : NO_PROGRESS,
        weeklyProgress: assistantId ? progress.weekly : NO_PROGRESS,
        briefHref: routes.brief,
        weeklyHref: routes.weekly,
      }),
    [now, brief, weekly, progress, assistantId],
  );
}
