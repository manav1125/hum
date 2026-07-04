/**
 * Route handlers for work outputs ("Sprint outputs") — the deliverables
 * registry captured from completed work-item runs. Powers the artifact cards
 * on Mission detail (GET missions/:id/outputs), work-item detail
 * (GET work-items/:id/outputs), and the daily brief (GET outputs), plus the
 * card's Approve action (PATCH outputs/:id). Mutations publish `tasks_changed`
 * so SSE-driven clients refetch, mirroring the missions routes. Auth is
 * enforced at the transport layer; handlers contain only business logic.
 */

import { z } from "zod";

import type { ServerMessage } from "../../daemon/message-protocol.js";
import { getMission } from "../../missions/mission-store.js";
import { getWorkItem } from "../../work-items/work-item-store.js";
import {
  enrichOutputsWithAttachments,
  getWorkOutput,
  listMissionOutputs,
  listRecentOutputs,
  listWorkItemOutputs,
  setWorkOutputReviewState,
  type WorkOutputReviewState,
} from "../../work-items/work-output-store.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

function publishEvent(msg: ServerMessage): void {
  void assistantEventHub.publish(buildAssistantEvent(msg));
}

const workOutputSchema = z.object({
  id: z.string(),
  workItemId: z.string(),
  missionId: z
    .string()
    .nullable()
    .describe("Denormalized at capture from the work item's project"),
  projectId: z.string().nullable(),
  attachmentId: z
    .string()
    .nullable()
    .describe("Set for file-backed outputs; bytes via the attachment routes"),
  externalUrl: z
    .string()
    .nullable()
    .describe("Set for link-backed outputs (deployed site, shared doc…)"),
  kind: z.enum([
    "document",
    "deck",
    "spreadsheet",
    "pdf",
    "image",
    "video",
    "other",
  ]),
  title: z.string(),
  why: z
    .string()
    .nullable()
    .describe('One-line "why it exists" purpose shown on the card'),
  agent: z
    .string()
    .nullable()
    .describe('The assignee that produced it; null reads as "cue"'),
  reviewState: z.enum(["pending", "approved"]),
  createdAt: z.number().int(),
  attachment: z
    .object({
      id: z.string(),
      filename: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int(),
      hasThumbnail: z
        .boolean()
        .describe("True when a stored thumbnail exists (videos)"),
    })
    .nullable()
    .describe(
      "Render metadata for file-backed outputs: images/PDFs render client-side from the attachment content route; other kinds get kind icons",
    ),
});

const outputsResponseSchema = z.object({
  outputs: z.array(workOutputSchema),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listMissionOutputs",
    endpoint: "missions/:id/outputs",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List a mission's sprint outputs",
    description:
      "Deliverables produced by work-item runs across the mission's initiative projects, newest first — the Mission-detail artifact cards.",
    tags: ["outputs"],
    responseBody: outputsResponseSchema,
    handler: ({ pathParams }) => {
      const id = pathParams!.id;
      if (!getMission(id)) throw new NotFoundError(`Mission not found: ${id}`);
      return { outputs: enrichOutputsWithAttachments(listMissionOutputs(id)) };
    },
  },

  {
    operationId: "listWorkItemOutputs",
    endpoint: "work-items/:id/outputs",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List a work item's outputs",
    description:
      "Deliverables registered from the work item's completed runs, newest first.",
    tags: ["outputs"],
    responseBody: outputsResponseSchema,
    handler: ({ pathParams }) => {
      const id = pathParams!.id;
      if (!getWorkItem(id)) {
        throw new NotFoundError(`Work item not found: ${id}`);
      }
      return { outputs: enrichOutputsWithAttachments(listWorkItemOutputs(id)) };
    },
  },

  {
    operationId: "listRecentOutputs",
    endpoint: "outputs",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List recent outputs across all work",
    description:
      'Newest-first deliverables across every mission and project — the daily brief\'s "Cue made these" rail.',
    tags: ["outputs"],
    queryParams: [
      {
        name: "limit",
        description: "Max outputs to return (default 50, cap 200)",
        schema: { type: "integer" },
      },
    ],
    responseBody: outputsResponseSchema,
    handler: ({ queryParams }) => {
      const rawLimit = Number(queryParams?.limit);
      const limit = Number.isFinite(rawLimit) ? rawLimit : undefined;
      return {
        outputs: enrichOutputsWithAttachments(
          listRecentOutputs(limit ? { limit } : undefined),
        ),
      };
    },
  },

  {
    operationId: "updateOutput",
    endpoint: "outputs/:id",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update an output's review state",
    description:
      "The artifact card's Approve action: flip reviewState to approved (or back to pending).",
    tags: ["outputs"],
    requestBody: z.object({
      reviewState: z.enum(["pending", "approved"]),
    }),
    responseBody: z.object({ output: workOutputSchema }),
    handler: ({ pathParams, body }) => {
      const id = pathParams!.id;
      if (!getWorkOutput(id)) {
        throw new NotFoundError(`Output not found: ${id}`);
      }
      const reviewState = (body as { reviewState?: unknown } | undefined)
        ?.reviewState;
      if (reviewState !== "pending" && reviewState !== "approved") {
        throw new BadRequestError(
          'reviewState must be "pending" or "approved"',
        );
      }
      const output = setWorkOutputReviewState(
        id,
        reviewState as WorkOutputReviewState,
      )!;
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { output: enrichOutputsWithAttachments([output])[0] };
    },
  },
];
