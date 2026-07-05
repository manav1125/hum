/**
 * §6 · Mission-lifecycle data binding — the achieved-celebration stats.
 *
 * `GET /missions/:id/achieved-summary` rolls a mission's life up into cycles /
 * outputs / spend / duration / hours-back. It's newer than the generated daemon
 * SDK, so we name the wire shape by hand and call the already-authed daemon
 * `client` (same pattern as `use-trust-evidence`). When codegen catches up this
 * can swap to the generated hook with no call-site churn.
 */

import { useQuery } from "@tanstack/react-query";

import { client } from "@/generated/daemon/client.gen";

export interface MissionAchievedSummary {
  cycles: number;
  outputs: number;
  itemsEnqueued: number;
  spentCents: number;
  durationMs: number | null;
  hoursSaved: number;
}

export function useMissionAchievedSummary(
  assistantId: string,
  missionId: string,
  enabled = true,
) {
  const query = useQuery({
    queryKey: ["mission-achieved-summary", assistantId, missionId],
    enabled: Boolean(assistantId && missionId && enabled),
    staleTime: 60_000,
    queryFn: async (): Promise<MissionAchievedSummary | null> => {
      try {
        const { data, response } = await client.get<
          { summary?: MissionAchievedSummary },
          unknown
        >({
          url: "/v1/assistants/{assistant_id}/missions/{id}/achieved-summary",
          path: { assistant_id: assistantId, id: missionId },
          throwOnError: false,
        });
        const body = data as { summary?: MissionAchievedSummary } | undefined;
        if (response?.ok && body?.summary) return body.summary;
      } catch {
        // Route not reachable yet — the celebration falls back to spend alone.
      }
      return null;
    },
  });
  return { summary: query.data ?? null, isLoading: query.isLoading };
}

/** "41 days" / "3 days" / "6 hours" from a duration in ms, or null. */
export function durationLabel(ms: number | null): string | null {
  if (ms == null || ms <= 0) return null;
  const days = Math.round(ms / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
