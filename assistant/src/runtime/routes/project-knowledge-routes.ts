/**
 * Route handlers for project knowledge — Claude-Projects-style reference
 * material (file attachments + links) attached to a cowork project so every
 * task run in that project has it available.
 *
 * File uploads go through the existing attachment upload route first
 * (POST /attachments), then get linked here by attachmentId. The work-item
 * runner materializes linked files into the agent's sandbox at run time —
 * see work-items/project-knowledge-store.ts.
 *
 * Mutations publish `tasks_changed` so SSE-driven clients refetch, mirroring
 * the projects routes. Auth is enforced at the transport layer.
 */

import { z } from "zod";

import type { ServerMessage } from "../../daemon/message-protocol.js";
import {
  addProjectFileKnowledge,
  addProjectLinkKnowledge,
  listProjectKnowledge,
  removeProjectKnowledge,
} from "../../work-items/project-knowledge-store.js";
import { getProject } from "../../work-items/project-store.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

function publishEvent(msg: ServerMessage): void {
  void assistantEventHub.publish(buildAssistantEvent(msg));
}

const knowledgeItemSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(["file", "link"]),
  attachmentId: z
    .string()
    .nullable()
    .describe("Set for kind='file' — the linked attachments row"),
  url: z.string().nullable().describe("Set for kind='link'"),
  label: z.string().nullable(),
  filename: z.string().nullable().describe("Original filename for kind='file'"),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  addedAt: z.number().int(),
});

function requireProject(id: string): void {
  if (!getProject(id)) throw new NotFoundError(`Project not found: ${id}`);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listProjectKnowledge",
    endpoint: "projects/:id/knowledge",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List a project's knowledge",
    description:
      "Return the project's attached knowledge — uploaded files and reference links — that the agent reads when working any task in the project.",
    tags: ["projects"],
    responseBody: z.object({ items: z.array(knowledgeItemSchema) }),
    handler: ({ pathParams }) => {
      const id = pathParams!.id;
      requireProject(id);
      return { items: listProjectKnowledge(id) };
    },
  },

  {
    operationId: "addProjectKnowledge",
    endpoint: "projects/:id/knowledge",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Attach knowledge to a project",
    description:
      "Attach either an uploaded file (pass `attachmentId` from POST /attachments) or a reference link (pass `url`) to a project. Exactly one of the two must be provided. Attached files are materialized into the agent's workspace so task runs in the project can read them.",
    tags: ["projects"],
    requestBody: z.object({
      attachmentId: z
        .string()
        .optional()
        .describe("Attachment id from the upload route (kind='file')"),
      url: z.string().optional().describe("http(s) URL (kind='link')"),
      label: z
        .string()
        .optional()
        .describe("Display name; defaults to the filename/URL"),
    }),
    responseBody: z.object({ item: knowledgeItemSchema }),
    handler: ({ pathParams, body }) => {
      const projectId = pathParams!.id;
      requireProject(projectId);

      const { attachmentId, url, label } = (body ?? {}) as {
        attachmentId?: string;
        url?: string;
        label?: string;
      };
      const hasAttachment =
        typeof attachmentId === "string" && attachmentId.trim().length > 0;
      const hasUrl = typeof url === "string" && url.trim().length > 0;
      if (hasAttachment === hasUrl) {
        throw new BadRequestError(
          "Provide exactly one of attachmentId (file) or url (link)",
        );
      }

      let item;
      if (hasAttachment) {
        try {
          item = addProjectFileKnowledge({
            projectId,
            attachmentId: attachmentId!.trim(),
            ...(typeof label === "string" ? { label } : {}),
          });
        } catch (err) {
          throw new BadRequestError(
            err instanceof Error ? err.message : String(err),
          );
        }
      } else {
        const trimmedUrl = url!.trim();
        if (!isHttpUrl(trimmedUrl)) {
          throw new BadRequestError("url must be a valid http(s) URL");
        }
        item = addProjectLinkKnowledge({
          projectId,
          url: trimmedUrl,
          ...(typeof label === "string" ? { label } : {}),
        });
      }

      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { item };
    },
  },

  {
    operationId: "deleteProjectKnowledge",
    endpoint: "projects/:id/knowledge/:knowledgeId",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Remove knowledge from a project",
    description:
      "Detach a knowledge entry. For files this also removes the materialized workspace copy and best-effort deletes the underlying attachment.",
    tags: ["projects"],
    responseBody: z.object({ id: z.string(), success: z.boolean() }),
    handler: ({ pathParams }) => {
      const projectId = pathParams!.id;
      const knowledgeId = pathParams!.knowledgeId;
      requireProject(projectId);
      const result = removeProjectKnowledge(projectId, knowledgeId);
      if (result === "not_found") {
        throw new NotFoundError(`Knowledge entry not found: ${knowledgeId}`);
      }
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { id: knowledgeId, success: true };
    },
  },
];
