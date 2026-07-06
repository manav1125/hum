/**
 * Route handlers for Guardrails — the unified rules surface that composes the
 * existing trust/approval/spend/ledger plumbing into one payload the UI
 * renders, plus CRUD for guardrail checkpoints ("Cue always asks before…").
 *
 * Nothing here re-implements enforcement: checkpoints compile to patterns the
 * permission checker consumes (see guardrails/checkpoint-enforcement),
 * per-agent spend is the real attributed slice from agent-store, and the
 * ledger is the existing act/reversal store + workspace usage rollup. Each
 * checkpoint carries an honest `enforced` flag — `autonomy:<class>` patterns
 * are live; other templates are declarative until their hook exists.
 *
 * Registered SCOPE-LESS (`guardrails`, `guardrails/checkpoints`); the spec
 * transform + gateway wrap the `/assistants/{id}` scope around them. Auth is
 * enforced at the transport layer; handlers contain only business logic.
 * Mutations publish `tasks_changed` so SSE-driven clients refetch, mirroring
 * the agents/missions routes.
 */

import { z } from "zod";

import type { ServerMessage } from "../../daemon/message-protocol.js";
import {
  CHECKPOINT_TEMPLATES,
  checkpointEnforcementVia,
  createCheckpoint,
  deleteCheckpoint,
  getCheckpoint,
  type GuardrailCheckpoint,
  type GuardrailCheckpointTemplate,
  isCheckpointEnforced,
  listCheckpoints,
  updateCheckpoint,
} from "../../guardrails/checkpoint-store.js";
import { getUsageRollup } from "../../guardrails/usage-rollup.js";
import {
  getActsSummary,
  listRecentActs,
} from "../../work-items/agent-act-store.js";
import { getAgentSpend, listAgents } from "../../work-items/agent-store.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { getAll as getAllPendingInteractions } from "../pending-interactions.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

function publishEvent(msg: ServerMessage): void {
  void assistantEventHub.publish(buildAssistantEvent(msg));
}

// ── Schemas ──────────────────────────────────────────────────────────

const templateSchema = z
  .enum(CHECKPOINT_TEMPLATES)
  .describe("Checkpoint template the rule was authored from");

const scopeDescription =
  "'everywhere' | 'agent:<agentId>' | 'mission:<missionId>'";

const checkpointSchema = z.object({
  id: z.string(),
  template: templateSchema,
  label: z.string().describe("Plain-English rule name"),
  pattern: z
    .string()
    .describe(
      "Compiled enforcement pattern. 'autonomy:<class>' patterns are enforced by the permission checker; other forms are declarative today.",
    ),
  scope: z.string().describe(scopeDescription),
  thresholdCents: z
    .number()
    .int()
    .nullable()
    .describe(
      "spend_over dollar line in cents. Advisory: per-action cost is unknowable pre-execution, so an enabled spend_over checkpoint asks on ANY money-category action.",
    ),
  enabled: z.number().int().describe("0/1 — the rule is active"),
  isDefault: z.number().int().describe("0/1 — seeded starter rule"),
  enforced: z
    .boolean()
    .describe(
      "Whether this rule is live in the permission checker (autonomy:<class> patterns) or declarative-only ('coming online').",
    ),
  enforcedVia: z
    .string()
    .nullable()
    .describe("The enforcement mechanism; null when declarative"),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const agentWithSpendSchema = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string().nullable(),
  domain: z.string().nullable(),
  charter: z.string().nullable(),
  tier: z.string(),
  capCents: z.number().int().nullable(),
  paused: z.number().int(),
  model: z
    .string()
    .nullable()
    .describe("Per-agent model pin; background runs execute on it"),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  spend: z.object({
    spentCents: z
      .number()
      .int()
      .describe("Real attributed spend over the window (work-item-run slice)"),
    capCents: z
      .number()
      .int()
      .nullable()
      .describe("Weekly cap; null = uncapped"),
    runs: z.number().int().describe("Run conversations that contributed"),
  }),
});

const actSchema = z.object({
  id: z.string(),
  agent: z.string(),
  workItemId: z.string().nullable(),
  missionId: z.string().nullable(),
  kind: z.enum([
    "run_completed",
    "output_produced",
    "message_drafted",
    "schedule_fired",
    "other",
  ]),
  reversed: z.number().int(),
  reversedAt: z.number().int().nullable(),
  estMinutesSaved: z.number().int().nullable(),
  createdAt: z.number().int(),
});

