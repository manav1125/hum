/**
 * Route handler for voice intake → working thread.
 *
 * POST /v1/voice-intake — turn a dictated transcript into a real conversation:
 * a read-back summary + the action items the user spoke (listed as the first
 * assistant message) and an executable work item per open action item. The
 * client navigates the user straight into the returned `conversationId`.
 *
 * The heavy lifting lives in `services/voice-intake.ts`. This module is thin
 * glue: validate the body, call the service, map service errors to RouteError
 * subclasses, and return the intake.
 */

import { z } from "zod";

import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { generateVoiceIntake } from "../services/voice-intake.js";
import { BadRequestError, InternalError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const actionItemSchema = z.object({
  text: z.string(),
  owner: z.string().nullable(),
  done: z.boolean(),
});

const workItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  created: z.boolean(),
  // Filing resolved by triage: the project (and, via project.missionId, the
  // mission) this item was filed onto, or null when triage wasn't confident.
  // Lets the client show the real ⟡ project/mission tag instead of a placeholder.
  projectId: z.string().nullable(),
  projectTitle: z.string().nullable(),
  missionId: z.string().nullable(),
  missionTitle: z.string().nullable(),
});

const voiceIntakeResponseSchema = z.object({
  conversationId: z.string(),
  summary: z.string(),
  actionItems: z.array(actionItemSchema),
  workItems: z.array(workItemSchema),
});

async function handleVoiceIntake({ body = {} }: RouteHandlerArgs) {
  const transcript = body.transcript;
  if (typeof transcript !== "string" || transcript.trim().length === 0) {
    throw new BadRequestError("A non-empty transcript is required");
  }

  const result = await generateVoiceIntake(transcript);

  if ("error" in result) {
    const { kind, message } = result.error;
    if (kind === "BAD_REQUEST") throw new BadRequestError(message);
    throw new InternalError(message);
  }

  return result;
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "voice_intake",
    endpoint: "voice-intake",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Turn a voice transcript into a working thread",
    description:
      "Create a conversation from a dictated transcript: a read-back summary plus the spoken action items (listed as the first assistant message) and an executable work item per open action item. Returns the conversation id to navigate into.",
    tags: ["voice"],
    requestBody: z.object({
      transcript: z
        .string()
        .describe("The dictated transcript to turn into a working thread."),
    }),
    responseBody: voiceIntakeResponseSchema,
    handler: handleVoiceIntake,
  },
];
