/**
 * Projects data hooks — thin wrappers over the generated SDK with the same
 * SSE-first, 60s-safety-net freshness posture as `use-work-items`.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  projectsGetOptions,
  projectsGetQueryKey,
  projectsPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";

export interface ProjectView {
  id: string;
  title: string;
  emoji: string | null;
  color: string | null;
  status: "active" | "archived";
}

export function useProjects(assistantId: string) {
  const query = useQuery({
    ...projectsGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: 60_000,
    staleTime: 20_000,
  });
  const projects: ProjectView[] = (query.data?.projects ?? []).map((p) => ({
    id: p.id,
    title: p.title,
    emoji: p.emoji ?? null,
    color: p.color ?? null,
    status: p.status,
  }));
  return {
    projects,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

export function useCreateProject(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...projectsPostMutation(),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: projectsGetQueryKey({
          path: { assistant_id: assistantId },
        }),
      }),
  });
}
