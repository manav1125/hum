/**
 * Quick-add a task into a project.
 *
 * The daemon has no single "create work item under project X" call — task
 * creation (`tasks/queue/add`) returns an opaque tool-result string, not an id,
 * and it can't set a projectId. So this is a deliberate two-step:
 *
 *   1. create the work item with `tasksQueueAddPost`,
 *   2. re-list work items, find the freshest unfiled item whose title matches,
 *      and PATCH its `projectId` to file it into this project.
 *
 * The match is title + unfiled + newest-createdAt, which is unambiguous for a
 * user-typed quick-add moments after creation. If the lookup misses (rare), the
 * task still exists unfiled and shows up in All-work — nothing is lost.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { tasksQueueAddPostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { workitemsByIdPatch, workitemsGet } from "@/generated/daemon/sdk.gen";

export function useQuickAddTask(assistantId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...tasksQueueAddPostMutation(),
    onSuccess: async (_data, variables) => {
      const title =
        variables && "body" in variables
          ? ((variables.body as { title?: string }).title ?? "")
          : "";
      try {
        // Re-list every work item, then find the freshest unfiled match.
        const res = await workitemsGet({
          path: { assistant_id: assistantId },
        });
        const items = res.data?.items ?? [];
        const candidates = items
          .filter(
            (i) =>
              !i.projectId &&
              typeof i.title === "string" &&
              i.title.trim() === title.trim(),
          )
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        const target = candidates[0];
        if (target) {
          let labels: string[] = [];
          if (target.labels) {
            try {
              const parsed = JSON.parse(target.labels) as unknown;
              if (Array.isArray(parsed))
                labels = parsed.filter(
                  (l): l is string => typeof l === "string",
                );
            } catch {
              // ignore malformed labels
            }
          }
          await workitemsByIdPatch({
            path: { assistant_id: assistantId, id: target.id },
            body: {
              title: target.title,
              notes: target.notes ?? "",
              status: target.status,
              priorityTier: target.priorityTier,
              sortIndex: target.sortIndex ?? 0,
              projectId,
              dueAt: target.dueAt,
              labels,
              assignee: target.assignee ?? "cue",
              context: target.context ?? null,
            },
          });
        }
      } catch {
        // Filing is best-effort; the task exists regardless.
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) &&
          q.queryKey.some(
            (k) =>
              typeof k === "object" &&
              k !== null &&
              "_id" in k &&
              (String((k as { _id?: string })._id).startsWith("projects") ||
                (k as { _id?: string })._id === "workitemsGet"),
          ),
      });
    },
  });
}
