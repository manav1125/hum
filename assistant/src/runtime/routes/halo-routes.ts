/**
 * The Day, over HTTP — what the native frames draw from.
 *
 * Shapes here follow `docs/design/halo/` rather than the tables, because the
 * frames are the contract: the cover needs its sync pill, its counts and its
 * verdict in one read; the arc needs episodes and absences together, since a
 * day drawn without its gaps is a day with something quietly filled in.
 *
 * Three rules the responses keep, each of them a promise printed on screen:
 *
 *  · **The lag number is real or absent, never faked.** `behindSeconds` is
 *    null when nothing has ever arrived, and the surface renders that state
 *    rather than printing a zero it made up.
 *  · **Absences are returned, with their reason.** `not_worn`, `battery`,
 *    `off_the_record` and `forgotten` come back distinct, because the arc
 *    draws all four differently and inferring between them is forbidden.
 *  · **Nothing here files anything.** Accept is the only route that creates
 *    work, and it does so through `halo-accept.ts`, the single module in the
 *    feature holding a work-item writer.
 */

import { z } from "zod";

import {
  acceptHaloProposal,
  dismissHaloProposal,
} from "../../halo/halo-accept.js";
import {
  ensureDay,
  getDay,
  listEpisodesForDay,
  listGapsForDay,
  listMarksForDay,
  listOpenProposals,
  localDateOf,
  readLag,
  readTrustLedger,
  recordMark,
} from "../../halo/halo-store.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("halo-routes");

/** `YYYY-MM-DD`, and nothing that could be a path. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * The sync pill, in the three shapes the card is allowed to show:
 * "up to date" · "synced to N min ago" · "N min behind".
 *
 * The shape is chosen here rather than in the client so every surface — card,
 * Island, Day cover, watch — says the same thing about the same number.
 */
function syncPill(behindSeconds: number | null) {
  if (behindSeconds === null)
    return { state: "unknown" as const, behindSeconds: null };
  if (behindSeconds <= 90)
    return { state: "up_to_date" as const, behindSeconds };
  return { state: "behind" as const, behindSeconds };
}

function handleDay({ pathParams }: RouteHandlerArgs) {
  const localDate = pathParams?.date;
  if (!localDate || !DATE_SHAPE.test(localDate)) {
    throw new BadRequestError("date must be YYYY-MM-DD");
  }

  const day = getDay(localDate);
  if (!day) throw new NotFoundError(`No day for ${localDate}`);

  const episodes = listEpisodesForDay(day.id);
  const marks = listMarksForDay(day.id);
  const gaps = listGapsForDay(day.id);
  const lag = readLag();

  return {
    date: day.localDate,
    verdict: day.verdict,
    // The scope that qualifies every count below it. A five-hour day's
    // verdict must never read as though it covered fourteen.
    heardSeconds: day.heardSeconds,
    wornSeconds: day.wornSeconds,
    firstHeardAt: day.firstHeardAt,
    lastHeardAt: day.lastHeardAt,
    closedAt: day.closedAt,
    sync: { ...syncPill(lag.behindSeconds), snippet: lag.snippet },
    counts: {
      conversations: episodes.length,
      marks: marks.length,
      places: new Set(
        episodes.map((e) => e.placeLabel).filter((p): p is string => !!p),
      ).size,
    },
    episodes: episodes.map((episode) => ({
      id: episode.id,
      chapterIndex: episode.chapterIndex,
      startedAt: episode.startedAt,
      endedAt: episode.endedAt,
      placeLabel: episode.placeLabel,
      title: episode.title,
      summary: episode.summary,
      pullQuote: episode.pullQuote,
      pullQuoteSpeaker: episode.pullQuoteSpeaker,
      keyTakeaways: parseJson(episode.keyTakeaways, []),
      participants: parseJson(episode.participants, []),
      template: episode.template,
      boundaryReason: episode.boundaryReason,
      // The ⚑ is the loudest element on the Day, so it is attached to its
      // chapter rather than left for the client to correlate by timestamp.
      marks: marks
        .filter((m) => m.episodeId === episode.id)
        .map((m) => ({
          id: m.id,
          kind: m.kind,
          markedAt: m.markedAt,
          words: m.words,
        })),
    })),
    /** Absences, each with the reason the arc draws it by. Never inferred. */
    gaps: gaps.map((gap) => ({
      id: gap.id,
      startedAt: gap.startedAt,
      endedAt: gap.endedAt,
      reason: gap.reason,
      caption: gap.caption,
    })),
  };
}

function handleToday() {
  return handleDay({
    pathParams: { date: localDateOf(Date.now()) },
  } as RouteHandlerArgs);
}

/** The card and the Island: state small enough to poll. */
function handleStatus() {
  const lag = readLag();
  return {
    sync: { ...syncPill(lag.behindSeconds), snippet: lag.snippet },
    coveredThrough: lag.coveredThrough,
    ledger: readTrustLedger(),
  };
}

/** F2's queue — confident first, the unsure fold below. */
function handleQueue({ queryParams }: RouteHandlerArgs) {
  const limit = Number(queryParams?.limit ?? 50);
  const proposals = listOpenProposals(
    Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50,
  );
  return {
    proposals: proposals.map((p) => ({
      id: p.id,
      title: p.title,
      owner: p.owner,
      verb: p.verb,
      destinationLabel: p.destinationLabel,
      confidenceTier: p.confidenceTier,
      episodeId: p.episodeId,
      // The ◉ heard pill, whole, as it renders under the item.
      heard: {
        quote: p.heardQuote,
        at: p.heardAt,
        place: p.heardPlace,
        speaker: p.heardSpeaker,
      },
    })),
    /** "34 accepted · 7 dismissed · Cue is learning your bar". */
    ledger: readTrustLedger(),
  };
}

