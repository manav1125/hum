/**
 * The autonomy ledger read — "what did Cue actually DO on my behalf?".
 *
 * One GET over `ledger/autonomy`: the newest consequential actions Cue
 * attempted (external send / call / money / publish / delete / purchase,
 * network-egress shells, browser submit controls, script-mode schedules,
 * opaque external runners, host file mutations), each with a plain-English
 * sentence, the target reached, whether a human was present, and how it was
 * authorised — plus a rollup whose headline number is the one the rogue-send
 * incident made matter: **how many consequential actions executed unattended,
 * and how many of those nobody approved.**
 *
 * Read-only. Nothing here re-derives anything: the rows are exactly what the
 * tool executor observed at the moment each action settled.
 *
 * Registered SCOPE-LESS (`ledger/autonomy`); the spec transform + gateway wrap
 * the `/assistants/{id}` scope around it. Auth is enforced at the transport
 * layer; the handler contains only business logic.
 */

import { z } from "zod";

import {
  getAutonomyLedgerSummary,
  listAutonomyLedger,
  type ListLedgerOptions,
} from "../../ledger/autonomy-ledger-store.js";
import type { ConsequentialActionClass } from "../../ledger/consequential-action.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const ACTION_CLASSES = [
  "send",
  "contact",
  "money",
  "publish",
  "delete",
  "purchase",
  "host_file",
  "network_egress",
  "browser_submit",
  "schedule_script",
  "external_runner",
  "other",
] as const;

const OUTCOMES = ["executed", "parked", "denied", "failed"] as const;

const entrySchema = z.object({
  id: z.string(),
  at: z.number().int().describe("Epoch ms the action settled"),
  toolName: z.string().describe("The tool as invoked, namespace included"),
  actionClass: z.enum(ACTION_CLASSES),
  summary: z
    .string()
    .describe(
      "One plain-English sentence: what Cue did, to what, and whether anyone was watching",
    ),
  target: z
    .string()
    .nullable()
    .describe("Recipient / URL / host / path reached; null = none in the input"),
  outcome: z.enum(OUTCOMES),
  attended: z
    .number()
    .int()
    .describe("0/1 — a human was present (interactive client attached)"),
  approvedVia: z
    .enum(["inline_card", "trust_rule", "scoped_grant", "auto"])
    .nullable()
    .describe(
      "How an EXECUTED action was authorised. 'auto' = nobody was asked. Null on parked/denied/failed rows — nothing was authorised.",
    ),
  approvalDetail: z.string().nullable(),
  conversationId: z.string().nullable(),
  workItemId: z
    .string()
    .nullable()
    .describe("Work item whose run this was, when the action ran inside one"),
  agent: z.string().nullable(),
  requestId: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  reason: z
    .string()
    .nullable()
    .describe("Denial or failure reason, redacted; null when it ran cleanly"),
});

const summarySchema = z.object({
  total: z.number().int(),
  executed: z.number().int(),
  parked: z.number().int(),
  denied: z.number().int(),
  failed: z.number().int(),
  executedUnattended: z
    .number()
    .int()
    .describe("Consequential actions that ran with NO human present"),
  executedWithoutApproval: z
    .number()
    .int()
    .describe(
      "Executed actions nobody explicitly approved (approvedVia 'auto' or null)",
    ),
  byClass: z.array(
    z.object({ actionClass: z.enum(ACTION_CLASSES), count: z.number().int() }),
  ),
});

const responseSchema = z.object({
  entries: z.array(entrySchema),
  summary: summarySchema,
  window: z.object({ days: z.number().int(), from: z.number().int() }),
});

function parsePositiveInt(raw: unknown, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new BadRequestError(`Expected a positive number, got: ${String(raw)}`);
  }
  return Math.floor(value);
}

function parseEnum<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  label: string,
): T | undefined {
  if (raw == null || raw === "") return undefined;
  const value = String(raw);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new BadRequestError(
      `Unknown ${label}: ${value}. Expected one of ${allowed.join(", ")}.`,
    );
  }
  return value as T;
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getAutonomyLedger",
    endpoint: "ledger/autonomy",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "The autonomy ledger — consequential actions Cue took",
    description:
      "Append-only record of every consequential action Cue attempted on the owner's behalf (external send/call/money/publish/delete/purchase, network-egress shells, browser submit controls, script-mode schedules, opaque external runners, host file mutations), whatever the outcome. Each row carries a plain-English sentence, the target reached, whether a human was present, and how it was authorised. The summary's headline numbers are executedUnattended and executedWithoutApproval.",
    tags: ["guardrails"],
    queryParams: [
      {
        name: "days",
        description: "Trailing window in days for the summary (default 30)",
        schema: { type: "integer" },
      },
      {
        name: "limit",
        description: "Max rows returned, newest first (default 50, max 500)",
        schema: { type: "integer" },
      },
      {
        name: "outcome",
        description: "Filter to one outcome",
        schema: { type: "string", enum: [...OUTCOMES] },
      },
      {
        name: "actionClass",
        description: "Filter to one consequence class",
        schema: { type: "string", enum: [...ACTION_CLASSES] },
      },
      {
        name: "unattendedOnly",
        description:
          "'true' restricts to actions that happened with no human present",
        schema: { type: "string" },
      },
    ],
    responseBody: responseSchema,
    handler: ({ queryParams }) => {
      const days = parsePositiveInt(queryParams?.days, 30);
      const limit = parsePositiveInt(queryParams?.limit, 50);
      const from = Date.now() - days * 24 * 60 * 60 * 1000;

      const options: ListLedgerOptions = {
        limit,
        since: from,
        outcome: parseEnum(queryParams?.outcome, OUTCOMES, "outcome"),
        actionClass: parseEnum(
          queryParams?.actionClass,
          ACTION_CLASSES,
          "actionClass",
        ) as ConsequentialActionClass | undefined,
        unattendedOnly: queryParams?.unattendedOnly === "true",
      };

      return {
        entries: listAutonomyLedger(options),
        summary: getAutonomyLedgerSummary({ days }),
        window: { days, from },
      };
    },
  },
];
