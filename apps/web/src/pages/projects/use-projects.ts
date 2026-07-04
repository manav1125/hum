/**
 * Projects data hooks — thin wrappers over the generated SDK with the same
 * SSE-first, 60s-safety-net freshness posture as `use-work-items`.
 *
 * The daemon now returns rich projects (category / context brief / pinned /
 * sortIndex) plus per-project stats (per-status counts + the single most-urgent
 * next task) straight off `GET /projects`, so the cowork surface reads its
 * cards without a second pass. Work items carry per-task `context`, a
 * `sourceContext` origin snapshot, and `lastActivityAt` — all surfaced in the
 * task drawer.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  missionsGetOptions,
  projectsByIdDeleteMutation,
  projectsByIdGetOptions,
  projectsByIdGetQueryKey,
  projectsByIdPatchMutation,
  projectsByIdWorkitemsGetOptions,
  projectsByIdWorkitemsGetQueryKey,
  projectsGetOptions,
  projectsGetQueryKey,
  projectsPostMutation,
  projectsReorderPostMutation,
  workitemsByIdPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { ProjectsGetResponses } from "@/generated/daemon/types.gen";

/** Per-status tally + most-urgent next task, straight off the stats endpoint. */
export interface ProjectStats {
  counts: {
    queued: number;
    running: number;
    awaiting_review: number;
    done: number;
    open: number;
    total: number;
  };
  nextTask: {
    id: string;
    title: string;
    status: string;
    dueAt: number | null;
    priorityTier: number;
  } | null;
}

export interface ProjectView {
  id: string;
  title: string;
  emoji: string | null;
  color: string | null;
  status: "active" | "archived";
  category: string | null;
  context: string | null;
  sortIndex: number | null;
  pinned: boolean;
  /** Mission this project serves as an initiative of (⟡ tag), or null. */
  missionId: string | null;
  createdAt: number;
  updatedAt: number;
  stats: ProjectStats | null;
}

type RawProjectWithStats = ProjectsGetResponses[200]["projects"][number];
/** Single-project GET omits `stats`; accept either shape. */
type RawProject = Omit<RawProjectWithStats, "stats"> & {
  stats?: RawProjectWithStats["stats"] | null;
};

function toView(p: RawProject): ProjectView {
  return {
    id: p.id,
    title: p.title,
    emoji: p.emoji ?? null,
    color: p.color ?? null,
    status: p.status,
    category: p.category ?? null,
    context: p.context ?? null,
    sortIndex: p.sortIndex ?? null,
    pinned: (p.pinned ?? 0) > 0,
    missionId: p.missionId ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    stats: p.stats
      ? {
          counts: p.stats.counts,
          nextTask: p.stats.nextTask ?? null,
        }
      : null,
  };
}

export function useProjects(assistantId: string) {
  const query = useQuery({
    ...projectsGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: 60_000,
    staleTime: 20_000,
  });
  const projects: ProjectView[] = (query.data?.projects ?? []).map(toView);
  return {
    projects,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}

/** A single project's canonical record (drives the detail header + brief). */
export function useProject(assistantId: string, projectId: string) {
  const query = useQuery({
    ...projectsByIdGetOptions({
      path: { assistant_id: assistantId, id: projectId },
    }),
    staleTime: 20_000,
    enabled: Boolean(projectId),
  });
  const p = query.data?.project;
  return {
    project: p ? toView(p) : null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

function invalidateProjects(
  queryClient: ReturnType<typeof useQueryClient>,
  assistantId: string,
) {
  return queryClient.invalidateQueries({
    queryKey: projectsGetQueryKey({ path: { assistant_id: assistantId } }),
  });
}

export function useCreateProject(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...projectsPostMutation(),
    onSettled: () => void invalidateProjects(queryClient, assistantId),
  });
}

/** Rename / restyle / archive / edit-context / pin — the project write path. */
export function usePatchProject(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...projectsByIdPatchMutation(),
    onSettled: (_d, _e, variables) => {
      void invalidateProjects(queryClient, assistantId);
      const id = variables?.path?.id;
      if (id) {
        void queryClient.invalidateQueries({
          queryKey: projectsByIdGetQueryKey({
            path: { assistant_id: assistantId, id },
          }),
        });
      }
    },
  });
}

export function useDeleteProject(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...projectsByIdDeleteMutation(),
    onSettled: () => void invalidateProjects(queryClient, assistantId),
  });
}

export function useReorderProjects(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...projectsReorderPostMutation(),
    onSettled: () => void invalidateProjects(queryClient, assistantId),
  });
}

/**
 * Patch a work item. The daemon's PATCH requires the FULL record (title, notes,
 * status, … context) even for a one-field change, so callers pass a complete
 * body assembled from the current item. Invalidates the owning project's board.
 */
export function usePatchWorkItem(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...workitemsByIdPatchMutation(),
    onSettled: (_d, _e, variables) => {
      // The move-between-projects path touches two boards; refresh the list
      // level (all projects' stats) + any per-project board we know about.
      void invalidateProjects(queryClient, assistantId);
      const projectId =
        variables && "body" in variables
          ? (variables.body as { projectId?: string | null }).projectId
          : undefined;
      if (projectId) {
        void queryClient.invalidateQueries({
          queryKey: projectsByIdWorkitemsGetQueryKey({
            path: { assistant_id: assistantId, id: projectId },
          }),
        });
      }
      // Broad refresh: any project board currently mounted.
      void queryClient.invalidateQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) &&
          q.queryKey.some(
            (k) =>
              typeof k === "object" &&
              k !== null &&
              "_id" in k &&
              (k as { _id?: string })._id === "projectsByIdWorkitemsGet",
          ),
      });
    },
  });
}

/**
 * missionId → mission title lookup for the ⟡ tags on project cards. Reads the
 * missions list straight off the generated SDK (the HQ page's `use-missions`
 * lives in another surface's folder, so this stays a local, read-only lookup).
 */
export function useMissionTitles(assistantId: string): Map<string, string> {
  const query = useQuery({
    ...missionsGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });
  const map = new Map<string, string>();
  for (const m of query.data?.missions ?? []) map.set(m.id, m.title);
  return map;
}

/** A project's board rows (full work-item records; all statuses). */
export function useProjectWorkItems(assistantId: string, projectId: string) {
  const query = useQuery({
    ...projectsByIdWorkitemsGetOptions({
      path: { assistant_id: assistantId, id: projectId },
    }),
    refetchInterval: 60_000,
    staleTime: 15_000,
    enabled: Boolean(projectId),
  });
  return {
    items: query.data?.items ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
