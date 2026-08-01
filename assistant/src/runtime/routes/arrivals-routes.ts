/**
 * Route handlers for arrivals — the record of everything a watcher saw and
 * what Cue decided about it.
 *
 * Four reads and one write, and between them they are what makes the filter
 * trustworthy rather than spooky:
 *
 *   · `GET arrivals/summary` — arrived / filed / kept over a window. `kept`
 *     means "Cue looked at it and decided you need to see it" and is counted
 *     off the disposition itself, NOT inferred from any filing-confidence
 *     field. Clients that inferred it from `autoFileConfidence` were reading a
 *     project-assignment signal and reporting it as relevance; delete that.
 *   · `GET arrivals` — the filed rows with their reasons ("Where it went ›").
 *   · `GET arrivals/:id` — one row, for the work-item back-link.
 *   · `POST arrivals/:id/reverse` — "this mattered": the filing is reversed,
 *     a normal Came-in work item is created, and the correction is recorded.
 *   · `GET arrivals/corrections` — senders the owner keeps correcting, which
 *     is the strongest learning signal available.
 *
 * Nothing here deletes anything. There is no delete route by design: "filed"
 * means recorded-and-findable, and a reversal appends to the original decision
 * rather than rewriting it.
 */

import { z } from "zod";

import {
  type ArrivalDisposition,
  getArrival,
  getArrivalsSummary,
  listArrivals,
  listCorrectedSenders,
  markArrivalReversed,
  MAX_ARRIVAL_PAGE,
} from "../../arrivals/arrival-store.js";
import { createWorkItemForArrival } from "../../arrivals/arrival-surface.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import { triageAndMaybeAutoRunWorkItem } from "../../work-items/work-item-triage.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";
import { annotateWorkItems, workItemSchema } from "./work-items-routes.js";