async function handleAccept({ body }: RouteHandlerArgs) {
  const proposalId = body?.proposalId;
  if (typeof proposalId !== "string" || !proposalId) {
    throw new BadRequestError("proposalId is required");
  }
  const outcome = await acceptHaloProposal(proposalId);
  if (outcome.status === "not_found") {
    throw new NotFoundError(`No proposal ${proposalId}`);
  }
  return outcome;
}

function handleDismiss({ body }: RouteHandlerArgs) {
  const proposalId = body?.proposalId;
  if (typeof proposalId !== "string" || !proposalId) {
    throw new BadRequestError("proposalId is required");
  }
  const outcome = dismissHaloProposal(proposalId);
  if (outcome.status === "not_found") {
    throw new NotFoundError(`No proposal ${proposalId}`);
  }
  return outcome;
}

/**
 * A ⚑ or ✦ from the device.
 *
 * Accepts the mark before any audio for it has arrived — the BLE event lands
 * in a second, the segment it happened inside can take a minute, and the
 * design's whole promise about the button is that pressing it registers. The
 * segmentation pass attaches it to a chapter afterwards.
 */
function handleMark({ body }: RouteHandlerArgs) {
  const markedAt = Number(body?.markedAt ?? Date.now());
  if (!Number.isFinite(markedAt)) {
    throw new BadRequestError("markedAt must be an epoch-ms number");
  }
  const kind = body?.kind === "note" ? "note" : "bookmark";
  const words = typeof body?.words === "string" ? body.words : null;

  const dayId = ensureDay(localDateOf(markedAt));
  const id = recordMark({ dayId, markedAt, kind, words });
  log.info({ id, kind, markedAt }, "Halo mark recorded");
  return { id, kind, markedAt };
}

const HEARD_SHAPE = z.object({
  quote: z.string().nullable(),
  at: z.number().nullable(),
  place: z.string().nullable(),
  speaker: z.string().nullable(),
});

const SYNC_SHAPE = z.object({
  state: z.string().describe("unknown | up_to_date | behind"),
  behindSeconds: z
    .number()
    .nullable()
    .describe("Null when nothing has arrived — render the state, never a 0"),
  snippet: z.string().nullable(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "haloStatus",
    endpoint: "halo/status",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Halo sync state and trust ledger",
    description:
      "The card and Island read: how far behind the room Cue is, the last synced snippet, and the accepted/dismissed counts.",
    tags: ["halo"],
    responseBody: z.object({
      sync: SYNC_SHAPE,
      coveredThrough: z.number().nullable(),
      ledger: z.object({
        proposed: z.number(),
        accepted: z.number(),
        dismissed: z.number(),
      }),
    }),
    handler: handleStatus,
  },
  {
    operationId: "haloToday",
    endpoint: "halo/today",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Today's Day",
    description: "The Day cover for the owner's current local date.",
    tags: ["halo"],
    handler: handleToday,
  },
  {
    operationId: "haloDay",
    endpoint: "halo/days/:date",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "One Day, with its chapters and its absences",
    description:
      "Everything the Day cover and its arc draw: verdict, counts, episodes with their marks and takeaways, and the gaps with the reason each is drawn by.",
    tags: ["halo"],
    pathParams: [{ name: "date", description: "Local date, YYYY-MM-DD" }],
    handler: handleDay,
  },
  {
    operationId: "haloQueue",
    endpoint: "halo/proposals",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Open proposals, confident before the fold",
    description:
      "The 'From your days' queue. Each item carries its ◉ heard provenance and the destination its accept chip names.",
    tags: ["halo"],
    queryParams: [
      { name: "limit", description: "Max items (1–200, default 50)" },
    ],
    responseBody: z.object({
      proposals: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          owner: z.string().nullable(),
          verb: z.string(),
          destinationLabel: z.string().nullable(),
          confidenceTier: z.string(),
          episodeId: z.string().nullable(),
          heard: HEARD_SHAPE,
        }),
      ),
      ledger: z.object({
        proposed: z.number(),
        accepted: z.number(),
        dismissed: z.number(),
      }),
    }),
    handler: handleQueue,
  },
  {
    operationId: "haloAcceptProposal",
    endpoint: "halo/proposals/accept",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Accept a proposal (the ✓)",
    description:
      "The only route that turns a Halo proposal into work. Files it parked, carrying the ◉ heard pill onto the work item. Idempotent — a double-tap returns the first work item.",
    tags: ["halo"],
    requestBody: z.object({ proposalId: z.string() }),
    handler: handleAccept,
  },
  {
    operationId: "haloDismissProposal",
    endpoint: "halo/proposals/dismiss",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Dismiss a proposal (the ✕)",
    description:
      "Records the dismissal rather than dropping it — the queue's trust ledger is how ✕ teaches.",
    tags: ["halo"],
    requestBody: z.object({ proposalId: z.string() }),
    handler: handleDismiss,
  },
  {
    operationId: "haloMark",
    endpoint: "halo/marks",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Record a ⚑ bookmark or ✦ note from the device",
    description:
      "Accepted before the audio around it has arrived; segmentation attaches it to a chapter later. The button registering is the promise.",
    tags: ["halo"],
    requestBody: z.object({
      markedAt: z.number().optional().describe("Epoch ms; defaults to now"),
      kind: z.string().optional().describe("bookmark (default) | note"),
      words: z.string().optional().describe("What was being said, verbatim"),
    }),
    responseBody: z.object({
      id: z.string(),
      kind: z.string(),
      markedAt: z.number(),
    }),
    handler: handleMark,
  },
];
