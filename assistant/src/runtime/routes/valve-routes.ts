/**
 * Routes for the volume valve — the control, the teaching, and the audit.
 *
 * The valve decides what INTERRUPTS. It does not decide what is kept: filtered
 * work stays in Work, queryable through the ordinary `work-items` routes,
 * counted in every census. Nothing here has a delete.
 *
 *   · `GET  hq/valve`            — where the valve is set, plus what that is
 *                                  currently costing: shown vs held, by band.
 *   · `PUT  hq/valve`            — move the global stop.
 *   · `PUT  hq/valve/missions/:missionId` — bump one mission while it is live.
 *   · `DELETE hq/valve/missions/:missionId` — drop that override.
 *   · `POST hq/valve/feedback`   — "not relevant" / "this mattered".
 *   · `GET  hq/valve/feedback`   — what those ✕'s have actually taught, and how
 *                                  many senders are demoted as a result.
 *   · `GET  hq/valve/health`     — the rule firing distribution, including the
 *                                  rules that have NEVER fired.
 *
 * That last one is not an optional extra. A safety floor in this daemon ran
 * for weeks with three of its four conditions dead, unnoticed because the
 * fourth over-fired; measured on production, `named_work` had never fired once
 * while `direct_human` accounted for 68 of one day's 93 keeps. Any set of
 * rules that cannot be counted will eventually be a set of rules that is
 * wrong in a way nobody can see.
 */

import { z } from "zod";

import {
  getMission,
  listMissionsWithRollups,
} from "../../missions/mission-store.js";
import {
  isValveStop,
  RULE_BANDS,
  VALVE_RULE_IDS,
  VALVE_STOPS,
  type ValveStop,
} from "../../valve/valve-bands.js";
import { applyValve, countByBand } from "../../valve/valve-filter.js";
import {
  clearStop,
  countRuleFirings,
  getGlobalStop,
  GLOBAL_SCOPE,
  LEARN_DOWN_THRESHOLD,
  learnedDownSenders,
  listFeedback,
  listStops,
  missionIdFromScope,
  missionScope,
  neverFiredRules,
  recordFeedback,
  setStop,
  type ValveSubjectKind,
} from "../../valve/valve-store.js";
import { listWorkItems } from "../../work-items/work-item-store.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const stopEnum = z.enum(["everything", "needs_you", "only_urgent"]);

const bandCountsSchema = z.object({
  urgent: z.number().int(),
  needs_you: z.number().int(),
  everything: z.number().int(),
});

const valveStateSchema = z.object({
  stop: stopEnum.describe(
    "Where the global valve is set. 'needs_you' is the default.",
  ),
  missionOverrides: z
    .array(
      z.object({
        missionId: z.string(),
        missionTitle: z.string().nullable(),
        stop: stopEnum,
        updatedAt: z.number().int(),
      }),
    )
    .describe(
      "Missions with their own stop. An override at 'everything' bumps that mission's work to the top band while it is live.",
    ),
  shown: z
    .number()
    .int()
    .describe("Open work items that interrupt at the current stop"),
  held: z
    .number()
    .int()
    .describe(
      "Open work items the valve is holding back. NOT hidden and NOT deleted — they are in Work, and each one carries the reason it is held. This is the tappable number.",
    ),
  unbanded: z
    .number()
    .int()
    .describe(
      "Of `shown`, how many are shown only because the valve has never sized them up. Items with no band are treated as urgent — that is the fail-open guarantee, so a high number here means the valve is doing less than it appears to, never more.",
    ),
  bands: bandCountsSchema.describe("All open work items by band"),
});

const healthSchema = z.object({
  windowHours: z.number().int(),
  since: z.number().int(),
  firings: z
    .array(
      z.object({
        ruleId: z.string(),
        band: z.string(),
        count: z.number().int(),
      }),
    )
    .describe("How often each rule fired in the window, biggest first"),
  neverFired: z
    .array(z.string())
    .describe(
      "Rules that exist in code and have NEVER fired, in the whole history of this instance. A rule here is either unreachable or mis-specified. This list is the check that a previous safety floor in this daemon never had.",
    ),
  knownRules: z
    .array(z.object({ ruleId: z.string(), band: z.string() }))
    .describe("Every rule the valve can fire, and the band it assigns"),
});

function parseWindowHours(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new BadRequestError("windowHours must be a positive number");
  }
  return n;
}

/**
 * The open work the valve governs.
 *
 * Terminal states are excluded because a done item does not interrupt anybody
 * — but note `archived` is excluded here and NOWHERE else: an auto-archived
 * item is still a row, still queryable, and still reversible. Excluding it
 * from the valve's own census is about counting, never about reach.
 */
function openWorkItems() {
  return listWorkItems().filter(
    (item) =>
      item.status !== "done" &&
      item.status !== "cancelled" &&
      item.status !== "archived",
  );
}

