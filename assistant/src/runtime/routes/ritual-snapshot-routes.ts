/**
 * The archive's data source — `GET rituals/snapshots`.
 *
 * Read-only, and read-only in the strong sense: it never composes anything.
 * Every row it returns was written by `rituals/ritual-snapshot-job.ts` at the
 * moment that ritual was composed, which is what makes a dated heading here
 * mean what it says. Opening "Tuesday" returns Tuesday's figures or returns
 * nothing; it never recomputes today's numbers under an old date.
 *
 * `storeStartedAt` is the second half of the contract and the reason this is
 * one call rather than two. An empty list is ambiguous — it could mean "the
 * rituals never ran" — so the response also says how far back the log itself
 * goes. The client turns that into design's line: *"Cue only started keeping
 * these today. Earlier briefs weren't saved — they went out and weren't
 * written down."* Null means nothing has been kept yet at all.
 */

import { z } from "zod";

import {
  getRitualSnapshotStoreStartedAt,
  isRitualKind,
  listRitualSnapshots,
} from "../../rituals/ritual-snapshot-store.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

const snapshotSchema = z.object({
  id: z.string(),
  ritual: z.enum(["brief", "weekly"]),
  periodKey: z
    .string()
    .describe("The period the snapshot IS: '2026-08-17' or '2026-W33'"),
  periodStart: z
    .number()
    .int()
    .describe("Epoch ms — start of the span covered"),
  periodEnd: z.number().int().describe("Epoch ms — end of the span covered"),
  composedAt: z.number().int().describe("Epoch ms the ritual was composed"),
  headline: z
    .string()
    .describe("The sentence as composed from the figures at the time"),
  facts: z
    .record(z.string(), z.unknown())
    .describe(
      "The ritual's own figures — done/review/needsYou/dayEntries for a brief, moved/slipped for a weekly",
    ),
});

const listResponseSchema = z.object({
  snapshots: z.array(snapshotSchema),
  storeStartedAt: z
    .number()
    .int()
    .nullable()
    .describe(
      "Epoch ms of the oldest snapshot kept; null when nothing has been kept yet. The archive states the absence from this rather than implying the rituals never ran.",
    ),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listRitualSnapshots",
    endpoint: "rituals/snapshots",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List kept morning briefs and weekly reviews",
    description:
      "Newest-first archive of what each ritual actually said, recorded when it was composed. Never recomputed: a period with no row has no row, and `storeStartedAt` says how far back the log goes so the absence can be stated rather than guessed at. No backfill exists — the store starts the day it was written.",
    tags: ["activity"],
    queryParams: [
      {
        name: "ritual",
        description: "Filter to one ritual: 'brief' or 'weekly'",
        schema: { type: "string" },
      },
      {
        name: "limit",
        description: "Max snapshots to return (default 60, cap 200)",
        schema: { type: "integer" },
      },
    ],
    responseBody: listResponseSchema,
    handler: ({ queryParams }) => {
      const rawRitual = queryParams?.ritual?.trim();
      const ritual =
        rawRitual && isRitualKind(rawRitual) ? rawRitual : undefined;
      const rawLimit = Number(queryParams?.limit);
      const limit = Number.isFinite(rawLimit) ? rawLimit : undefined;
      return {
        snapshots: listRitualSnapshots({ ritual, limit }),
        storeStartedAt: getRitualSnapshotStoreStartedAt(),
      };
    },
  },
];
