/**
 * Route handlers for the agent registry — the Agents · org page roster
 * (Ops / Builder / Growth / …) plus per-agent attributed spend. Replaces the
 * Phase-1 localStorage charter config so charters persist server-side and other
 * surfaces can read them. Mutations publish `tasks_changed` so SSE-driven
 * clients refetch, mirroring the missions/projects routes. Auth is enforced at
 * the transport layer; handlers contain only business logic.
 */

import { z } from "zod";

import type { ServerMessage } from "../../daemon/message-protocol.js";
import {
  createAgent,
  deleteAgent,
  getAgent,
  getAgentSpend,
  listAgents,
  updateAgent,
} from "../../work-items/agent-store.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

function publishEvent(msg: ServerMessage): void {
  void assistantEventHub.publish(buildAssistantEvent(msg));
}

const tierSchema = z
  .enum(["1", "2", "3", "4"])
  .describe("Autonomy tier '1'..'4'");

const agentSchema = z.object({
  id: z.string(),
  name: z
    .string()
    .describe("Display name + work-item assignee match key (case-insensitive)"),
  emoji: z.string().nullable(),
  domain: z.string().nullable(),
  charter: z.string().nullable().describe("The standing mandate"),
  tier: tierSchema,
  capCents: z
    .number()
    .int()
    .nullable()
    .describe("Weekly spend cap in cents; null = uncapped"),
  paused: z.number().int().describe("0/1 — the role is paused"),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const agentSpendSchema = z.object({
  agent: z.string(),
  spentCents: z
    .number()
    .int()
    .describe("Real attributed spend in cents over the window"),
  runs: z
    .number()
    .int()
    .describe("Run conversations that contributed to the spend"),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listAgents",
    endpoint: "agents",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List agents",
    description:
      "The org roster — every staffed role (name, emoji, domain, charter, tier, cap, paused), name-ordered. The three defaults (Ops/Builder/Growth) are seeded on first init; `cue` is the implicit house agent and is not a row.",
    tags: ["agents"],
    responseBody: z.object({ agents: z.array(agentSchema) }),
    handler: () => ({ agents: listAgents() }),
  },

  {
    operationId: "createAgent",
    endpoint: "agents",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Hire an agent",
    description: "Add a new role to the org.",
    tags: ["agents"],
    requestBody: z.object({
      name: z.string().min(1),
      emoji: z.string().optional(),
      domain: z.string().optional(),
      charter: z.string().optional(),
      tier: tierSchema.optional(),
      capCents: z.number().int().min(0).optional(),
      paused: z.boolean().optional(),
    }),
    responseStatus: "201",
    responseBody: z.object({ agent: agentSchema }),
    handler: ({ body }) => {
      const b = (body ?? {}) as {
        name?: string;
        emoji?: string;
        domain?: string;
        charter?: string;
        tier?: string;
        capCents?: number;
        paused?: boolean;
      };
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!name) throw new BadRequestError("name is required");
      const agent = createAgent({
        name,
        ...(typeof b.emoji === "string" ? { emoji: b.emoji } : {}),
        ...(typeof b.domain === "string" ? { domain: b.domain } : {}),
        ...(typeof b.charter === "string" ? { charter: b.charter } : {}),
        ...(typeof b.tier === "string" ? { tier: b.tier } : {}),
        ...(typeof b.capCents === "number" ? { capCents: b.capCents } : {}),
        ...(typeof b.paused === "boolean" ? { paused: b.paused } : {}),
      });
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { agent };
    },
  },

  {
    operationId: "getAgentSpend",
    endpoint: "agents/spend",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Per-agent attributed spend",
    description:
      "Real per-agent $ spend over the trailing window, attributed by joining LLM usage → the work item's run conversation → its assignee (null assignee reads as 'cue'). `attributedCents` is the sum of the per-agent rows — the work-item-run slice of usage, NOT the workspace usage total. Honest limit: only the latest run conversation per item is tracked, so a re-run's superseded prior-run cost is not counted.",
    tags: ["agents"],
    queryParams: [
      {
        name: "days",
        description: "Trailing window in days (default 7)",
        schema: { type: "integer" },
      },
    ],
    responseBody: z.object({
      byAgent: z.array(agentSpendSchema),
      attributedCents: z
        .number()
        .int()
        .describe(
          "Sum of per-agent rows — the attributable work-item-run slice",
        ),
      from: z.number().int(),
      to: z.number().int(),
    }),
    handler: ({ queryParams }) => {
      const rawDays = Number(queryParams?.days);
      const days =
        Number.isFinite(rawDays) && rawDays > 0 ? rawDays : undefined;
      return getAgentSpend(days != null ? { days } : undefined);
    },
  },

  {
    operationId: "getAgent",
    endpoint: "agents/:id",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get an agent",
    tags: ["agents"],
    responseBody: z.object({ agent: agentSchema }),
    handler: ({ pathParams }) => {
      const agent = getAgent(pathParams!.id);
      if (!agent) throw new NotFoundError(`Agent not found: ${pathParams!.id}`);
      return { agent };
    },
  },

  {
    operationId: "updateAgent",
    endpoint: "agents/:id",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update an agent",
    description:
      "Rename, re-charter, change tier, set/clear the spend cap, or pause/resume a role.",
    tags: ["agents"],
    requestBody: z
      .object({
        name: z.string().min(1),
        emoji: z.string().nullable(),
        domain: z.string().nullable(),
        charter: z.string().nullable(),
        tier: tierSchema,
        capCents: z.number().int().min(0).nullable(),
        paused: z.boolean(),
      })
      .partial(),
    responseBody: z.object({ agent: agentSchema }),
    handler: ({ pathParams, body }) => {
      const id = pathParams!.id;
      if (!getAgent(id)) throw new NotFoundError(`Agent not found: ${id}`);
      const raw = (body ?? {}) as {
        name?: string;
        emoji?: string | null;
        domain?: string | null;
        charter?: string | null;
        tier?: string;
        capCents?: number | null;
        paused?: boolean;
      };
      const updates: Parameters<typeof updateAgent>[1] = {};
      if (raw.name !== undefined) {
        const name = raw.name.trim();
        if (!name) throw new BadRequestError("name cannot be empty");
        updates.name = name;
      }
      if (raw.emoji !== undefined) updates.emoji = raw.emoji;
      if (raw.domain !== undefined) updates.domain = raw.domain;
      if (raw.charter !== undefined) updates.charter = raw.charter;
      if (raw.tier !== undefined) updates.tier = raw.tier;
      if (raw.capCents !== undefined) updates.capCents = raw.capCents;
      // The store column is 0/1; accept a boolean at the wire and normalize.
      if (raw.paused !== undefined) updates.paused = raw.paused ? 1 : 0;
      const agent = updateAgent(id, updates);
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { agent };
    },
  },

  {
    operationId: "deleteAgent",
    endpoint: "agents/:id",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Retire an agent",
    description:
      "Hard-delete a role. Work items keep their `assignee` string (they fall back to the 'cue' house agent in the roster views).",
    tags: ["agents"],
    responseBody: z.object({ id: z.string(), success: z.boolean() }),
    handler: ({ pathParams }) => {
      const id = pathParams!.id;
      if (!getAgent(id)) throw new NotFoundError(`Agent not found: ${id}`);
      deleteAgent(id);
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { id, success: true };
    },
  },
];
