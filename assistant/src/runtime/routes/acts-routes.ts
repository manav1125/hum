/**
 * Route handlers for the act/reversal ledger — the trust-evidence numbers
 * ("214 acts · 0 reversed") and the TIME BACK "~N hrs" chip.
 *
 * Read-only by design: acts are captured at the work-item runner's completion
 * choke point and reversals at the redo / output-rejection paths (see
 * agent-act-store), so these routes only aggregate and list. Zero rows is the
 * expected starting state — the UI renders it as "measuring…". Auth is
 * enforced at the transport layer; handlers contain only business logic.
 */

import { z } from "zod";

import {
  getActsSummary,
  listRecentActs,
} from "../../work-items/agent-act-store.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
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
  reversed: z
    .number()
    .int()
    .describe("0/1 — the owner undid this act (redo or output rejection)"),
  reversedAt: z.number().int().nullable(),
  estMinutesSaved: z
    .number()
    .int()
    .nullable()
    .describe("Conservative heuristic estimate captured with the act"),
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
];
