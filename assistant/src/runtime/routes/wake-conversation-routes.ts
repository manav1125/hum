/**
 * Wake a conversation's agent loop with an opportunity hint.
 *
 * POST /v1/conversations/wake
 */

import { z } from "zod";

import { getConversation } from "../../memory/conversation-crud.js";
import { wrapUntrustedContent } from "../../security/untrusted-content.js";
import { wakeAgentForOpportunity } from "../agent-wake.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const WakeConversationBody = z.object({
  conversationId: z.string().min(1),
  hint: z.string().min(1),
  source: z.string().default("cli"),
  // Untrusted third-party data (email bodies, PR text, fetched pages,
  // notification payloads). Fenced inside `<external_content>` so the model
  // treats it as data, never instructions — the caller must never inline such
  // data into `hint`, which is trusted framing the caller authored.
  externalContent: z.string().optional(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "wake_conversation",
    endpoint: "conversations/wake",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Wake a conversation",
    description:
      "Invoke the agent loop for a conversation with an opportunity hint.",
    tags: ["conversations"],
    requestBody: WakeConversationBody,
    responseBody: z.object({
      invoked: z.boolean(),
      producedToolCalls: z.boolean(),
      reason: z.string().optional(),
    }),
    handler: async ({ body }) => {
      const { conversationId, hint, source, externalContent } =
        WakeConversationBody.parse(body);

      const conversation = getConversation(conversationId);
      if (!conversation) {
        throw new NotFoundError(`Conversation not found: ${conversationId}`);
      }

      // When the caller supplies untrusted third-party data, fence it inside
      // an `<external_content>` boundary and append it after the trusted hint.
      // The wake already sandwiches the hint between static user bookends
      // (the anti-injection pattern in agent-wake); the fence adds an explicit
      // structural marker so the fenced portion is unambiguously data.
      const effectiveHint =
        externalContent !== undefined
          ? `${hint}\n\n${wrapUntrustedContent(externalContent, {
              source: "webhook",
            })}`
          : hint;

      return wakeAgentForOpportunity({
        conversationId,
        hint: effectiveHint,
        source,
      });
    },
  },
];