const modelMixSchema = z.object({
  model: z.string(),
  costCents: z.number().int(),
  calls: z.number().int(),
  share: z.number().describe("costCents / totalCents (0..1)"),
});

const ledgerSchema = z.object({
  recentActs: z.array(actSchema),
  summary: z.object({
    actCount: z.number().int().describe("Acts over the window"),
    reversedCount: z.number().int(),
    heldCount: z
      .number()
      .int()
      .describe("Approvals currently held (pending confirmations right now)"),
    estMinutesSaved: z
      .number()
      .int()
      .describe("Sum over non-reversed acts only"),
    totalCents: z
      .number()
      .int()
      .describe("Workspace-wide LLM cost over the window (all usage)"),
    byModel: z.array(modelMixSchema),
  }),
});

const guardrailsResponseSchema = z.object({
  checkpoints: z.array(checkpointSchema),
  agents: z.array(agentWithSpendSchema),
  ledger: ledgerSchema,
  window: z.object({
    days: z.number().int(),
    from: z.number().int(),
    to: z.number().int(),
  }),
});

// ── Helpers ──────────────────────────────────────────────────────────

function withEnforcement(
  checkpoint: GuardrailCheckpoint,
): GuardrailCheckpoint & { enforced: boolean; enforcedVia: string | null } {
  return {
    ...checkpoint,
    enforced: isCheckpointEnforced(checkpoint),
    enforcedVia: checkpointEnforcementVia(checkpoint),
  };
}

/** Approvals held for the owner right now (live pending confirmations). */
function countHeldApprovals(): number {
  try {
    return getAllPendingInteractions().filter(
      (i) => i.kind === "confirmation" || i.kind === "acp_confirmation",
    ).length;
  } catch {
    return 0;
  }
}

function parseDays(raw: unknown): number {
  const days = Number(raw);
  return Number.isFinite(days) && days > 0 ? days : 7;
}

