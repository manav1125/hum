/**
 * Route handlers for temporary approval overrides (allow_10m /
 * allow_conversation grants).
 *
 * The override itself is installed by the permission checker when the user
 * answers a confirmation prompt with a temporary-grant verb (see
 * `POST /v1/confirm` in approval-routes.ts and
 * tools/permission-checker.ts). These endpoints only expose read + revoke:
 *
 *   - GET  /v1/approval-override?conversationId=…  — live status for the
 *     client countdown chip (re-sync after reload / conversation switch).
 *   - POST /v1/approval-override/clear — tap-to-revoke. Clearing returns the
 *     conversation to per-action prompts; nothing is ever auto-allowed by a
 *     revoke or an expiry.
 *
 * Recovery of upstream's temporary-approval-modes feature
 * (e05896063f / 46d64df40d^); the status/clear routes are net-new for the
 * countdown UI.
 */
import { z } from "zod";

import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  clearMode,
  getEffectiveMode,
} from "../conversation-approval-overrides.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("approval-override-routes");

/**
 * GET /v1/approval-override?conversationId=… — report the active temporary
 * approval override for a conversation, if any. Expired timed overrides are
 * lazily cleaned up by the store and read as inactive.
 */
function handleGetApprovalOverride({ queryParams }: RouteHandlerArgs) {
  const conversationId = queryParams?.conversationId;
  if (!conversationId) {
    throw new BadRequestError("conversationId is required");
  }

  const mode = getEffectiveMode(conversationId);
  if (!mode) {
    return { active: false as const };
  }
  if (mode.kind === "timed") {
    return {
      active: true as const,
      kind: "timed" as const,
      expiresAt: mode.expiresAt,
      remainingMs: Math.max(0, mode.expiresAt - Date.now()),
    };
  }
  return { active: true as const, kind: "conversation" as const };
}

/**
 * POST /v1/approval-override/clear — revoke any temporary approval override
 * for a conversation. Idempotent: clearing an absent override succeeds.
 */
function handleClearApprovalOverride({ body }: RouteHandlerArgs) {
  const conversationId = body?.conversationId as string | undefined;
  if (!conversationId || typeof conversationId !== "string") {
    throw new BadRequestError("conversationId is required");
  }

  const hadOverride = getEffectiveMode(conversationId) !== undefined;
  clearMode(conversationId);
  if (hadOverride) {
    log.info({ conversationId }, "Temporary approval override revoked by user");
  }
  return { cleared: true, hadOverride };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "approval_override_status",
    endpoint: "approval-override",
    method: "GET",
    policy: {
      requiredScopes: ["approval.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleGetApprovalOverride,
    requireGuardian: true,
    summary: "Get the active temporary approval override",
    description:
      "Report the active allow_10m / allow_conversation override for a conversation, including remaining time for timed grants.",
    tags: ["approvals"],
    queryParams: [
      {
        name: "conversationId",
        description: "Conversation ID",
      },
    ],
    responseBody: z.object({
      active: z.boolean(),
      kind: z.enum(["timed", "conversation"]).optional(),
      expiresAt: z.number().optional(),
      remainingMs: z.number().optional(),
    }),
  },
  {
    operationId: "approval_override_clear",
    endpoint: "approval-override/clear",
    method: "POST",
    policy: {
      requiredScopes: ["approval.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleClearApprovalOverride,
    requireGuardian: true,
    summary: "Revoke a temporary approval override",
    description:
      "Clear the allow_10m / allow_conversation override for a conversation, returning it to per-action approval prompts.",
    tags: ["approvals"],
    requestBody: z.object({
      conversationId: z.string().describe("Conversation ID"),
    }),
    responseBody: z.object({
      cleared: z.boolean(),
      hadOverride: z.boolean(),
    }),
  },
];
