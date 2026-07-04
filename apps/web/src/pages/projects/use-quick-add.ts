/**
 * Quick-add a task into a project.
 *
 * One call: `POST work-items` with `{ title, projectId }`. The daemon creates
 * the work item (status queued, manual source context), files it into the
 * project, and triages it without auto-running.
 *
 * This replaced a create→find→patch dance through `tasks/queue/add` — a
 * LOCAL_PRINCIPALS-only route, so web clients (actor principals) got a 403
 * that the mutation swallowed: the input cleared, and no task was ever
 * created. Failures now surface through `isError` so the board can show an
 * inline error instead of silently dropping the task.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { workitemsPostMutation } from "@/generated/daemon/@tanstack/react-query.gen";

export function useQuickAddTask(assistantId: string, projectId: string) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    ...workitemsPostMutation(),
    onSuccess: () => {
      // Refresh the board (per-project work items) + project stats cards.
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

  return {
    /** Create a task titled `title` filed into this project. */
    add: (title: string, callbacks?: { onSuccess?: () => void }) => {
      mutation.mutate(
        {
          path: { assistant_id: assistantId },
          body: { title, projectId },
        },
        callbacks,
      );
    },
    isPending: mutation.isPending,
    isError: mutation.isError,
    /** Clear a shown error (e.g. when the user dismisses the input). */
    reset: mutation.reset,
  };
}
