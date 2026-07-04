/**
 * Route handlers for missions (HQ Phase 1) — outcome-oriented goals above
 * projects — plus the single-row company profile and the manual cycle
 * trigger. Mutations publish `tasks_changed` so SSE-driven clients refetch,
 * mirroring the projects routes. Auth is enforced at the transport layer;
 * handlers contain only business logic.
 */

import { z } from "zod";

import type { ServerMessage } from "../../daemon/message-protocol.js";
import { MissionOrchestrator } from "../../missions/mission-orchestrator.js";
import {
  createMission,
  deleteMission,
  getCompanyProfile,
  getMission,
  getMissionWithRollup,
  listMissionEvents,
  listMissionsWithRollups,
  type MissionMode,
  type MissionStatus,
  updateCompanyProfile,
  updateMission,
} from "../../missions/mission-store.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

function publishEvent(msg: ServerMessage): void {
  void assistantEventHub.publish(buildAssistantEvent(msg));
}

const missionModeSchema = z.enum(["observe", "assist", "autonomous"]);

const missionSchema = z.object({
  id: z.string(),
  title: z.string(),
  outcome: z
    .string()
    .describe("The measurable outcome the mission drives toward"),
  metric: z.string().nullable(),
  horizon: z.number().int().nullable().describe("Target date, epoch ms"),
  status: z.enum(["active", "paused", "achieved", "abandoned"]),
  mode: missionModeSchema
    .nullable()
    .describe("Per-mission autonomy override; null = workspace default"),
  brief: z.string().nullable().describe('The mission "why"'),
  cadence: z
    .string()
    .nullable()
    .describe("Cycle cadence: hourly | daily | weekly; null = daily"),
  budgetCents: z.number().int().nullable(),
  spentCents: z.number().int(),
  continuationSummary: z
    .string()
    .nullable()
    .describe("Bounded per-cycle regenerated state doc"),
  pinned: z.number().int().describe("0/1 — pinned missions float to the top"),
  sortIndex: z.number().int().nullable(),
  lastCycleAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const missionRollupSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      emoji: z.string().nullable(),
      status: z.string(),
    }),
  ),
  counts: z.object({
    queued: z.number().int(),
    running: z.number().int(),
    awaiting_review: z.number().int(),
    done: z.number().int(),
    failed: z.number().int(),
    open: z.number().int(),
    total: z.number().int(),
  }),
  spentCents: z.number().int(),
  budgetCents: z.number().int().nullable(),
});

const missionWithRollupSchema = missionSchema.extend({
  rollup: missionRollupSchema,
});

const missionEventSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  kind: z.string(),
  cycleId: z.string().nullable(),
  payload: z.string().nullable().describe("JSON payload, event-kind-specific"),
  at: z.number().int(),
});

