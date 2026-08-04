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
import { localDate, zonedWallClockToMs } from "../../calendar/day-rail.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import { bandWorkItem } from "../../valve/valve-intake.js";
import { recordFeedback } from "../../valve/valve-store.js";
import {
  getWorkItem,
  updateWorkItem,
} from "../../work-items/work-item-store.js";
import { triageAndMaybeAutoRunWorkItem } from "../../work-items/work-item-triage.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { resolveRailTimeZone } from "./calendar-day-routes.js";
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
  windowHours: z
    .number()
    .int()
    .nullable()
    .describe(
      "The trailing window in hours. NULL whenever `bound` is not " +
        "'trailing_window' — the hours elapsed since a day boundary is not a " +
        "window anybody chose, and rounding it would hand you a number to " +
        "print that nobody asked for.",
    ),
  bound: z
    .enum(["trailing_window", "local_day", "explicit"])
    .describe(
      "What set `since`, and therefore what a label over these numbers may " +
        "say. 'trailing_window' = the last N hours ending now; the only " +
        "honest label is the window itself. 'local_day' = midnight-to-now in " +
        '`timeZone`; "today" is true of these numbers and only these. ' +
        "'explicit' = an instant you supplied, with no calendar meaning — say " +
        "nothing about the window rather than invent one. Clients must derive " +
        'their label from THIS field: a client that hardcodes "today" will ' +
        "keep saying it the day the parameter stops being honoured.",
    ),
  timeZone: z
    .string()
    .nullable()
    .describe(
      "The IANA zone the local day was resolved in. Null unless `bound` is " +
        "'local_day' — so \"today\" can always be shown to be somebody's today.",
    ),
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

/**
 * Resolve the `since` parameter into a lower bound, and — when it is a day
 * boundary — the zone that day belongs to.
 *
 * `since=today` is the whole reason this exists. "Today" is the owner's day,
 * not the daemon's: prod runs UTC, so a naive midnight here would move a
 * London evening's arrivals into tomorrow and an LA afternoon's into
 * yesterday. So the boundary is resolved through
 * {@link resolveRailTimeZone} — the SAME resolver the calendar day-strip uses
 * (`tz` param, else the owner's configured/detected zone, else the host's) —
 * and the same {@link zonedWallClockToMs} that converges across DST
 * transitions. There is deliberately no second notion of "today" in this
 * codebase: if the day-strip and the filed count ever disagree about which day
 * it is, that is one bug in one function, not two surfaces drifting.
 *
 * An epoch-ms value is also accepted, for callers that mean a specific
 * instant. It resolves with no timezone, so the response's `bound` comes back
 * `explicit` and no surface is tempted to call it a day.
 */
export function parseSince(
  raw: string | undefined,
  tz: string | undefined,
  nowMs: number,
): { since: number; timeZone?: string } | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const value = raw.trim();

  if (value.toLowerCase() === "today") {
    const timeZone = resolveRailTimeZone(tz);
    return {
      since: zonedWallClockToMs(localDate(nowMs, timeZone), 0, timeZone),
      timeZone,
    };
  }

  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new BadRequestError(
      `since must be "today" or a non-negative epoch-ms timestamp (got "${raw}")`,
    );
  }
  return { since: n };
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
      "How much came in over a window and what Cue did with it. " +
      "`kept` is the honest number: it counts arrivals Cue looked at and " +
      "decided you need to see. It is NOT derived from autoFileConfidence — " +
      "that field means 'assigned to a project' and reading relevance out of " +
      "it overstates what the filter actually did.\n\n" +
      "Bound it two ways. `windowHours` gives a trailing window ending now; " +
      "`since=today` gives midnight-to-now in YOUR timezone, which is what " +
      'lets a surface say "today" instead of "last 24h". `since` wins when ' +
      "both are sent. The response reports which bound it actually used in " +
      "`bound`, so a label can follow the data rather than a hope.",
    tags: ["arrivals"],
    queryParams: [
      {
        name: "windowHours",
        description:
          "Trailing window in hours (default 24). Ignored when `since` is set.",
        schema: { type: "number" },
      },
      {
        name: "since",
        description:
          'Lower bound. "today" = midnight-to-now in the timezone resolved ' +
          "from `tz` (the owner's day, not the daemon's — prod runs UTC). " +
          "Or a non-negative epoch-ms instant, which is reported as `bound: " +
          "'explicit'` because an arbitrary moment has no calendar name.",
        schema: { type: "string" },
      },
      {
        name: "tz",
        description:
          "IANA timezone the local day is resolved in when `since=today`. " +
          "Falls back to your configured/detected zone, then the daemon " +
          "host's. Clients that know their own zone should always send it. " +
          "Same parameter, same resolver, as `calendar/day`.",
        schema: { type: "string" },
      },
    ],
    responseBody: summarySchema,
    handler: ({ queryParams }) => {
      const windowHours = parseWindowHours(queryParams?.windowHours);
      const since = parseSince(queryParams?.since, queryParams?.tz, Date.now());
      return getArrivalsSummary({
        ...(windowHours ? { windowHours } : {}),
        ...(since ? { since: since.since } : {}),
        ...(since?.timeZone ? { timeZone: since.timeZone } : {}),
      });
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
      "409 rather than minting a duplicate work item. When the arrival " +
      "already points at a work item that still exists — a retro-filed row, " +
      "where an existing item was archived rather than never minted — that " +
      "original row is restored instead of a copy being made, so the " +
      "reversal returns the owner's item with its own history intact.",
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

      // A filed arrival normally has no work item — nothing was ever minted,
      // which is the whole point of filing at the boundary. The exception is
      // the retro run over the pre-gate backlog: those items already existed,
      // so they were archived and linked rather than created. Restoring the
      // original is what makes that filing genuinely reversible; minting a
      // copy would leave the owner with a duplicate and an archived original.
      const existing = arrival.workItemId
        ? getWorkItem(arrival.workItemId)
        : undefined;
      const workItem = existing
        ? (updateWorkItem(
            existing.id,
            {
              status: "queued",
              lastProgressNote: `You said this mattered · originally filed as "${arrival.reason ?? "no reason recorded"}"`,
            },
            { actor: "user" },
          ) ?? existing)
        : createWorkItemForArrival(arrival, {
            notes: `You said this mattered · originally filed as "${arrival.reason ?? "no reason recorded"}"`,
            actor: "user",
          });
      const updated = markArrivalReversed(id, workItem.id, "user");

      // Teach the valve, in the loud direction. A reversal is the owner going
      // into the filed pile by hand — the strongest evidence available that
      // this sender needs them — so it counts against any dismissals already
      // recorded for that address rather than merely being absent from them.
      if (arrival.senderAddress) {
        recordFeedback("sender", arrival.senderAddress, "kept");
      }
      // Re-band AFTER `markArrivalReversed`, not before: `owner_reversed`
      // reads `reversedAt`, which does not exist until the line above runs.
      // This also covers the restore branch, which never touches
      // `createWorkItemForArrival` and so was never banded at all.
      // The arrival is passed explicitly rather than looked up off the work
      // item: the restore branch reuses a pre-existing row whose `arrivalId`
      // may predate the link, and banding a reversal as though it had no
      // arrival would silently lose the `owner_reversed` rule.
      bandWorkItem(workItem, { arrival: updated ?? arrival });

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
