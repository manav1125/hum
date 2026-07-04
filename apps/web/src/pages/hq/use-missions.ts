/**
 * Missions data hooks — thin wrappers over the generated daemon SDK with the
 * same SSE-first, 60s-safety-net freshness posture as `use-projects` /
 * `use-work-items`.
 *
 * Also owns the honest phase-1 ring derivation: a mission ring is
 *   blocked   → paused, or stopped at its budget ceiling
 *   needs_you → any linked work item awaiting review
 *   on_track  → otherwise
 * (% progress is phase 2 — it appears only when a real metric is connected.)
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  companyprofileGetOptions,
  companyprofileGetQueryKey,
  companyprofilePutMutation,
  missionsByIdEventsGetOptions,
  missionsByIdEventsGetQueryKey,
  missionsByIdGetOptions,
  missionsByIdGetQueryKey,
  missionsByIdPatchMutation,
  missionsByIdRuncyclePostMutation,
  missionsGetOptions,
  missionsGetQueryKey,
  missionsPostMutation,
  projectsByIdPatchMutation,
  projectsGetQueryKey,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  MissionsGetResponses,
  MissionsByIdEventsGetResponses,
  ProjectsByIdPatchData,
  WorkitemsGetResponses,
} from "@/generated/daemon/types.gen";

import type { RingStatus } from "./hq-kit";

export type Mission = MissionsGetResponses[200]["missions"][number];
export type MissionRollup = Mission["rollup"];
export type MissionEvent =
  MissionsByIdEventsGetResponses[200]["events"][number];
export type HqWorkItem = WorkitemsGetResponses[200]["items"][number];
export type WorkspaceMode = "observe" | "assist" | "autonomous";

const SAFETY_NET_MS = 60_000;

/** Honest status ring for a mission, derived from its live rollup. */
export function ringStatusFor(m: Mission): RingStatus {
  const budgetStopped =
    m.budgetCents != null && m.budgetCents > 0 && m.spentCents >= m.budgetCents;
  if (m.status === "paused" || budgetStopped) return "blocked";
  if (m.rollup.counts.awaiting_review > 0) return "needs_you";
  return "on_track";
}

export function useMissions(assistantId: string) {
  const query = useQuery({
    ...missionsGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: SAFETY_NET_MS,
    staleTime: 15_000,
  });
  return {
    missions: query.data?.missions ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

export function useMission(assistantId: string, missionId: string) {
  const query = useQuery({
    ...missionsByIdGetOptions({
      path: { assistant_id: assistantId, id: missionId },
    }),
    refetchInterval: SAFETY_NET_MS,
    staleTime: 10_000,
    enabled: Boolean(missionId),
  });
  return {
    mission: query.data?.mission ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

export function useMissionEvents(assistantId: string, missionId: string) {
  const query = useQuery({
    ...missionsByIdEventsGetOptions({
      path: { assistant_id: assistantId, id: missionId },
      query: { limit: 60 },
    }),
    refetchInterval: 30_000,
    staleTime: 10_000,
    enabled: Boolean(missionId),
  });
  return {
    events: query.data?.events ?? [],
    isLoading: query.isLoading,
  };
}

function invalidateMissions(
  queryClient: ReturnType<typeof useQueryClient>,
  assistantId: string,
  missionId?: string,
) {
  void queryClient.invalidateQueries({
    queryKey: missionsGetQueryKey({ path: { assistant_id: assistantId } }),
  });
  if (missionId) {
    void queryClient.invalidateQueries({
      queryKey: missionsByIdGetQueryKey({
        path: { assistant_id: assistantId, id: missionId },
      }),
    });
  }
}

export function useCreateMission(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...missionsPostMutation(),
    onSettled: () => invalidateMissions(queryClient, assistantId),
  });
}

export function usePatchMission(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...missionsByIdPatchMutation(),
    onSettled: (_d, _e, variables) =>
      invalidateMissions(queryClient, assistantId, variables?.path?.id),
  });
}

export function useRunCycle(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...missionsByIdRuncyclePostMutation(),
    onSettled: (_d, _e, variables) => {
      const id = variables?.path?.id;
      invalidateMissions(queryClient, assistantId, id);
      if (id) {
        void queryClient.invalidateQueries({
          queryKey: missionsByIdEventsGetQueryKey({
            path: { assistant_id: assistantId, id },
            query: { limit: 60 },
          }),
        });
      }
    },
  });
}

