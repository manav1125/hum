/**
 * Routes for comprehension and grouping — what Cue understood a work item to
 * be, what it combined into it, and how to take that back.
 *
 *   · `GET work-items/:id/comprehension` — the structured reading of the item:
 *     the verb-phrase title, any deadline / amount / asker that was genuinely
 *     in the message, and — when comprehension did NOT happen — the status and
 *     plain-words reason. A client can tell "Cue read this" from "Cue left the
 *     subject line alone" without guessing, which is the whole point of
 *     persisting failures.
 *   · `GET work-items/:id/group` — every message folded into the item,
 *     including the one that created it and including ones already split back
 *     out. A merge nobody can inspect is not trustworthy.
 *   · `POST arrival-groups/:memberId/ungroup` — split one message back out
 *     into its own work item. Nothing is deleted: the member row is stamped
 *     with when and by whom, and gains the id of the item it became.
 *   · `GET arrivals/comprehension/health` — the census plus the consecutive-
 *     barren-batch streak, so "comprehending nothing" is a number somebody can
 *     look at rather than a silence that reads like success.
 *
 * There is no route that merges two items by hand and none that deletes a
 * member row. Grouping is decided at intake off a thread id or an exact
 * sender, and un-grouping is the only correction offered — a merge that can be
 * created from the outside on fuzzier evidence is the failure mode this whole
 * area is written to avoid.
 */

import { z } from "zod";