const arrivalSchema = z.object({
  id: z.string(),
  channel: z.string().describe("Where it arrived, e.g. 'watcher:gmail'"),
  externalId: z.string().describe("The provider's own id for the item"),
  watcherId: z.string().nullable(),
  eventId: z.string().nullable().describe("The originating watcher_events.id"),
  title: z.string(),
  senderAddress: z
    .string()
    .nullable()
    .describe(
      "Lowercased sender address. The learning key: repeated reversals for the same sender are the strongest correction signal.",
    ),
  senderName: z.string().nullable(),
  snippet: z.string().nullable(),
  sourceContext: z
    .string()
    .nullable()
    .describe("JSON provenance blob, mirrored onto the work item when kept"),
  disposition: z
    .enum(["surfaced", "filed"])
    .describe(
      "'surfaced' = Cue decided you need to see it, and a work item exists. 'filed' = recorded, browsable and reversible, but not in the Came-in lane.",
    ),
  reason: z
    .string()
    .nullable()
    .describe(
      'Why, in your words — "newsletter from Stripe", "automated build notification", "you\'re a direct recipient and it\'s from a person". Set for both dispositions. Never a score or a bare category code.',
    ),
  decidedBy: z
    .enum(["rule", "model", "floor", "playbook", "fallback", "user"])
    .describe(
      "What made the call: 'rule' = a deterministic header rule; 'model' = the flash judge; 'floor' = the safety floor overrode a file decision; 'playbook' = one of your playbooks claimed it; 'fallback' = the judge errored, timed out or was off, so it was kept (fail-open); 'user' = you reversed it.",
    ),
  ruleId: z
    .string()
    .nullable()
    .describe(
      "Which rule fired: 'list_mail' | 'precedence_bulk' | 'auto_submitted' for filings, 'known_contact' | 'thread_participant' | 'named_work' | 'direct_human' for safety-floor keeps.",
    ),
  confidence: z
    .number()
    .nullable()
    .describe("The judge's 0-1 confidence; null unless decidedBy is 'model'"),
  workItemId: z.string().nullable(),
  reversedAt: z
    .number()
    .int()
    .nullable()
    .describe(
      "Epoch ms you said this mattered. The original reason/ruleId/decidedBy are preserved, so a reversed row still shows what Cue originally thought.",
    ),
  reversedBy: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const summarySchema = z.object({
  since: z
    .number()
    .int()
    .describe("Inclusive lower bound of the window, epoch ms"),
  until: z.number().int().describe("When the summary was computed, epoch ms"),
  windowHours: z.number().int(),
  arrived: z
    .number()
    .int()
    .describe("Everything that arrived in the window. Always filed + kept."),
  filed: z
    .number()
    .int()
    .describe("Recorded and findable, but kept out of your lane"),
  kept: z
    .number()
    .int()
    .describe(
      "Cue looked at it and decided you need to see it. A count of surfaced arrivals — NOT inferred from autoFileConfidence or any other filing signal.",
    ),
  reversed: z
    .number()
    .int()
    .describe("Filed at arrival, then reversed by you. A subset of kept."),
  topFiledReasons: z
    .array(z.object({ reason: z.string(), count: z.number().int() }))
    .describe("Most common filing reasons in the window, biggest first"),
});

function parseWindowHours(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new BadRequestError(`windowHours must be a positive number`);
  }
  return n;
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getArrivalsSummary",
    endpoint: "arrivals/summary",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Arrived / filed / kept census",
    description:
      "How much came in over a trailing window and what Cue did with it. " +
      "`kept` is the honest number: it counts arrivals Cue looked at and " +
      "decided you need to see. It is NOT derived from autoFileConfidence — " +
      "that field means 'assigned to a project' and reading relevance out of " +
      "it overstates what the filter actually did.",
    tags: ["arrivals"],
    queryParams: [
      {
        name: "windowHours",
        description: "Trailing window in hours (default 24)",
        schema: { type: "number" },
      },
    ],
    responseBody: summarySchema,
    handler: ({ queryParams }) => {
      const windowHours = parseWindowHours(queryParams?.windowHours);
      return getArrivalsSummary(windowHours ? { windowHours } : {});
    },
  },

  {
    operationId: "listArrivalCorrections",
    endpoint: "arrivals/corrections",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Senders you keep correcting",
    description:
      "Senders whose filings you have reversed, most-corrected first. A " +
      "repeated correction for the same sender is the strongest signal there " +
      "is that Cue has the wrong idea about them. Nothing consumes this to " +
      "change behaviour yet — the data is being collected so a learning loop " +
      "does not have to start from zero.",
    tags: ["arrivals"],
    queryParams: [
      {
        name: "limit",
        description: "Max senders to return (default 20, cap 200)",
        schema: { type: "integer" },
      },
    ],
    responseBody: z.object({
      senders: z.array(
        z.object({
          senderAddress: z.string(),
          corrections: z.number().int(),
        }),
      ),
    }),
    handler: ({ queryParams }) => {
      const raw = Number(queryParams?.limit);
      const limit = Number.isFinite(raw)
        ? Math.min(MAX_ARRIVAL_PAGE, Math.max(1, raw))
        : 20;
      return { senders: listCorrectedSenders(limit) };
    },
  },

  {
    operationId: "listArrivals",
    endpoint: "arrivals",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List arrivals with their reasons",
    description:
      'Newest-first arrivals. `?disposition=filed` is the "Where it went ›" ' +
      "list: everything Cue kept out of your lane, each with the reason in " +
      "your words. Nothing is ever deleted, so this is a complete record.",
    tags: ["arrivals"],
    queryParams: [
      {
        name: "disposition",
        description:
          "Filter to one disposition. Omit for both. 'filed' backs \"Where it went ›\".",
        schema: { type: "string", enum: ["surfaced", "filed"] },
      },
      {
        name: "windowHours",
        description: "Only arrivals from the trailing N hours (default: all)",
        schema: { type: "number" },
      },
      {
        name: "limit",
        description: "Max rows to return (default 50, cap 200)",
        schema: { type: "integer" },
      },
    ],
    responseBody: z.object({ arrivals: z.array(arrivalSchema) }),
    handler: ({ queryParams }) => {
      const dispositionParam = queryParams?.disposition;
      if (
        dispositionParam !== undefined &&
        dispositionParam !== "surfaced" &&
        dispositionParam !== "filed"
      ) {
        throw new BadRequestError(
          `disposition must be "surfaced" or "filed" (got "${dispositionParam}")`,
        );
      }
      const disposition = dispositionParam as ArrivalDisposition | undefined;
      const windowHours = parseWindowHours(queryParams?.windowHours);
      const rawLimit = Number(queryParams?.limit);
      return {
        arrivals: listArrivals({
          ...(disposition ? { disposition } : {}),
          ...(windowHours
            ? { since: Date.now() - windowHours * 3_600_000 }
            : {}),
          ...(Number.isFinite(rawLimit) ? { limit: rawLimit } : {}),
        }),
      };
    },
  },

  {
    operationId: "getArrival",
    endpoint: "arrivals/:id",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get one arrival",
    description:
      "The row behind a work item's `arrivalId` — what arrived, what Cue " +
      "decided, and why.",
    tags: ["arrivals"],
    pathParams: [{ name: "id", type: "uuid", description: "The arrival id" }],
    additionalResponses: { "404": { description: "No such arrival" } },
    responseBody: z.object({ arrival: arrivalSchema }),
    handler: ({ pathParams }) => {
      const arrival = getArrival(pathParams!.id);
      if (!arrival) throw new NotFoundError(`No arrival ${pathParams!.id}`);
      return { arrival };
    },
  },

  {
    operationId: "reverseArrivalFiling",
    endpoint: "arrivals/:id/reverse",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Say a filed arrival mattered",
    description:
      "Reverse a filing: the arrival becomes a normal parked work item in " +
      "the Came-in lane, exactly as if Cue had surfaced it. The original " +
      "decision is preserved on the row (reason, ruleId, decidedBy) and the " +
      "reversal is stamped alongside it — that record is the correction " +
      "signal, so it is never overwritten. Already-surfaced arrivals return " +
      "409 rather than minting a duplicate work item.",
    tags: ["arrivals"],
    pathParams: [{ name: "id", type: "uuid", description: "The arrival id" }],
    additionalResponses: {
      "404": { description: "No such arrival" },
      "409": { description: "The arrival was already surfaced" },
    },
    responseBody: z.object({
      arrival: arrivalSchema,
      workItem: workItemSchema,
    }),
    handler: async ({ pathParams }) => {
      const id = pathParams!.id;
      const arrival = getArrival(id);
      if (!arrival) throw new NotFoundError(`No arrival ${id}`);
      if (arrival.disposition !== "filed") {
        throw new ConflictError(
          "That arrival is already in your lane — nothing to reverse.",
          { code: "already_surfaced" },
        );
      }

      const workItem = createWorkItemForArrival(arrival, {
        notes: `You said this mattered · originally filed as "${arrival.reason ?? "no reason recorded"}"`,
        actor: "user",
      });
      const updated = markArrivalReversed(id, workItem.id, "user");
      // Same enrichment the item would have got had the gate surfaced it, so
      // a reversed item is indistinguishable from a normally-kept one.
      await triageAndMaybeAutoRunWorkItem(workItem.id, { skipAutoRun: true });

      void assistantEventHub.publish(
        buildAssistantEvent({ type: "tasks_changed" } as ServerMessage),
      );
      return {
        arrival: updated ?? arrival,
        workItem: annotateWorkItems([workItem])[0],
      };
    },
  },
];