const companyProfileSchema = z.object({
  identity: z.string().nullable(),
  direction: z.string().nullable(),
  neverLines: z
    .array(z.string())
    .describe("Hard boundaries the AI may never cross"),
  workspaceMode: missionModeSchema,
  updatedAt: z.number().int().nullable(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listMissions",
    endpoint: "missions",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List missions",
    description:
      "Return missions (pinned-first, then sortIndex, then newest; abandoned excluded unless filtered) with per-mission rollups: linked initiative projects, work-item counts by status, and spend vs budget.",
    tags: ["missions"],
    queryParams: [
      {
        name: "status",
        description: "Mission status filter",
        schema: {
          type: "string",
          enum: ["active", "paused", "achieved", "abandoned"],
        },
      },
    ],
    responseBody: z.object({ missions: z.array(missionWithRollupSchema) }),
    handler: ({ queryParams }) => {
      const status = queryParams?.status as MissionStatus | undefined;
      return {
        missions: listMissionsWithRollups(status ? { status } : undefined),
      };
    },
  },

  {
    operationId: "createMission",
    endpoint: "missions",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Create a mission",
    tags: ["missions"],
    requestBody: z.object({
      title: z.string().min(1),
      outcome: z.string().min(1),
      metric: z.string().optional(),
      horizon: z.number().int().optional(),
      mode: missionModeSchema.optional(),
      brief: z.string().optional(),
      cadence: z.enum(["hourly", "daily", "weekly"]).optional(),
      budgetCents: z.number().int().min(0).optional(),
      pinned: z.boolean().optional(),
      sortIndex: z.number().int().optional(),
    }),
    responseBody: z.object({ mission: missionSchema }),
    handler: ({ body }) => {
      const b = (body ?? {}) as {
        title?: string;
        outcome?: string;
        metric?: string;
        horizon?: number;
        mode?: MissionMode;
        brief?: string;
        cadence?: string;
        budgetCents?: number;
        pinned?: boolean;
        sortIndex?: number;
      };
      const title = typeof b.title === "string" ? b.title.trim() : "";
      if (!title) throw new BadRequestError("title is required");
      const outcome = typeof b.outcome === "string" ? b.outcome.trim() : "";
      if (!outcome) throw new BadRequestError("outcome is required");
      const mission = createMission({
        title,
        outcome,
        ...(typeof b.metric === "string" ? { metric: b.metric } : {}),
        ...(typeof b.horizon === "number" ? { horizon: b.horizon } : {}),
        ...(b.mode ? { mode: b.mode } : {}),
        ...(typeof b.brief === "string" ? { brief: b.brief } : {}),
        ...(typeof b.cadence === "string" ? { cadence: b.cadence } : {}),
        ...(typeof b.budgetCents === "number"
          ? { budgetCents: b.budgetCents }
          : {}),
        ...(typeof b.pinned === "boolean" ? { pinned: b.pinned } : {}),
        ...(typeof b.sortIndex === "number" ? { sortIndex: b.sortIndex } : {}),
      });
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { mission };
    },
  },

  {
    operationId: "getMission",
    endpoint: "missions/:id",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get a mission",
    description: "Return a single mission with its rollup.",
    tags: ["missions"],
    responseBody: z.object({ mission: missionWithRollupSchema }),
    handler: ({ pathParams }) => {
      const mission = getMissionWithRollup(pathParams!.id);
      if (!mission) {
        throw new NotFoundError(`Mission not found: ${pathParams!.id}`);
      }
      return { mission };
    },
  },

  {
    operationId: "updateMission",
    endpoint: "missions/:id",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update a mission",
    description:
      "Edit mission fields, pause/resume, mark achieved/abandoned, adjust mode, cadence, or budget.",
    tags: ["missions"],
    requestBody: z
      .object({
        title: z.string(),
        outcome: z.string(),
        metric: z.string().nullable(),
        horizon: z.number().int().nullable(),
        status: z.enum(["active", "paused", "achieved", "abandoned"]),
        mode: missionModeSchema.nullable(),
        brief: z.string().nullable(),
        cadence: z.enum(["hourly", "daily", "weekly"]).nullable(),
        budgetCents: z.number().int().min(0).nullable(),
        pinned: z.boolean(),
        sortIndex: z.number().int().nullable(),
      })
      .partial(),
    responseBody: z.object({ mission: missionSchema }),
    handler: ({ pathParams, body }) => {
      const id = pathParams!.id;
      if (!getMission(id)) throw new NotFoundError(`Mission not found: ${id}`);
      const raw = (body ?? {}) as {
        title?: string;
        outcome?: string;
        metric?: string | null;
        horizon?: number | null;
        status?: MissionStatus;
        mode?: MissionMode | null;
        brief?: string | null;
        cadence?: string | null;
        budgetCents?: number | null;
        pinned?: boolean;
        sortIndex?: number | null;
      };
      const updates: Parameters<typeof updateMission>[1] = {};
      if (raw.title !== undefined) updates.title = raw.title;
      if (raw.outcome !== undefined) updates.outcome = raw.outcome;
      if (raw.metric !== undefined) updates.metric = raw.metric;
      if (raw.horizon !== undefined) updates.horizon = raw.horizon;
      if (raw.status !== undefined) updates.status = raw.status;
      if (raw.mode !== undefined) updates.mode = raw.mode;
      if (raw.brief !== undefined) updates.brief = raw.brief;
      if (raw.cadence !== undefined) updates.cadence = raw.cadence;
      if (raw.budgetCents !== undefined) updates.budgetCents = raw.budgetCents;
      // The store column is 0/1; accept a boolean at the wire and normalize.
      if (raw.pinned !== undefined) updates.pinned = raw.pinned ? 1 : 0;
      if (raw.sortIndex !== undefined) updates.sortIndex = raw.sortIndex;
      const mission = updateMission(id, updates);
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { mission };
    },
  },

  {
    operationId: "deleteMission",
    endpoint: "missions/:id",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete a mission",
    description:
      "Hard-delete a mission. Linked projects keep living with mission_id cleared; the mission's events and plan fingerprints are removed with it.",
    tags: ["missions"],
    responseBody: z.object({ id: z.string(), success: z.boolean() }),
    handler: ({ pathParams }) => {
      const id = pathParams!.id;
      if (!getMission(id)) throw new NotFoundError(`Mission not found: ${id}`);
      deleteMission(id);
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { id, success: true };
    },
  },

  {
    operationId: "listMissionEvents",
    endpoint: "missions/:id/events",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List a mission's audit-trail events",
    description:
      "Chronological orchestrator events (cycle_started, planned, item_enqueued, checkpoint, budget_stop, reported…) over the most recent window.",
    tags: ["missions"],
    queryParams: [
      {
        name: "limit",
        description: "Max events to return (default 200, cap 1000)",
        schema: { type: "integer" },
      },
    ],
    responseBody: z.object({ events: z.array(missionEventSchema) }),
    handler: ({ pathParams, queryParams }) => {
      const id = pathParams!.id;
      if (!getMission(id)) throw new NotFoundError(`Mission not found: ${id}`);
      const rawLimit = Number(queryParams?.limit);
      const limit = Number.isFinite(rawLimit) ? rawLimit : undefined;
      return {
        events: listMissionEvents(id, limit ? { limit } : undefined),
      };
    },
  },

  {
    operationId: "runMissionCycle",
    endpoint: "missions/:id/run-cycle",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Run a mission orchestrator cycle now",
    description:
      "Manually trigger one assess→plan→execute→report cycle. Bypasses the scheduler and the kill switch (explicit operator action) but never the status or budget guards.",
    tags: ["missions"],
    responseBody: z.object({
      ran: z.boolean(),
      reason: z.string(),
      enqueued: z.number().int(),
      cycleId: z.string().optional(),
    }),
    handler: async ({ pathParams }) => {
      const id = pathParams!.id;
      if (!getMission(id)) throw new NotFoundError(`Mission not found: ${id}`);
      const orchestrator =
        MissionOrchestrator.getInstance() ?? new MissionOrchestrator();
      const result = await orchestrator.runCycle(id, { force: true });
      return {
        ran: result.ran,
        reason: result.reason,
        enqueued: result.enqueued,
        ...(result.cycleId ? { cycleId: result.cycleId } : {}),
      };
    },
  },

  {
    operationId: "getCompanyProfile",
    endpoint: "company-profile",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get the company profile",
    description:
      "The single-row who-we-are record (identity, direction, never-lines, workspace autonomy mode) injected into every mission planning cycle.",
    tags: ["missions"],
    responseBody: z.object({ profile: companyProfileSchema }),
    handler: () => ({ profile: getCompanyProfile() }),
  },

  {
    operationId: "updateCompanyProfile",
    endpoint: "company-profile",
    method: "PUT",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update the company profile",
    description:
      "Partial upsert of the single-row company profile. Omitted fields keep their current value.",
    tags: ["missions"],
    requestBody: z
      .object({
        identity: z.string().nullable(),
        direction: z.string().nullable(),
        neverLines: z.array(z.string()),
        workspaceMode: missionModeSchema,
      })
      .partial(),
    responseBody: z.object({ profile: companyProfileSchema }),
    handler: ({ body }) => {
      const raw = (body ?? {}) as {
        identity?: string | null;
        direction?: string | null;
        neverLines?: unknown;
        workspaceMode?: MissionMode;
      };
      if (
        raw.neverLines !== undefined &&
        (!Array.isArray(raw.neverLines) ||
          !raw.neverLines.every((l) => typeof l === "string"))
      ) {
        throw new BadRequestError("neverLines must be an array of strings");
      }
      const profile = updateCompanyProfile({
        ...(raw.identity !== undefined ? { identity: raw.identity } : {}),
        ...(raw.direction !== undefined ? { direction: raw.direction } : {}),
        ...(raw.neverLines !== undefined
          ? { neverLines: raw.neverLines as string[] }
          : {}),
        ...(raw.workspaceMode !== undefined
          ? { workspaceMode: raw.workspaceMode }
          : {}),
      });
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { profile };
    },
  },
];