// ── Route definitions ────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getGuardrails",
    endpoint: "guardrails",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "The composed Guardrails payload",
    description:
      "One read for the whole Guardrails surface: the checkpoint rules (with honest enforced/declarative flags), the agent roster with real attributed spend vs cap and the per-agent model pin, and the evidence ledger (recent acts, currently-held approvals, workspace $ + model mix over the window). Composes the existing agent/act/usage stores — nothing is fabricated.",
    tags: ["guardrails"],
    queryParams: [
      {
        name: "days",
        description: "Trailing window in days for spend/acts/usage (default 7)",
        schema: { type: "integer" },
      },
    ],
    responseBody: guardrailsResponseSchema,
    handler: ({ queryParams }) => {
      const days = parseDays(queryParams?.days);

      const checkpoints = listCheckpoints().map(withEnforcement);

      const spend = getAgentSpend({ days });
      const spendByAgent = new Map(
        spend.byAgent.map((row) => [row.agent.toLowerCase(), row]),
      );
      const agents = listAgents().map((agent) => {
        const row = spendByAgent.get(agent.name.toLowerCase());
        return {
          ...agent,
          spend: {
            spentCents: row?.spentCents ?? 0,
            capCents: agent.capCents,
            runs: row?.runs ?? 0,
          },
        };
      });

      const acts = getActsSummary({ days });
      const rollup = getUsageRollup({ days });

      return {
        checkpoints,
        agents,
        ledger: {
          recentActs: listRecentActs({ limit: 20 }),
          summary: {
            actCount: acts.acts,
            reversedCount: acts.reversed,
            heldCount: countHeldApprovals(),
            estMinutesSaved: acts.estMinutesSaved,
            totalCents: rollup.totalCents,
            byModel: rollup.byModel,
          },
        },
        window: { days, from: rollup.from, to: rollup.to },
      };
    },
  },

  {
    operationId: "listGuardrailCheckpoints",
    endpoint: "guardrails/checkpoints",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List guardrail checkpoints",
    description:
      "Every checkpoint rule, oldest-first, each with its honest enforced/declarative flag.",
    tags: ["guardrails"],
    responseBody: z.object({ checkpoints: z.array(checkpointSchema) }),
    handler: () => ({ checkpoints: listCheckpoints().map(withEnforcement) }),
  },

  {
    operationId: "createGuardrailCheckpoint",
    endpoint: "guardrails/checkpoints",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Add a checkpoint",
    description:
      "Author a rule from a template (send_message / spend_over / publish / delete / contact / custom). The pattern compiles from the template unless supplied; custom requires an explicit pattern. Scope it everywhere, to one agent, or to one mission.",
    tags: ["guardrails"],
    requestBody: z.object({
      template: templateSchema,
      label: z.string().min(1),
      pattern: z
        .string()
        .optional()
        .describe("Required for template 'custom'; compiled otherwise"),
      scope: z.string().optional().describe(scopeDescription),
      thresholdCents: z.number().int().min(0).optional(),
      enabled: z.boolean().optional(),
    }),
    responseStatus: "201",
    responseBody: z.object({ checkpoint: checkpointSchema }),
    handler: ({ body }) => {
      const b = (body ?? {}) as {
        template?: string;
        label?: string;
        pattern?: string;
        scope?: string;
        thresholdCents?: number;
        enabled?: boolean;
      };
      const label = typeof b.label === "string" ? b.label.trim() : "";
      if (!label) throw new BadRequestError("label is required");
      if (
        typeof b.template !== "string" ||
        !(CHECKPOINT_TEMPLATES as readonly string[]).includes(b.template)
      ) {
        throw new BadRequestError(
          `template must be one of: ${CHECKPOINT_TEMPLATES.join(", ")}`,
        );
      }
      let checkpoint: GuardrailCheckpoint;
      try {
        checkpoint = createCheckpoint({
          template: b.template as GuardrailCheckpointTemplate,
          label,
          ...(typeof b.pattern === "string" ? { pattern: b.pattern } : {}),
          ...(typeof b.scope === "string" ? { scope: b.scope } : {}),
          ...(typeof b.thresholdCents === "number"
            ? { thresholdCents: b.thresholdCents }
            : {}),
          ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}),
        });
      } catch (err) {
        throw new BadRequestError(String((err as Error).message ?? err));
      }
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { checkpoint: withEnforcement(checkpoint) };
    },
  },

  {
    operationId: "updateGuardrailCheckpoint",
    endpoint: "guardrails/checkpoints/:id",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update a checkpoint",
    description:
      "Rename, toggle on/off, re-scope, re-pattern, or change the spend threshold.",
    tags: ["guardrails"],
    requestBody: z
      .object({
        label: z.string().min(1),
        pattern: z.string().min(1),
        scope: z.string().describe(scopeDescription),
        thresholdCents: z.number().int().min(0).nullable(),
        enabled: z.boolean(),
      })
      .partial(),
    responseBody: z.object({ checkpoint: checkpointSchema }),
    handler: ({ pathParams, body }) => {
      const id = pathParams!.id;
      if (!getCheckpoint(id)) {
        throw new NotFoundError(`Checkpoint not found: ${id}`);
      }
      const raw = (body ?? {}) as {
        label?: string;
        pattern?: string;
        scope?: string;
        thresholdCents?: number | null;
        enabled?: boolean;
      };
      const updates: Parameters<typeof updateCheckpoint>[1] = {};
      if (raw.label !== undefined) {
        const label = raw.label.trim();
        if (!label) throw new BadRequestError("label cannot be empty");
        updates.label = label;
      }
      if (raw.pattern !== undefined) {
        const pattern = raw.pattern.trim();
        if (!pattern) throw new BadRequestError("pattern cannot be empty");
        updates.pattern = pattern;
      }
      if (raw.scope !== undefined) updates.scope = raw.scope;
      if (raw.thresholdCents !== undefined) {
        updates.thresholdCents = raw.thresholdCents;
      }
      // The store column is 0/1; accept a boolean at the wire and normalize.
      if (raw.enabled !== undefined) updates.enabled = raw.enabled ? 1 : 0;
      let checkpoint: GuardrailCheckpoint | undefined;
      try {
        checkpoint = updateCheckpoint(id, updates);
      } catch (err) {
        throw new BadRequestError(String((err as Error).message ?? err));
      }
      if (!checkpoint) throw new NotFoundError(`Checkpoint not found: ${id}`);
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { checkpoint: withEnforcement(checkpoint) };
    },
  },

  {
    operationId: "deleteGuardrailCheckpoint",
    endpoint: "guardrails/checkpoints/:id",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete a checkpoint",
    description:
      "Hard-delete a rule. Seeded defaults are not resurrected (the seed only runs on an empty table).",
    tags: ["guardrails"],
    responseBody: z.object({ id: z.string(), success: z.boolean() }),
    handler: ({ pathParams }) => {
      const id = pathParams!.id;
      if (!getCheckpoint(id)) {
        throw new NotFoundError(`Checkpoint not found: ${id}`);
      }
      deleteCheckpoint(id);
      publishEvent({ type: "tasks_changed" } as ServerMessage);
      return { id, success: true };
    },
  },
];
