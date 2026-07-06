/**
 * Route handlers for the act/reversal ledger — the trust-evidence numbers
 * ("214 acts · 0 reversed") and the TIME BACK "~N hrs" chip.
 *
 * Acts are captured at the work-item runner's completion choke point;
 * reversals happen three ways — the redo path, the output-rejection path
 * (both observed, see agent-act-store), and the owner-initiated
 * `POST acts/:id/reverse` here, which performs the concrete unwind where one
 * exists (un-accept deliverables, reopen the item for review) and returns
 * 409 for act kinds it cannot honestly undo. Zero rows is the expected
 * starting state — the UI renders it as "measuring…". Auth is enforced at
 * the transport layer; handlers contain only business logic.
 */

import { z } from "zod";

import type { ServerMessage } from "../../daemon/message-protocol.js";
import {
  getActsSummary,
  listRecentActs,
  reverseAct,
} from "../../work-items/agent-act-store.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { ConflictError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const agentActSchema = z.object({
  id: z.string(),
  agent: z.string().describe('The assignee that acted; defaults to "cue"'),
  workItemId: z.string().nullable(),
  missionId: z
    .string()
    .nullable()
    .describe("Denormalized at capture from the work item's project"),
  kind: z.enum([
    "run_completed",
    "output_produced",
    "message_drafted",
    "schedule_fired",
    "other",
  ]),
  title: z
    .string()
    .nullable()
    .describe(
      "Human title of what the act did (the work item's title); null = no natural source at capture",
    ),
  reversed: z
    .number()
    .int()
    .describe(
      "0/1 — the owner undid this act (redo, output rejection, or explicit reverse)",
    ),
  reversedAt: z.number().int().nullable(),
  estMinutesSaved: z
    .number()
    .int()
    .nullable()
    .describe("Conservative heuristic estimate captured with the act"),
  costCents: z
    .number()
    .int()
    .nullable()
    .describe(
      "The run's real attributable LLM cost in cents (summed from the run conversation's usage at capture); null = unknown, NOT zero",
    ),
  model: z
    .string()
    .nullable()
    .describe(
      "Dominant model of the run (highest summed cost); null = unknown",
    ),
  createdAt: z.number().int(),
});

const agentBreakdownSchema = z.object({
  agent: z.string(),
  acts: z.number().int(),
  reversed: z.number().int(),
  estMinutesSaved: z
    .number()
    .int()
    .describe("Sum over non-reversed acts only — a reversed act saved nothing"),
});

const summaryResponseSchema = z.object({
  acts: z.number().int(),
  reversed: z.number().int(),
  estMinutesSaved: z
    .number()
    .int()
    .describe("Sum over non-reversed acts only — a reversed act saved nothing"),
  byAgent: z.array(agentBreakdownSchema),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getActsSummary",
    endpoint: "acts/summary",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Act/reversal ledger summary",
    description:
      'Totals + per-agent breakdown of the act ledger — powers the "N acts · M reversed" trust evidence and the TIME BACK "~N hrs" chip. All-zero totals mean the ledger is still measuring (honest zero-start, no backfill).',
    tags: ["acts"],
    queryParams: [
      {
        name: "agent",
        description: "Filter to one agent (work-item assignee)",
        schema: { type: "string" },
      },
      {
        name: "days",
        description:
          "Only count acts from the trailing N days (default: all time)",
        schema: { type: "integer" },
      },
    ],
    responseBody: summaryResponseSchema,
    handler: ({ queryParams }) => {
      const agent = queryParams?.agent?.trim() || undefined;
      const rawDays = Number(queryParams?.days);
      const days =
        Number.isFinite(rawDays) && rawDays > 0 ? rawDays : undefined;
      return getActsSummary({ agent, days });
    },
  },

  {
    operationId: "listActs",
    endpoint: "acts",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List recent acts",
    description:
      "Newest-first rows from the act/reversal ledger — the evidence behind the summary numbers.",
    tags: ["acts"],
    queryParams: [
      {
        name: "agent",
        description: "Filter to one agent (work-item assignee)",
        schema: { type: "string" },
      },
      {
        name: "limit",
        description: "Max acts to return (default 50, cap 200)",
        schema: { type: "integer" },
      },
    ],
    responseBody: z.object({ acts: z.array(agentActSchema) }),
    handler: ({ queryParams }) => {
      const agent = queryParams?.agent?.trim() || undefined;
      const rawLimit = Number(queryParams?.limit);
      const limit = Number.isFinite(rawLimit) ? rawLimit : undefined;
      return { acts: listRecentActs({ agent, limit }) };
    },
  },

  {
    operationId: "reverseAct",
    endpoint: "acts/:id/reverse",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Reverse an act",
    description:
      "Owner-initiated reversal of one act. Where a concrete undo exists — run_completed / output_produced acts bound to a work item — it is performed: the item's approved deliverables are demoted back to pending review, a done item is reopened to awaiting_review (run_completed only), and the act flips to reversed. Kinds with no concrete undo (message_drafted, schedule_fired, other), acts with no bound work item, and already-reversed acts return 409 with the reason — never a fake success.",
    tags: ["acts"],
    pathParams: [{ name: "id", description: "The act id" }],
    responseBody: z.object({
      act: agentActSchema,
      unwound: z.object({
        outputsDemoted: z
          .number()
          .int()
          .describe(
            "work_outputs of the act's work item flipped approved → pending",
          ),
        workItemReopened: z
          .boolean()
          .describe("The work item was reopened done → awaiting_review"),
      }),
    }),
    handler: ({ pathParams }) => {
      const id = pathParams!.id;
      const outcome = reverseAct(id);
      if (!outcome.ok) {
        if (outcome.code === "not_found") {
          throw new NotFoundError(outcome.reason);
        }
        // already_reversed and no_undo are both state conflicts: the act
        // exists but cannot be (re-)reversed.
        throw new ConflictError(outcome.reason, { code: outcome.code });
      }
      // The unwind may have changed a work item's status/outputs — nudge
      // SSE-driven clients to refetch, mirroring the guardrails mutations.
      void assistantEventHub.publish(
        buildAssistantEvent({ type: "tasks_changed" } as ServerMessage),
      );
      return { act: outcome.act, unwound: outcome.unwound };
    },
  },
];
