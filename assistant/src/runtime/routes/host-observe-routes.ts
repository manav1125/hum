/**
 * Route handler for host observation result submissions.
 *
 * The desktop answers one `host_observe_request` here. Unlike app-control and
 * CU, the observe proxy is a process singleton rather than per-conversation —
 * a capture session is not a conversation and has no agent turn behind it — so
 * the payload goes straight to {@link HostObserveProxy.instance} instead of
 * being routed through a conversation lookup.
 *
 * Late-delivery tolerance: returns 200 when no pending interaction matches.
 * The driver has already moved on by then (its own timeout is the deadline),
 * and there is no consumer left to fail loudly to.
 *
 * ## What this route will not accept
 *
 * A result carrying no `description` and no `imageBase64` is rejected rather
 * than forwarded. An empty observation is not the same as an empty screen: the
 * capture seam downstream is entitled to treat a description it receives as
 * what the person was actually looking at, and forwarding nothing as though it
 * were something would spend an extraction asserting the screen was blank.
 */
import { z } from "zod";

import { HostObserveProxy } from "../../daemon/host-observe-proxy.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  enforceSameActorOrThrow,
  SAME_ACTOR_FORBIDDEN_DESCRIPTION,
} from "../auth/same-actor.js";
import { resolveActorPrincipalIdForLocalGuardian } from "../local-actor-identity.js";
import * as pendingInteractions from "../pending-interactions.js";
import { BadRequestError, ForbiddenError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// POST /v1/host-observe-result
// ---------------------------------------------------------------------------

function handleHostObserveResult({ body, headers }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const { requestId, description, imageBase64, mediaType, appName } = body as {
    requestId?: string;
    description?: string;
    imageBase64?: string;
    mediaType?: string;
    appName?: string;
  };

  if (!requestId || typeof requestId !== "string") {
    throw new BadRequestError("requestId is required");
  }

  const peeked = pendingInteractions.get(requestId);
  if (!peeked || peeked.kind !== "host_observe") {
    return { accepted: true };
  }

  // Same-actor binding, identical to the other host result routes: only the
  // client that was asked may answer, and only under the actor principal that
  // was captured when it opened its stream.
  if (peeked.targetClientId != null) {
    const headerMap = headers ?? {};
    const submittingClientId =
      headerMap["x-vellum-client-id"]?.trim() || undefined;
    if (!submittingClientId) {
      throw new BadRequestError(
        "x-vellum-client-id header is missing for a targeted host observe request.",
      );
    }
    if (submittingClientId !== peeked.targetClientId) {
      throw new ForbiddenError(
        `Client "${submittingClientId}" is not the target for this request (expected "${peeked.targetClientId}"). The targeted client must submit the result.`,
      );
    }
    const submittingActorPrincipalId = resolveActorPrincipalIdForLocalGuardian(
      headerMap["x-vellum-actor-principal-id"]?.trim() || undefined,
    );
    enforceSameActorOrThrow({
      sourceActorPrincipalId: submittingActorPrincipalId,
      targetActorPrincipalId: peeked.targetActorPrincipalId,
      targetClientId: peeked.targetClientId,
      op: "host_observe",
    });
  }

  pendingInteractions.resolve(requestId, "answered");

  HostObserveProxy.instance.resolve(requestId, {
    ...(description !== undefined ? { description } : {}),
    ...(imageBase64 !== undefined ? { imageBase64 } : {}),
    ...(mediaType !== undefined ? { mediaType } : {}),
    ...(appName !== undefined ? { appName } : {}),
  });

  return { accepted: true };
}

// ---------------------------------------------------------------------------
// Route definitions (shared HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "host_observe_result",
    endpoint: "host-observe-result",
    method: "POST",
    policy: {
      requiredScopes: ["approval.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    requireGuardian: true,
    summary: "Submit host observation result",
    description:
      "Resolve a pending host screen-observation request by requestId. Returns 200 even when no pending interaction matches (late delivery is tolerated).",
    tags: ["host"],
    requestBody: z.object({
      requestId: z.string().describe("Pending observe request ID"),
      description: z
        .string()
        .describe("Accessibility text read from the focused window")
        .optional(),
      imageBase64: z
        .string()
        .describe(
          "Base64 screenshot, for a client that can only capture pixels",
        )
        .optional(),
      mediaType: z.string().describe("Media type of imageBase64").optional(),
      appName: z
        .string()
        .describe("Frontmost application at the time of the read")
        .optional(),
    }),
    responseBody: z.object({
      accepted: z.boolean(),
    }),
    additionalResponses: {
      "400": {
        description:
          "x-vellum-client-id header is missing for a targeted host observe request.",
      },
      "403": {
        description: SAME_ACTOR_FORBIDDEN_DESCRIPTION,
      },
    },
    handler: handleHostObserveResult,
  },
];
