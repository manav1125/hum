/**
 * Route handlers for projects — named containers that group work items.
 *
 * CRUD plus a per-project work-item listing. Mutations publish
 * `tasks_changed` so SSE-driven clients refetch, mirroring the work-items
 * routes. Auth is enforced at the transport layer; handlers contain only
 * business logic.
 */

import { z } from "zod";

import type { ServerMessage } from "../../daemon/message-protocol.js";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  type ProjectStatus,
  updateProject,
} from "../../work-items/project-store.js";
import {
  listWorkItems,
  type WorkItemStatus,
} from "../../work-items/work-item-store.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";
import { workItemSchema } from "./work-items-routes.js";

function publishEvent(msg: ServerMessage): void {
  void assistantEventHub.publish(buildAssistantEvent(msg));
}

const projectSchema = z.object({
  id: z.string(),
  title: z.string(),
  emoji: z.string().nullable(),
  color: z.string().nullable(),
  status: z.enum(["active", "archived"]),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listProjects",
    endpoint: "projects",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List projects",
    description: "Return projects, filtered by status (default active).",
    tags: ["projects"],
    queryParams: [
      {
        name: "status",
        description: "Project status filter",
        schema: { type: "string", enum: ["active", "archived"] },
      },
    ],
    responseBody: z.object({ projects: z.array(projectSchema) }),
    handler: ({ queryParams }) => {
      const status = queryParams?.status as ProjectStatus | undefined;
      return { projects: listProjects(status ? { status } : undefined) };
    },
  },

  {
    operationId: "createProject",
    endpoint: "projects",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Create a project",
    tags: ["projects"],
    requestBody: z.object({
      title: z.string().min(1),
      emoji: z.string().optional(),
      color: z.string().optional(),
    }),
    responseBody: z.object({ project: projectSchema }),
    handler: ({ body }) => {
      const title = typeof body?.title === "string" ? body.title.trim() : "";
      if (!title) throw new BadRequestError("title is required");
      const project = createProject({
        title,
        ...(typeof body?.emoji === "string" ? { emoji: body.emoji } : {}),
        ...(typeof body?.color === "string" ? { color: body.color } : {}),
      });
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { project };
    },
  },

  {
    operationId: "getProject",
    endpoint: "projects/:id",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get a project",
    tags: ["projects"],
    responseBody: z.object({ project: projectSchema }),
    handler: ({ pathParams }) => {
      const project = getProject(pathParams!.id);
      if (!project) {
        throw new NotFoundError(`Project not found: ${pathParams!.id}`);
      }
      return { project };
    },
  },

  {
    operationId: "updateProject",
    endpoint: "projects/:id",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update a project",
    description: "Rename, restyle, or archive/unarchive a project.",
    tags: ["projects"],
    requestBody: z
      .object({
        title: z.string(),
        emoji: z.string().nullable(),
        color: z.string().nullable(),
        status: z.enum(["active", "archived"]),
      })
      .partial(),
    responseBody: z.object({ project: projectSchema }),
    handler: ({ pathParams, body }) => {
      const id = pathParams!.id;
      if (!getProject(id)) throw new NotFoundError(`Project not found: ${id}`);
      const raw = (body ?? {}) as {
        title?: string;
        emoji?: string | null;
        color?: string | null;
        status?: ProjectStatus;
      };
      const updates: Parameters<typeof updateProject>[1] = {};
      if (raw.title !== undefined) updates.title = raw.title;
      if (raw.emoji !== undefined) updates.emoji = raw.emoji;
      if (raw.color !== undefined) updates.color = raw.color;
      if (raw.status !== undefined) updates.status = raw.status;
      const project = updateProject(id, updates);
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { project };
    },
  },

  {
    operationId: "deleteProject",
    endpoint: "projects/:id",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete a project",
    description:
      "Hard-delete a project. Its work items keep living with project_id cleared.",
    tags: ["projects"],
    responseBody: z.object({ id: z.string(), success: z.boolean() }),
    handler: ({ pathParams }) => {
      const id = pathParams!.id;
      if (!getProject(id)) throw new NotFoundError(`Project not found: ${id}`);
      deleteProject(id);
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { id, success: true };
    },
  },

  {
    operationId: "listProjectWorkItems",
    endpoint: "projects/:id/work-items",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List a project's work items",
    tags: ["projects"],
    queryParams: [
      {
        name: "status",
        description: "Filter by work item status",
        schema: {
          type: "string",
          enum: [
            "pending",
            "running",
            "awaiting_review",
            "done",
            "failed",
            "cancelled",
            "archived",
          ],
        },
      },
    ],
    responseBody: z.object({ items: z.array(workItemSchema) }),
    handler: ({ pathParams, queryParams }) => {
      const id = pathParams!.id;
      if (!getProject(id)) throw new NotFoundError(`Project not found: ${id}`);
      const status = queryParams?.status ?? undefined;
      // Same "pending" → "queued" alias as listWorkItems (the public API
      // exposes pending; the store column only ever holds queued).
      const resolvedStatus: WorkItemStatus | undefined =
        status === "pending"
          ? "queued"
          : (status as WorkItemStatus | undefined);
      const items = listWorkItems({
        projectId: id,
        ...(resolvedStatus ? { status: resolvedStatus } : {}),
      });
      return { items };
    },
  },
];
