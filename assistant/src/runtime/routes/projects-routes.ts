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
  listProjectsWithStats,
  type ProjectStatus,
  reorderProjects,
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
import { annotateWorkItems, workItemSchema } from "./work-items-routes.js";

function publishEvent(msg: ServerMessage): void {
  void assistantEventHub.publish(buildAssistantEvent(msg));
}

const projectSchema = z.object({
  id: z.string(),
  title: z.string(),
  emoji: z.string().nullable(),
  color: z.string().nullable(),
  status: z.enum(["active", "archived"]),
  category: z.string().nullable(),
  context: z
    .string()
    .nullable()
    .describe("Project brief the agent reads for every task in this project"),
  sortIndex: z.number().int().nullable(),
  pinned: z.number().int().describe("0/1 — pinned projects float to the top"),
  missionId: z
    .string()
    .nullable()
    .describe("Mission this project serves as an initiative of"),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const projectStatsSchema = z.object({
  counts: z.object({
    queued: z.number().int(),
    running: z.number().int(),
    awaiting_review: z.number().int(),
    done: z.number().int(),
    open: z.number().int(),
    total: z.number().int(),
  }),
  nextTask: z
    .object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      dueAt: z.number().int().nullable(),
      priorityTier: z.number().int(),
    })
    .nullable()
    .describe("The single most-urgent next actionable task, or null"),
});

const projectWithStatsSchema = projectSchema.extend({
  stats: projectStatsSchema,
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
    description:
      "Return projects (ordered pinned-first, then sortIndex, then newest) with per-project stats: counts of queued/running/awaiting_review/done and the single most-urgent next task.",
    tags: ["projects"],
    queryParams: [
      {
        name: "status",
        description: "Project status filter",
        schema: { type: "string", enum: ["active", "archived"] },
      },
    ],
    responseBody: z.object({ projects: z.array(projectWithStatsSchema) }),
    handler: ({ queryParams }) => {
      const status = queryParams?.status as ProjectStatus | undefined;
      return {
        projects: listProjectsWithStats(status ? { status } : undefined),
      };
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
      category: z.string().optional(),
      context: z.string().optional(),
      sortIndex: z.number().int().optional(),
      pinned: z.boolean().optional(),
    }),
    responseBody: z.object({ project: projectSchema }),
    handler: ({ body }) => {
      const title = typeof body?.title === "string" ? body.title.trim() : "";
      if (!title) throw new BadRequestError("title is required");
      const b = (body ?? {}) as {
        emoji?: string;
        color?: string;
        category?: string;
        context?: string;
        sortIndex?: number;
        pinned?: boolean;
      };
      const project = createProject({
        title,
        ...(typeof b.emoji === "string" ? { emoji: b.emoji } : {}),
        ...(typeof b.color === "string" ? { color: b.color } : {}),
        ...(typeof b.category === "string" ? { category: b.category } : {}),
        ...(typeof b.context === "string" ? { context: b.context } : {}),
        ...(typeof b.sortIndex === "number" ? { sortIndex: b.sortIndex } : {}),
        ...(typeof b.pinned === "boolean" ? { pinned: b.pinned } : {}),
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
        category: z.string().nullable(),
        context: z.string().nullable(),
        sortIndex: z.number().int().nullable(),
        pinned: z.boolean(),
        missionId: z
          .string()
          .nullable()
          .describe("Link/unlink this project as a mission initiative"),
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
        category?: string | null;
        context?: string | null;
        sortIndex?: number | null;
        pinned?: boolean;
        missionId?: string | null;
      };
      const updates: Parameters<typeof updateProject>[1] = {};
      if (raw.title !== undefined) updates.title = raw.title;
      if (raw.emoji !== undefined) updates.emoji = raw.emoji;
      if (raw.color !== undefined) updates.color = raw.color;
      if (raw.status !== undefined) updates.status = raw.status;
      if (raw.missionId !== undefined) updates.missionId = raw.missionId;
      if (raw.category !== undefined) updates.category = raw.category;
      if (raw.context !== undefined) updates.context = raw.context;
      if (raw.sortIndex !== undefined) updates.sortIndex = raw.sortIndex;
      // The store column is 0/1; accept a boolean at the wire and normalize.
      if (raw.pinned !== undefined) updates.pinned = raw.pinned ? 1 : 0;
      const project = updateProject(id, updates);
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { project };
    },
  },

  {
    operationId: "reorderProjects",
    endpoint: "projects/reorder",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Reorder projects",
    description:
      "Persist a new top-to-bottom project order. `orderedIds` is the desired order; each project's sortIndex is set to its position.",
    tags: ["projects"],
    requestBody: z.object({
      orderedIds: z
        .array(z.string())
        .describe("Project ids in the desired top-to-bottom order"),
    }),
    responseBody: z.object({ success: z.boolean() }),
    handler: ({ body }) => {
      const orderedIds = (body as { orderedIds?: unknown })?.orderedIds;
      if (
        !Array.isArray(orderedIds) ||
        !orderedIds.every((x) => typeof x === "string")
      ) {
        throw new BadRequestError("orderedIds must be an array of strings");
      }
      reorderProjects(orderedIds as string[]);
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { success: true };
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
      return { items: annotateWorkItems(items) };
    },
  },
];