import {
  getComprehensionHealth,
  UNPRODUCTIVE_BATCH_WARN_AT,
} from "../../arrivals/arrival-comprehension.js";
import {
  getGroupSummary,
  ungroupGroupMember,
} from "../../arrivals/arrival-grouping.js";
import { getArrival } from "../../arrivals/arrival-store.js";
import {
  getComprehension,
  getComprehensionCensus,
} from "../../arrivals/comprehension-store.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import { getWorkItem } from "../../work-items/work-item-store.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { ConflictError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";
import { annotateWorkItems, workItemSchema } from "./work-items-routes.js";

const comprehensionSchema = z.object({
  workItemId: z.string(),
  arrivalId: z.string().nullable(),
  status: z
    .enum(["comprehended", "low_confidence", "failed", "skipped"])
    .describe(
      "'comprehended' = the title now says what you must do. 'low_confidence' = Cue answered but not well enough to trust, so your original title stands. 'failed' = no usable answer at all. 'skipped' = comprehension was off, or the item changed while Cue was reading it. Anything but 'comprehended' means the title you see is the original subject line.",
    ),
  originalTitle: z
    .string()
    .describe("What the item was called before anything touched it"),
  actionTitle: z.string().nullable(),
  dueAt: z
    .number()
    .int()
    .nullable()
    .describe(
      "A deadline READ FROM the message, epoch ms. Null means the message did not state one — never a default, never inferred from urgency.",
    ),
  dueQuote: z
    .string()
    .nullable()
    .describe("The literal words the deadline was read from, so you can check"),
  amountText: z.string().nullable().describe("The amount as written"),
  askedBy: z.string().nullable().describe("Who is asking, as written"),
  decisionNeeded: z
    .string()
    .nullable()
    .describe("One line naming the decision the message wants from you"),
  confidence: z.number().nullable(),
  note: z
    .string()
    .nullable()
    .describe(
      "Plain-words reason, set whenever the status is not 'comprehended'",
    ),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const groupMemberSchema = z.object({
  id: z.string(),
  workItemId: z.string(),
  groupKey: z.string(),
  groupKind: z
    .enum(["thread", "sender"])
    .describe(
      "'thread' = the provider says these are one conversation. 'sender' = repeat notifications from one automated sender. Nothing is ever grouped on topic similarity.",
    ),
  channel: z.string(),
  arrivalId: z.string(),
  externalId: z.string(),
  title: z.string().describe("What arrived, verbatim"),
  snippet: z.string().nullable(),
  senderAddress: z.string().nullable(),
  isAnchor: z
    .number()
    .int()
    .describe("1 = the message that created the work item"),
  receivedAt: z.number().int(),
  detachedAt: z
    .number()
    .int()
    .nullable()
    .describe("Epoch ms you split this back out. Null = still grouped."),
  detachedBy: z.string().nullable(),
  detachedWorkItemId: z.string().nullable(),
  createdAt: z.number().int(),
});

const groupSummarySchema = z.object({
  workItemId: z.string(),
  count: z
    .number()
    .int()
    .describe(
      "Messages currently folded in, the original included. 1 = nothing was combined.",
    ),
  groupKind: z.enum(["thread", "sender"]).nullable(),
  groupKey: z.string().nullable(),
  members: z
    .array(groupMemberSchema)
    .describe(
      "Every message ever folded in, oldest first — split-out ones included, because a group whose history is tidied up cannot be audited.",
    ),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getWorkItemComprehension",
    endpoint: "work-items/:id/comprehension",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "What Cue understood this item to be",
    description:
      "The structured reading behind a work item that arrived from a watcher: " +
      "the action title, and any deadline, amount or asker that was genuinely " +
      "present in the message. Every extracted fact had to be quoted from the " +
      "message and that quote found in it, so a null field means the message " +
      "did not say — not that Cue forgot to look. 404 when the item was never " +
      "read (it did not arrive through a watcher, or it predates this).",
    tags: ["work-items"],
    pathParams: [{ name: "id", type: "uuid", description: "The work item id" }],
    additionalResponses: {
      "404": { description: "No comprehension record for that work item" },
    },
    responseBody: z.object({ comprehension: comprehensionSchema }),
    handler: ({ pathParams }) => {
      const comprehension = getComprehension(pathParams!.id);
      if (!comprehension) {
        throw new NotFoundError(
          `No comprehension record for work item ${pathParams!.id}`,
        );
      }
      return { comprehension };
    },
  },

  {
    operationId: "getWorkItemGroup",
    endpoint: "work-items/:id/group",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "What was combined into this item",
    description:
      "The messages folded into one work item — later replies in the same " +
      "conversation, or repeat notifications from the same automated sender. " +
      "`count` is what a card should show and is derived from the live rows, " +
      "not from a stored total. An item that never grouped returns count 1 " +
      "(or 0, when it did not arrive through a watcher) and an empty list.",
    tags: ["work-items"],
    pathParams: [{ name: "id", type: "uuid", description: "The work item id" }],
    additionalResponses: { "404": { description: "No such work item" } },
    responseBody: z.object({ group: groupSummarySchema }),
    handler: ({ pathParams }) => {
      const item = getWorkItem(pathParams!.id);
      if (!item) throw new NotFoundError(`No work item ${pathParams!.id}`);
      return { group: getGroupSummary(item.id) };
    },
  },

  {
    operationId: "ungroupArrivalGroupMember",
    endpoint: "arrival-groups/:memberId/ungroup",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Split a combined message back out",
    description:
      "Say two things Cue combined are not the same thing. The message becomes " +
      "its own work item, minted exactly as if it had never been grouped. " +
      "Nothing is deleted: the group row keeps its history and records when " +
      "you split it and what it became. The original message that created the " +
      "item cannot be split out — it IS the item — and returns 409.",
    tags: ["work-items"],
    pathParams: [
      { name: "memberId", type: "uuid", description: "The group member id" },
    ],
    additionalResponses: {
      "404": { description: "No such group member" },
      "409": {
        description:
          "Already split out, the anchor message, or its arrival is missing",
      },
    },
    responseBody: z.object({
      member: groupMemberSchema,
      workItem: workItemSchema,
    }),
    handler: ({ pathParams }) => {
      const result = ungroupGroupMember(pathParams!.memberId, {
        getArrival,
        actor: "user",
      });
      switch (result.status) {
        case "not_found":
          throw new NotFoundError(`No group member ${pathParams!.memberId}`);
        case "already_detached":
          throw new ConflictError(
            "That message is already on its own — nothing to split.",
            { code: "already_detached" },
          );
        case "is_anchor":
          throw new ConflictError(
            "That is the message this item was created from, so there is nothing to split it out of. Split the others out instead.",
            { code: "is_anchor" },
          );
        case "arrival_missing":
          throw new ConflictError(
            "The record of what arrived is missing, so Cue cannot rebuild the item honestly.",
            { code: "arrival_missing" },
          );
        default: {
          void assistantEventHub.publish(
            buildAssistantEvent({ type: "tasks_changed" } as ServerMessage),
          );
          return {
            member: result.member,
            workItem: annotateWorkItems([result.workItem])[0],
          };
        }
      }
    },
  },

  {
    operationId: "getArrivalComprehensionHealth",
    endpoint: "arrivals/comprehension/health",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Is comprehension actually doing anything?",
    description:
      "The comprehended / low-confidence / failed census over a trailing " +
      "window, plus the number of consecutive batches that had work to do and " +
      "produced nothing. That streak exists because a silent no-op reads " +
      "exactly like an idle system: the auto-file sweep filed nothing for " +
      "twelve hours and the only symptom was 103 unfiled items. " +
      "`unproductiveWarnAt` is the streak length at which the daemon starts " +
      "saying so in its logs.",
    tags: ["arrivals"],
    queryParams: [
      {
        name: "windowHours",
        description: "Trailing window for the census (default 24)",
        schema: { type: "number" },
      },
    ],
    responseBody: z.object({
      census: z.object({
        since: z.number().int(),
        total: z.number().int(),
        withDeadline: z
          .number()
          .int()
          .describe("Items with a deadline actually found in the message"),
        byStatus: z.object({
          comprehended: z.number().int(),
          low_confidence: z.number().int(),
          failed: z.number().int(),
          skipped: z.number().int(),
        }),
      }),
      lastBatchAt: z.number().int().nullable(),
      lastBatchCandidates: z.number().int(),
      lastBatchComprehended: z.number().int(),
      consecutiveUnproductiveBatches: z.number().int(),
      unproductiveWarnAt: z.number().int(),
      totalBatches: z.number().int(),
      totalComprehended: z.number().int(),
    }),
    handler: ({ queryParams }) => {
      const raw = Number(queryParams?.windowHours);
      const windowHours = Number.isFinite(raw) && raw > 0 ? raw : 24;
      return {
        census: getComprehensionCensus(windowHours),
        ...getComprehensionHealth(),
        unproductiveWarnAt: UNPRODUCTIVE_BATCH_WARN_AT,
      };
    },
  },
];
