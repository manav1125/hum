/**
 * Cue Live observation-capture routes — the consent surface and the ingest
 * seam for turning what Cue sees on screen into captured work.
 *
 * Three things a client needs, and nothing more:
 *
 * - **Start / stop** an explicit, expiring capture session. Watching is never
 *   implicit: the config switch alone captures nothing, and a session always
 *   carries an expiry (see `cue-live/observation-capture.ts`).
 * - **Inspect** what a session has taken, so the user can see exactly which
 *   tasks Cue lifted off their screen and why. Every captured item is a
 *   normal work item, so the existing dismiss/cancel/archive machinery on the
 *   work-item routes is how one gets thrown away — no bespoke undo here.
 * - **Submit** one observation. A push seam, for an observer that has a frame
 *   or a description already: it posts, the daemon gates it, extracts, and
 *   files. The frame is passed to the model and dropped — the daemon never
 *   persists screen bytes.
 *
 * The routine path is a PULL, not this push: starting a session also starts
 * the observation driver, which asks the connected desktop for one look per
 * tick over the `host_observe` capability. The cadence and the gate both live
 * in the daemon, so the desktop only answers "what is on screen" and never
 * decides when watching happens or whether a look may be used.
 */
import { z } from "zod";

import {
  getObservationCaptureSessionView,
  startObservationCaptureSession,
  stopObservationCaptureSession,
  submitScreenObservation,
} from "../../cue-live/observation-capture.js";
import { ensureObservationDriverStarted } from "../../cue-live/observation-driver-lifecycle.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const CaptureRecord = z.object({
  workItemId: z.string(),
  title: z.string(),
  at: z.string(),
  atLocal: z.string(),
  appName: z.string().nullable(),
  evidence: z.string(),
});

const SessionView = z.object({
  enabled: z.boolean(),
  armed: z.boolean(),
  sessionId: z.string().nullable(),
  startedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  secondsRemaining: z.number(),
  extractionsUsed: z.number(),
  extractionsRemaining: z.number(),
  itemsFiled: z.number(),
  itemsRemaining: z.number(),
  captures: z.array(CaptureRecord),
});
type SessionViewT = z.infer<typeof SessionView>;

const StartBody = z.object({
  durationMinutes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "How long to watch for. Clamped to cueLive.observationCapture.sessionMaxMinutes; omitted means that maximum. There is no unbounded option.",
    ),
});

const ObservationBody = z.object({
  description: z
    .string()
    .optional()
    .describe(
      "Text description of what is on screen (a Cue Live look answer, OCR, or an accessibility summary). Preferred — the cheapest extraction path.",
    ),
  imageBase64: z
    .string()
    .optional()
    .describe(
      "Raw frame, base64-encoded (no data URI). Passed to the vision model and dropped; never persisted.",
    ),
  mediaType: z.string().optional().describe("MIME type of the frame"),
  appName: z.string().optional().describe("Frontmost application name"),
});

const ObservationResult = z.object({
  status: z.enum(["captured", "skipped", "error"]),
  reason: z.string().optional(),
  createdWorkItemIds: z.array(z.string()),
  session: SessionView,
});

function handleGetSession(): SessionViewT {
  return getObservationCaptureSessionView();
}

function handleStart({ body }: RouteHandlerArgs): SessionViewT {
  const parsed = StartBody.safeParse(body ?? {});
  if (!parsed.success) {
    throw new BadRequestError(
      "Invalid Cue Live observation-capture start request body",
    );
  }
  const view = startObservationCaptureSession({
    ...(parsed.data.durationMinutes != null
      ? { durationMinutes: parsed.data.durationMinutes }
      : {}),
  });
  // Only after the session is actually armed. Starting the loop first would
  // create a timer for a start request that turned out to be rejected.
  if (view.armed) ensureObservationDriverStarted();
  return view;
}

function handleStop(): SessionViewT {
  return stopObservationCaptureSession();
}

async function handleObservation({
  body,
}: RouteHandlerArgs): Promise<z.infer<typeof ObservationResult>> {
  const parsed = ObservationBody.safeParse(body ?? {});
  if (!parsed.success) {
    throw new BadRequestError("Invalid Cue Live observation request body");
  }
  const result = await submitScreenObservation(parsed.data);
  return {
    status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
    createdWorkItemIds: result.createdWorkItemIds,
    session: result.session,
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "cuelive_observation_session",
    endpoint: "cuelive/observation/session",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleGetSession,
    summary: "Whether Cue is capturing tasks from the screen, and what it took",
    description:
      "The consent view: the config switch, whether a capture session is " +
      "armed, when it expires, how much of its extraction/item budget is " +
      "left, and every task it has captured (with the on-screen evidence). " +
      "Captured items are ordinary work items — dismiss them through the " +
      "work-item routes.",
    tags: ["cuelive"],
    responseBody: SessionView,
    logging: { silenceSuccessAfter: 5 },
  },
  {
    operationId: "cuelive_observation_session_start",
    endpoint: "cuelive/observation/session/start",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleStart,
    summary: "Start a time-bounded screen-observation capture session",
    description:
      "Opt in to Cue capturing tasks from the screen for a bounded period. " +
      "The duration is clamped to the configured maximum and always expires " +
      "on its own. Returns { armed: false } when " +
      "cueLive.observationCapture.enabled is off, so the client can say why.",
    tags: ["cuelive"],
    requestBody: StartBody,
    responseBody: SessionView,
  },
  {
    operationId: "cuelive_observation_session_stop",
    endpoint: "cuelive/observation/session/stop",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleStop,
    summary: "Stop capturing tasks from the screen now",
    description:
      "Disarms the capture session immediately. Idempotent. Already-captured " +
      "work items are left alone — they are parked in the queue for review.",
    tags: ["cuelive"],
    responseBody: SessionView,
  },
  {
    operationId: "cuelive_observation",
    endpoint: "cuelive/observation",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleObservation,
    summary: "Submit one screen observation for task capture",
    description:
      "Ingest seam for a screen observer (the macOS Cue Live capture loop). " +
      "Gated by the armed session, an interval floor, a change fingerprint, a " +
      "sensitive-screen heuristic, and per-session extraction/item caps — " +
      "most observations return `skipped` with the reason and cost nothing. " +
      "Captured tasks land PARKED in the queue and never auto-run. Frames are " +
      "never persisted.",
    tags: ["cuelive"],
    requestBody: ObservationBody,
    responseBody: ObservationResult,
  },
];