function readValveState(stopOverride?: ValveStop) {
  const stop = stopOverride ?? getGlobalStop();
  const items = openWorkItems();
  const result = applyValve(items, { stop });
  const overrides = listStops()
    .filter((row) => row.scope !== GLOBAL_SCOPE)
    .map((row) => {
      const missionId = missionIdFromScope(row.scope);
      return missionId
        ? {
            missionId,
            missionTitle: getMission(missionId)?.title ?? null,
            stop: row.stop,
            updatedAt: row.updatedAt,
          }
        : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  return {
    stop,
    missionOverrides: overrides,
    shown: result.shown.length,
    held: result.held.length,
    unbanded: result.unbandedCount,
    bands: countByBand([...result.shown, ...result.held]),
  };
}

function parseStop(value: unknown): ValveStop {
  if (!isValveStop(value)) {
    throw new BadRequestError(
      `stop must be one of ${VALVE_STOPS.join(", ")} (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getValve",
    endpoint: "hq/valve",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Where the volume valve is set, and what it is holding",
    description:
      "The valve decides what interrupts you, not what Cue keeps. `held` " +
      "items are in Work with a reason attached and are one stop-change away " +
      "from visible — the valve has no delete. Read `unbanded` alongside " +
      "`shown`: items the valve has never sized up are treated as urgent, so " +
      "a large `unbanded` means less filtering is happening than `shown` " +
      "suggests.",
    tags: ["hq", "valve"],
    queryParams: [
      {
        name: "stop",
        description:
          "Preview the counts at a different stop without changing anything.",
        schema: {
          type: "string",
          enum: ["everything", "needs_you", "only_urgent"],
        },
      },
    ],
    responseBody: valveStateSchema,
    handler: ({ queryParams }) => {
      const raw = queryParams?.stop;
      return readValveState(raw === undefined ? undefined : parseStop(raw));
    },
  },

  {
    operationId: "setValve",
    endpoint: "hq/valve",
    method: "PUT",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Move the volume valve",
    description:
      "Set the global stop. Takes effect on the next read with no " +
      "re-ingestion and no re-judging: the stop is compared against bands " +
      "that already exist, so moving it back restores exactly what was there. " +
      "Nothing is filed, archived or deleted as a side effect.",
    tags: ["hq", "valve"],
    requestBody: z.object({
      stop: stopEnum.describe(
        "'everything' = every open item interrupts. 'needs_you' (default) = " +
          "items Cue could not judge, work that names you, and anything " +
          "waiting on you. 'only_urgent' = only what Cue is blocked on, what " +
          "is due within a day, and people you know.",
      ),
    }),
    responseBody: valveStateSchema,
    handler: ({ body }) => {
      const stop = parseStop((body as { stop?: unknown } | undefined)?.stop);
      setStop(GLOBAL_SCOPE, stop, "user");
      return readValveState(stop);
    },
  },

  {
    operationId: "setMissionValve",
    endpoint: "hq/valve/missions/:missionId",
    method: "PUT",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Turn one mission up while it is live",
    description:
      "Give one mission its own stop. An override at 'everything' lifts that " +
      "mission's work to the top band, ahead of every quieting rule — so a " +
      "hot mission's traffic reaches you even from senders you have " +
      "previously dismissed. The override is a preference, not a change to " +
      "any item; deleting it restores the global behaviour exactly.",
    tags: ["hq", "valve"],
    pathParams: [
      { name: "missionId", type: "uuid", description: "The mission id" },
    ],
    additionalResponses: { "404": { description: "No such mission" } },
    requestBody: z.object({ stop: stopEnum }),
    responseBody: valveStateSchema,
    handler: ({ pathParams, body }) => {
      const missionId = pathParams!.missionId;
      if (!getMission(missionId)) {
        throw new NotFoundError(`No mission ${missionId}`);
      }
      const stop = parseStop((body as { stop?: unknown } | undefined)?.stop);
      setStop(missionScope(missionId), stop, "user");
      return readValveState();
    },
  },

  {
    operationId: "clearMissionValve",
    endpoint: "hq/valve/missions/:missionId",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Drop a mission's override",
    description:
      "The mission follows the global stop again. This deletes a preference " +
      "row and nothing else — no work item is touched.",
    tags: ["hq", "valve"],
    pathParams: [
      { name: "missionId", type: "uuid", description: "The mission id" },
    ],
    responseBody: valveStateSchema,
    handler: ({ pathParams }) => {
      clearStop(missionScope(pathParams!.missionId));
      return readValveState();
    },
  },

  {
    operationId: "recordValveFeedback",
    endpoint: "hq/valve/feedback",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Teach the valve",
    description:
      "The ✕ / 'not relevant' signal, and its opposite. Two dismissals of " +
      "the same sender with no intervening action quiets them to the " +
      "'everything' stop — quiets, never deletes, and never for a sender " +
      "whose mail Cue could not judge. One dismissal is deliberately not " +
      "enough: a single ✕ is as likely to mean 'dealt with it'. Both counts " +
      "are kept, so saying 'this mattered' about a sender you previously " +
      "dismissed genuinely undoes it rather than being merely absent.",
    tags: ["hq", "valve"],
    requestBody: z.object({
      subjectKind: z
        .enum(["sender", "channel", "rule"])
        .describe("What is being corrected. 'sender' is the learning key."),
      subjectKey: z
        .string()
        .min(1)
        .describe("The lowercased sender address, channel key or rule id"),
      signal: z
        .enum(["dismissed", "kept"])
        .describe(
          "'dismissed' = not relevant, quiet this. 'kept' = this mattered, and it counts against any dismissals already recorded.",
        ),
    }),
    responseBody: z.object({
      taught: z.array(
        z.object({
          subjectKind: z.string(),
          subjectKey: z.string(),
          dismissed: z.number().int(),
          kept: z.number().int(),
          lastSignalAt: z.number().int(),
        }),
      ),
    }),
    handler: ({ body }) => {
      const input = body as
        | { subjectKind?: unknown; subjectKey?: unknown; signal?: unknown }
        | undefined;
      const kinds = ["sender", "channel", "rule"];
      if (
        typeof input?.subjectKind !== "string" ||
        !kinds.includes(input.subjectKind)
      ) {
        throw new BadRequestError(
          `subjectKind must be one of ${kinds.join(", ")}`,
        );
      }
      if (typeof input.subjectKey !== "string" || !input.subjectKey.trim()) {
        throw new BadRequestError("subjectKey is required");
      }
      if (input.signal !== "dismissed" && input.signal !== "kept") {
        throw new BadRequestError('signal must be "dismissed" or "kept"');
      }
      recordFeedback(
        input.subjectKind as ValveSubjectKind,
        input.subjectKey,
        input.signal,
      );
      return { taught: listFeedback(50) };
    },
  },

  {
    operationId: "getValveTeaching",
    endpoint: "hq/valve/feedback",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "What the ✕ has taught the valve",
    description:
      "The read half of `POST hq/valve/feedback`, so a policy surface can " +
      "state what the dismissals have actually achieved without recording a " +
      "dismissal to find out. `demotedSenders` is the count the banding rules " +
      "genuinely use — the same `learnedDownSenders()` set, i.e. senders over " +
      "the threshold whose dismissals still outnumber their keeps — not the " +
      "length of the taught list, which includes subjects that were corrected " +
      "once and subjects the owner has since taken back.",
    tags: ["hq", "valve"],
    responseBody: z.object({
      demotedSenders: z
        .number()
        .int()
        .describe(
          "Senders the valve is currently quieting because of the ✕. This is the number a surface may claim as a result.",
        ),
      threshold: z
        .number()
        .int()
        .describe(
          "Dismissals of one sender required before anything is quieted. One ✕ is deliberately not enough.",
        ),
      taught: z
        .array(
          z.object({
            subjectKind: z.string(),
            subjectKey: z.string(),
            dismissed: z.number().int(),
            kept: z.number().int(),
            lastSignalAt: z.number().int(),
          }),
        )
        .describe(
          "Every subject carrying a signal, most-dismissed first. Both counts are kept, so a sender taken back reads differently from one never corrected.",
        ),
    }),
    handler: () => ({
      demotedSenders: learnedDownSenders().size,
      threshold: LEARN_DOWN_THRESHOLD,
      taught: listFeedback(50),
    }),
  },

  {
    operationId: "getValveHealth",
    endpoint: "hq/valve/health",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Which valve rules actually fire",
    description:
      "The firing distribution, and — the important half — `neverFired`: " +
      "rules that exist in code and have never once fired on this instance. " +
      "A rule that has never fired is unreachable or mis-specified, and " +
      "reading this list is how you find out before it matters. The previous " +
      "arrival safety floor in this daemon ran with three of its four " +
      "conditions dead for weeks because nothing exposed this.",
    tags: ["hq", "valve"],
    queryParams: [
      {
        name: "windowHours",
        description: "Window for `firings` (default 168, i.e. one week)",
        schema: { type: "number" },
      },
    ],
    responseBody: healthSchema,
    handler: ({ queryParams }) => {
      const windowHours = parseWindowHours(queryParams?.windowHours, 168);
      const since = Date.now() - windowHours * 3_600_000;
      return {
        windowHours: Math.round(windowHours),
        since,
        firings: countRuleFirings(since),
        // Deliberately over ALL time, not the window: a rule that fired once
        // in March and never again is a different problem from one that has
        // never worked, and conflating them hides the second.
        neverFired: neverFiredRules(VALVE_RULE_IDS),
        knownRules: VALVE_RULE_IDS.map((ruleId) => ({
          ruleId,
          band: RULE_BANDS[ruleId],
        })),
      };
    },
  },
];

/** Exported for tests: the missions a client can offer an override for. */
export function overridableMissions() {
  return listMissionsWithRollups({ status: "active" });
}
