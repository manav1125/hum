/**
 * Project-knowledge data hooks — the Claude-Projects-style knowledge attached
 * to a cowork project (uploaded files + reference links) that Cue reads when
 * working any task filed there.
 *
 * File uploads are two-step against the daemon: POST /attachments (multipart)
 * to stage the bytes, then POST /projects/:id/knowledge with the returned
 * attachmentId to link it. `useUploadKnowledgeFiles` wraps both so the UI sees
 * one mutation per file batch.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  projectsByIdKnowledgeByKnowledgeIdDeleteMutation,
  projectsByIdKnowledgeGetOptions,
  projectsByIdKnowledgeGetQueryKey,
  projectsByIdKnowledgePostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  attachmentsPost,
  projectsByIdKnowledgePost,
} from "@/generated/daemon/sdk.gen";
import type { ProjectsByIdKnowledgeGetResponses } from "@/generated/daemon/types.gen";

export type ProjectKnowledgeItem =
  ProjectsByIdKnowledgeGetResponses[200]["items"][number];

export function useProjectKnowledge(assistantId: string, projectId: string) {
  const query = useQuery({
    ...projectsByIdKnowledgeGetOptions({
      path: { assistant_id: assistantId, id: projectId },
    }),
    staleTime: 20_000,
    enabled: Boolean(projectId),
  });
  return {
    items: query.data?.items ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

function invalidateKnowledge(
  queryClient: ReturnType<typeof useQueryClient>,
  assistantId: string,
  projectId: string,
) {
  return queryClient.invalidateQueries({
    queryKey: projectsByIdKnowledgeGetQueryKey({
      path: { assistant_id: assistantId, id: projectId },
    }),
  });
}

/** Attach a link (or an already-uploaded attachment) to the project. */
export function useAddProjectKnowledge(assistantId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...projectsByIdKnowledgePostMutation(),
    onSettled: () =>
      void invalidateKnowledge(queryClient, assistantId, projectId),
  });
}

export function useRemoveProjectKnowledge(
  assistantId: string,
  projectId: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    ...projectsByIdKnowledgeByKnowledgeIdDeleteMutation(),
    onSettled: () =>
      void invalidateKnowledge(queryClient, assistantId, projectId),
  });
}

/**
 * Upload one or more picked files and link each into the project's knowledge.
 * Files upload sequentially; the first failure aborts the rest so the user
 * gets a clean error instead of a half-applied batch.
 */
export function useUploadKnowledgeFiles(
  assistantId: string,
  projectId: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        const uploaded = await attachmentsPost({
          path: { assistant_id: assistantId },
          body: {
            file,
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
          },
          throwOnError: true,
        });
        await projectsByIdKnowledgePost({
          path: { assistant_id: assistantId, id: projectId },
          body: { attachmentId: uploaded.data.id },
          throwOnError: true,
        });
      }
    },
    onSettled: () =>
      void invalidateKnowledge(queryClient, assistantId, projectId),
  });
}