/**
 * Link/unlink a project to a mission. `missionId` isn't in this checkout's
 * generated PATCH body yet (the missions backend deploys in parallel); the
 * daemon accepts it, so we widen the body type here — remove the cast once the
 * spec copy catches up.
 */
export function useLinkProject(assistantId: string) {
  const queryClient = useQueryClient();
  const patch = useMutation({
    ...projectsByIdPatchMutation(),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: projectsGetQueryKey({ path: { assistant_id: assistantId } }),
      });
      invalidateMissions(queryClient, assistantId);
    },
  });
  return {
    ...patch,
    link: (
      projectId: string,
      missionId: string | null,
      opts?: { onSettled?: () => void },
    ) =>
      patch.mutate(
        {
          path: { assistant_id: assistantId, id: projectId },
          body: { missionId } as ProjectsByIdPatchData["body"] & {
            missionId: string | null;
          },
        },
        { onSettled: opts?.onSettled },
      ),
  };
}

export function useCompanyProfile(assistantId: string) {
  const query = useQuery({
    ...companyprofileGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });
  return {
    profile: query.data?.profile ?? null,
    isLoading: query.isLoading,
  };
}

export function usePutCompanyProfile(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...companyprofilePutMutation(),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: companyprofileGetQueryKey({
          path: { assistant_id: assistantId },
        }),
      }),
  });
}

/**
 * Fully-typed work-item bucket for HQ (the activity-domain narrow drops the
 * fields HQ needs: `lastProgressNote`, `sourceType`, `lastRunConversationId`).
 * SSE (`useActivitySync`) invalidates this cache on work-item events; the poll
 * is the safety net.
 */
export function useHqWorkItems(
  assistantId: string,
  status?: "pending" | "running" | "awaiting_review" | "done" | "failed",
) {
  const query = useQuery({
    ...workitemsGetOptions({
      path: { assistant_id: assistantId },
      query: status ? { status } : {},
    }),
    refetchInterval: SAFETY_NET_MS,
    staleTime: 15_000,
  });
  return {
    items: query.data?.items ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/** projectId → mission lookup built from mission rollups. */
export function missionByProject(missions: Mission[]): Map<string, Mission> {
  const map = new Map<string, Mission>();
  for (const m of missions) {
    for (const p of m.rollup.projects) map.set(p.id, m);
  }
  return map;
}

/** Humanize a mission event kind (+ best-effort payload detail). */
export function humanizeEvent(e: MissionEvent): {
  title: string;
  detail: string | null;
  color: string;
} {
  let payload: Record<string, unknown> | null = null;
  if (e.payload) {
    try {
      const parsed = JSON.parse(e.payload) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // Opaque payload — the kind line still reads fine on its own.
    }
  }
  const s = (k: string): string | null => {
    const v = payload?.[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  const detail =
    s("title") ?? s("summary") ?? s("note") ?? s("reason") ?? s("message");

  switch (e.kind) {
    case "cycle_started":
      return { title: "Cycle started", detail, color: "var(--mv1-blue)" };
    case "assessed":
      return { title: "Assessed the mission", detail, color: "var(--mv1-t3)" };
    case "planned":
      return {
        title: "Planned next moves",
        detail,
        color: "var(--mv1-violet)",
      };
    case "item_enqueued":
      return {
        title: detail ? `Queued: ${detail}` : "Queued a work item",
        detail: null,
        color: "var(--hq-teal)",
      };
    case "output_ready":
      return {
        title: detail ? `Output ready — ${detail}` : "Output ready",
        detail: null,
        color: "var(--mv1-green)",
      };
    case "checkpoint":
      return {
        title: "Checkpoint — needs you",
        detail,
        color: "var(--mv1-amber)",
      };
    case "budget_stop":
      return {
        title: "Stopped at the budget ceiling",
        detail,
        color: "var(--mv1-danger)",
      };
    case "reported":
      return { title: "Reported progress", detail, color: "var(--mv1-blue)" };
    case "error":
      return { title: "Hit an error", detail, color: "var(--mv1-danger)" };
    default:
      return {
        title: e.kind.replaceAll("_", " "),
        detail,
        color: "var(--mv1-t3)",
      };
  }
}
