/**
 * Next-move route — the "chief of staff" intelligence.
 *
 * `GET /v1/assistants/{assistant_id}/next-move` (daemon endpoint `next-move`;
 * the gateway prefixes `/v1/assistants/{assistant_id}`, same as `activity`).
 *
 * Returns the single most important thing the user should do right now, picked
 * deterministically across pending approvals, queued/awaiting-review work
 * items, and top home-feed action items, then narrated by the flash LLM.
 *
 * Stale-while-revalidate: the handler returns the cached (or deterministic
 * fallback) move immediately and kicks a bounded, single-flight, TTL-gated
 * background refresh of the LLM narration. The handler itself stays read-only
 * and never blocks on the LLM — the accepted GET-handler exception documented
 * in `src/runtime/AGENTS.md` (alongside `GET /v1/home/feed`).
 */

import { z } from "zod";

import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { getNextMove, revalidateNextMoveInBackground } from "../next-move.js";
import type { RouteDefinition } from "./types.js";

const nextMoveActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["approve", "decline", "run", "open_thread", "snooze"]),
  endpoint: z.string().optional(),
  method: z.string().optional(),
});

const nextMoveResponseSchema = z.object({
  hasMove: z.boolean(),
  itemId: z.string().nullable(),
  kind: z.enum(["approval", "work_item", "feed"]).nullable(),
  headline: z.string(),
  reasoning: z.string(),
  actions: z.array(nextMoveActionSchema),
  sourceConversationId: z.string().optional(),
  generatedAt: z.string(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "get_next_move",
    endpoint: "next-move",
    method: "GET",
    // Mirror `listWorkItems` / `activity_list`: a read scope, actor principals.
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get the single most important next move",
    description:
      "Pick the one thing the user should do right now — across pending " +
      "approvals, queued/awaiting-review work items, and top home-feed action " +
      "items — ranked deterministically and narrated by the flash LLM. " +
      "Stale-while-revalidate: returns the cached/fallback move immediately and " +
      "refreshes the narration in the background. Returns hasMove:false with a " +
      "'You're all caught up.' headline when nothing is pending.",
    tags: ["activity"],
    responseBody: nextMoveResponseSchema,
    handler: () => {
      const move = getNextMove();
      // Fire-and-forget narration refresh — never blocks the response.
      revalidateNextMoveInBackground();
      return move;
    },
  },
];
