/**
 * Route handler for meeting capture → recap.
 *
 * POST /v1/meetings/recap — turn a meeting transcript into a structured recap
 * (summary, action items, decisions, people + tone) and write what it learns
 * into the 8-type graph memory, tagged by a freshly-created meeting
 * conversation.
 *
 * The heavy lifting lives in `services/meeting-recap.ts`. This module is thin
 * glue: validate the body, call the service, translate service errors to
 * RouteError subclasses, and return the recap.
 */

import { z } from "zod";

import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { generateMeetingRecap } from "../services/meeting-recap.js";
import {
  BadRequestError,
  InternalError,
  ServiceUnavailableError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const recapActionItemSchema = z.object({
  text: z.string(),
  owner: z.string().nullable(),
  done: z.boolean(),
});

const recapPersonSchema = z.object({
  name: z.string(),
  tone: z.string(),
  note: z.string().optional(),
});

const recapWorkItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  created: z.boolean(),
});

const recapResponseSchema = z.object({
  summary: z.string(),
  actionItems: z.array(recapActionItemSchema),
  decisions: z.array(z.string()),
  people: z.array(recapPersonSchema),
  tone: z.string(),
  conversationId: z.string(),
  memoryNodeIds: z.array(z.string()),
  workItems: z.array(recapWorkItemSchema),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleMeetingRecap({ body = {} }: RouteHandlerArgs) {
  const transcript = body.transcript;
  if (typeof transcript !== "string" || transcript.trim().length === 0) {
    throw new BadRequestError("A non-empty transcript is required");
  }
  const title =
    typeof body.title === "string" && body.title.length > 0
      ? body.title
      : undefined;

  const result = await generateMeetingRecap(transcript, { title });

  if ("error" in result) {
    const { kind, message } = result.error;
    if (kind === "BAD_REQUEST") throw new BadRequestError(message);
    if (kind === "PROVIDER_UNAVAILABLE") {
      throw new ServiceUnavailableError(message);
    }
    // RECAP_FAILED and anything else → surface as an upstream/internal error.
    throw new InternalError(message);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Transport-agnostic route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "meeting_recap",
    endpoint: "meetings/recap",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Generate a meeting recap",
    description:
      "Turn a meeting transcript into a structured recap (summary, action items, decisions, people and tone) and write the results into memory, tagged by a new meeting conversation.",
    tags: ["meetings"],
    requestBody: z.object({
      transcript: z
        .string()
        .describe("The full meeting transcript to summarize."),
      title: z
        .string()
        .optional()
        .describe("Optional title for the meeting conversation."),
    }),
    responseBody: recapResponseSchema,
    handler: handleMeetingRecap,
  },
];
