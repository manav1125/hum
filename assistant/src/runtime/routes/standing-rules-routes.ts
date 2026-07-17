/**
 * Route handlers for standing auto-confirm rules — the persistence behind the
 * in-context "Make it a rule" card.
 *
 * After the owner confirms a one-off inbound commitment, the card offers to
 * promote the decision into a STANDING rule ("auto-confirm anything from
 * Rachel" / "auto-confirm anything from Slack"). Creating a rule here writes to
 * the daemon-owned `standing_rules` store; the work-item auto-run gate
 * (work-items/work-item-triage.ts → maybeAutoRunWorkItem) CONSULTS it on the
 * next matching capture, clearing the per-category autonomy policy's
 * `policy_ask` deferral for items the rule matches. Nothing here re-implements
 * enforcement or the hard-deny safety floor — a rule only ever loosens the
 * softer per-category "ask".
 *
 * Registered SCOPE-LESS (`trust/rules`, `trust/rules/:id`); the spec transform +
 * gateway wrap the `/assistants/{id}` scope around them (so the public path is
 * `POST /v1/assistants/{id}/trust/rules`). Auth is enforced at the transport
 * layer; handlers contain only business logic. Mutations publish `tasks_changed`
 * so SSE-driven clients refetch, mirroring the guardrails/agents/missions routes.
 */

import { z } from "zod";

import type { ServerMessage } from "../../daemon/message-protocol.js";
import {
  createStandingRule,
  deleteStandingRule,
  getStandingRule,
  listStandingRules,
  STANDING_RULE_ACTIONS,
  STANDING_RULE_TRIGGER_TYPES,
  type StandingRule,
  type StandingRuleAction,
  type StandingRuleTriggerType,
  updateStandingRule,
} from "../../work-items/standing-rules-store.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

function publishEvent(msg: ServerMessage): void {
  void assistantEventHub.publish(buildAssistantEvent(msg));
}

// ── Schemas ──────────────────────────────────────────────────────────

const triggerTypeSchema = z
  .enum(STANDING_RULE_TRIGGER_TYPES)
  .describe(
    "What the rule keys off: 'sender' (who it's from), 'channel' (where it arrived), 'category' (autonomy class), or 'tool'.",
  );

const actionSchema = z
  .enum(STANDING_RULE_ACTIONS)
  .describe("What the rule does when it matches. Only 'auto_confirm' today.");

