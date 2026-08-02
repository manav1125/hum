/**
 * The counts and the one live signal the navigation itself renders.
 *
 * Three numbers, one boolean, two requests — deliberately small, because this
 * runs on every authenticated route, not just the surfaces it describes:
 *
 *   · `things`       — how many live containers Work holds  (▤ Work · 5)
 *   · `everything`   — how many live tasks the ledger holds (≣ Everything · 31)
 *   · `agentsWorking`— is anything running right now? The ◉ mark pulses on this,
 *                      which is how "is Cue working?" gets answered from any
 *                      screen without spending a nav slot on it.
 *
 * Both numbers are computed from the SAME fetches the Work surface uses, so
 * the rail cannot claim a count the page then contradicts — the sidebar/badge
 * disagreement this codebase already had to fix once.
 *
 * Never fabricates: with no assistant, or before the first response, every
 * count is 0 and the pulse is off. A badge that renders a guess is worse than
 * a badge that renders nothing.
 */

import { useQuery } from "@tanstack/react-query";

import {
  projectsGetOptions,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";

const POLL_MS = 60_000;

/** Statuses that count as "live" in the ledger — the ones still in play. */
const LIVE_STATUSES = new Set([
  "queued",
  "pending",
  "running",
  "awaiting_review",
]);

export interface NavCounts {
  /** Live containers. 0 when there are none (or nothing is known yet). */
  things: number;
  /** Live tasks across every container plus the unattached ones. */
  everything: number;
  /** True while at least one work item is actually running. */
  agentsWorking: boolean;
}

export function useNavCounts(assistantId: string | null): NavCounts {
  const enabled = !!assistantId;

  const projects = useQuery({
    ...projectsGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled,
    refetchInterval: POLL_MS,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  // One unfiltered read serves both the ledger count and the pulse — asking
  // twice (once for `running`, once for everything) would double the traffic
  // to answer one screen's worth of chrome.
  const workItems = useQuery({
    ...workitemsGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled,
    refetchInterval: POLL_MS,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const items = workItems.data?.items ?? [];

  return {
    things: (projects.data?.projects ?? []).filter(
      (p) => p.status !== "archived",
    ).length,
    everything: items.filter((i) => LIVE_STATUSES.has(i.status)).length,
    agentsWorking: items.some((i) => i.status === "running"),
  };
}