const standingRuleSchema = z.object({
  id: z.string(),
  triggerType: triggerTypeSchema,
  triggerValue: z
    .string()
    .describe(
      "The value the trigger matches, e.g. 'Rachel' (sender), 'slack' (channel), 'draft' (category), 'web_fetch' (tool).",
    ),
  action: actionSchema,
  label: z.string().describe("Plain-English rule name shown in the Trust console"),
  enabled: z.number().int().describe("0/1 — the rule is active"),
  sourceWorkItemId: z
    .string()
    .nullable()
    .describe("Provenance: the work item the rule was minted from; null if none"),
  sourceTaskId: z
    .string()
    .nullable()
    .describe("Provenance: the task the rule was minted from; null if none"),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

// ── Route definitions ────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listStandingRules",
    endpoint: "trust/rules",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List standing auto-confirm rules",
    description:
      "Every standing 'Make it a rule' decision, oldest-first. These loosen the per-category autonomy policy's approval hold for matching inbound work (by sender / channel / category / tool).",
    tags: ["trust"],
    responseBody: z.object({ rules: z.array(standingRuleSchema) }),
    handler: () => ({ rules: listStandingRules() }),
  },

  {
    operationId: "createStandingRule",
    endpoint: "trust/rules",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Create a standing auto-confirm rule",
    description:
      "Promote a just-confirmed one-off into a standing rule so the same class of inbound work auto-runs next time instead of parking for approval. Idempotent: a duplicate (same trigger + action) returns the existing rule. The rule is consulted by the work-item auto-run gate and NEVER overrides the hard-deny safety floor (host/browser/purchase/send/money never auto-run).",
    tags: ["trust"],
    requestBody: z.object({
      triggerType: triggerTypeSchema,
      triggerValue: z.string().min(1),
      action: actionSchema.optional(),
      label: z
        .string()
        .optional()
        .describe("Override the auto-generated plain-English label"),
      sourceWorkItemId: z
        .string()
        .optional()
        .describe("Provenance: the work item this was promoted from"),
      sourceTaskId: z
        .string()
        .optional()
        .describe("Provenance: the task this was promoted from"),
    }),
    responseStatus: "201",
    responseBody: z.object({ rule: standingRuleSchema }),
    handler: ({ body }) => {
      const b = (body ?? {}) as {
        triggerType?: string;
        triggerValue?: string;
        action?: string;
        label?: string;
        sourceWorkItemId?: string;
        sourceTaskId?: string;
      };
      if (
        typeof b.triggerType !== "string" ||
        !(STANDING_RULE_TRIGGER_TYPES as readonly string[]).includes(
          b.triggerType,
        )
      ) {
        throw new BadRequestError(
          `triggerType must be one of: ${STANDING_RULE_TRIGGER_TYPES.join(", ")}`,
        );
      }
      const triggerValue =
        typeof b.triggerValue === "string" ? b.triggerValue.trim() : "";
      if (!triggerValue) throw new BadRequestError("triggerValue is required");

      let rule: StandingRule;
      try {
        rule = createStandingRule({
          triggerType: b.triggerType as StandingRuleTriggerType,
          triggerValue,
          ...(typeof b.action === "string"
            ? { action: b.action as StandingRuleAction }
            : {}),
          ...(typeof b.label === "string" ? { label: b.label } : {}),
          ...(typeof b.sourceWorkItemId === "string"
            ? { sourceWorkItemId: b.sourceWorkItemId }
            : {}),
          ...(typeof b.sourceTaskId === "string"
            ? { sourceTaskId: b.sourceTaskId }
            : {}),
        });
      } catch (err) {
        throw new BadRequestError(String((err as Error).message ?? err));
      }
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { rule };
    },
  },

  {
    operationId: "updateStandingRule",
    endpoint: "trust/rules/:id",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update a standing rule",
    description: "Toggle a rule on/off or rename it from the Trust console.",
    tags: ["trust"],
    requestBody: z
      .object({
        enabled: z.boolean(),
        label: z.string().min(1),
      })
      .partial(),
    responseBody: z.object({ rule: standingRuleSchema }),
    handler: ({ pathParams, body }) => {
      const id = pathParams!.id;
      if (!getStandingRule(id)) {
        throw new NotFoundError(`Standing rule not found: ${id}`);
      }
      const raw = (body ?? {}) as { enabled?: boolean; label?: string };
      const updates: Parameters<typeof updateStandingRule>[1] = {};
      if (raw.enabled !== undefined) updates.enabled = raw.enabled ? 1 : 0;
      if (raw.label !== undefined) {
        const label = raw.label.trim();
        if (!label) throw new BadRequestError("label cannot be empty");
        updates.label = label;
      }
      const rule = updateStandingRule(id, updates);
      if (!rule) throw new NotFoundError(`Standing rule not found: ${id}`);
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { rule };
    },
  },

  {
    operationId: "deleteStandingRule",
    endpoint: "trust/rules/:id",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete a standing rule",
    description: "Hard-delete a standing auto-confirm rule.",
    tags: ["trust"],
    responseBody: z.object({ id: z.string(), success: z.boolean() }),
    handler: ({ pathParams }) => {
      const id = pathParams!.id;
      if (!getStandingRule(id)) {
        throw new NotFoundError(`Standing rule not found: ${id}`);
      }
      deleteStandingRule(id);
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { id, success: true };
    },
  },
];
