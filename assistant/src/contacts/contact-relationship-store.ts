/**
 * contact_relationship store — the materialized relationship signal
 * (score 0..100 + tier weak|building|strong) behind the dossier trust badge
 * ("HUMAN·STRONG·70%").
 *
 * DESIGN CHOICE — materialize, don't derive-on-read:
 * The score's inputs already live denormalized on contact_channels
 * (interaction_count, last_interaction, verification status), so the score
 * only changes when those change. Rather than recomputing the blended score on
 * every dossier read, we cache one row per contact and recompute it at the read
 * (self-healing) — this also lets the People list sort/filter by tier with a
 * single indexed read. The row is a pure cache: recomputeContactRelationship()
 * rebuilds it deterministically from live channel stats, so a missing or stale
 * row is always corrected on the next read.
 *
 * SCORE DERIVATION (0..100), blended from three observable signals:
 *
 *   recency  (0..45): how recently we last interacted. Full 45 within a day,
 *                     decaying to 0 past ~90 days (linear on a day scale).
 *   volume   (0..35): interaction count across the contact's channels, on a
 *                     log curve so the first handful of touches move the needle
 *                     most and it saturates (~35 by ~50 interactions).
 *   trust    (0..20): channel verification — a contact reachable on a verified/
 *                     active channel is a stronger tie than an unverified one.
 *                     Full 20 for any active channel, 10 for pending, else 0.
 *
 *   tier:  score >= 67 -> strong ; >= 34 -> building ; else weak.
 *
 * A brand-new contact with no interactions and no verified channel scores 0
 * (tier weak) — the honest "we don't really know each other yet" state.
 */

import { eq } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import {
  contactChannels,
  contactRelationship,
  contacts,
} from "../memory/schema/index.js";
import type { ContactRelationship, RelationshipTier } from "./memory-types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const SCORE_WEIGHTS = {
  recency: 45,
  volume: 35,
  trust: 20,
} as const;

/** Full recency within this many days; 0 past RECENCY_ZERO_DAYS. */
const RECENCY_FULL_DAYS = 1;
const RECENCY_ZERO_DAYS = 90;
/** Interaction count at which the volume signal saturates. */
const VOLUME_SATURATION = 50;

function recencyPoints(lastInteractionAt: number | null, now: number): number {
  if (!lastInteractionAt) return 0;
  const days = Math.max(0, (now - lastInteractionAt) / DAY_MS);
  if (days <= RECENCY_FULL_DAYS) return SCORE_WEIGHTS.recency;
  if (days >= RECENCY_ZERO_DAYS) return 0;
  const frac =
    1 - (days - RECENCY_FULL_DAYS) / (RECENCY_ZERO_DAYS - RECENCY_FULL_DAYS);
  return SCORE_WEIGHTS.recency * frac;
}

function volumePoints(interactionCount: number): number {
  if (interactionCount <= 0) return 0;
  // log1p curve normalized so VOLUME_SATURATION interactions ~= full points.
  const frac = Math.log1p(interactionCount) / Math.log1p(VOLUME_SATURATION);
  return SCORE_WEIGHTS.volume * Math.min(1, frac);
}

function trustPoints(bestChannelStatus: string | null): number {
  if (bestChannelStatus === "active") return SCORE_WEIGHTS.trust;
  if (bestChannelStatus === "pending") return SCORE_WEIGHTS.trust / 2;
  return 0;
}

export function tierForScore(score: number): RelationshipTier {
  if (score >= 67) return "strong";
  if (score >= 34) return "building";
  return "weak";
}

/** Rank channel statuses so "the best channel we have" is deterministic. */
const STATUS_RANK: Record<string, number> = {
  active: 3,
  pending: 2,
  unverified: 1,
};

interface ChannelStats {
  interactionCount: number;
  lastInteractionAt: number | null;
  bestStatus: string | null;
}

/** Aggregate a contact's channel interaction stats + best verification status. */
function channelStatsFor(contactId: string): ChannelStats {
  const db = getDb();
  const rows = db
    .select({
      interactionCount: contactChannels.interactionCount,
      lastInteraction: contactChannels.lastInteraction,
      lastSeenAt: contactChannels.lastSeenAt,
      status: contactChannels.status,
    })
    .from(contactChannels)
    .where(eq(contactChannels.contactId, contactId))
    .all();

  let interactionCount = 0;
  let lastInteractionAt: number | null = null;
  let bestStatus: string | null = null;
  let bestRank = 0;

  for (const r of rows) {
    interactionCount += r.interactionCount ?? 0;
    const seen = Math.max(r.lastInteraction ?? 0, r.lastSeenAt ?? 0);
    if (seen > (lastInteractionAt ?? 0)) lastInteractionAt = seen;
    const rank = STATUS_RANK[r.status] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      bestStatus = r.status;
    }
  }

  return { interactionCount, lastInteractionAt, bestStatus };
}

/** Compute the blended score (0..100) from channel stats. Pure. */
export function computeRelationshipScore(
  stats: ChannelStats,
  now: number = Date.now(),
): number {
  const raw =
    recencyPoints(stats.lastInteractionAt, now) +
    volumePoints(stats.interactionCount) +
    trustPoints(stats.bestStatus);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function parse(
  row: typeof contactRelationship.$inferSelect,
): ContactRelationship {
  return {
    contactId: row.contactId,
    score: row.score,
    tier: row.tier as RelationshipTier,
    lastInteractionAt: row.lastInteractionAt,
    interactionCount: row.interactionCount,
    updatedAt: row.updatedAt,
  };
}

/**
 * Recompute and upsert the relationship cache row for a contact from its live
 * channel stats. Idempotent; safe to call on every dossier read. Returns the
 * fresh row.
 */
export function recomputeContactRelationship(
  contactId: string,
): ContactRelationship {
  const db = getDb();
  const now = Date.now();
  const stats = channelStatsFor(contactId);
  const score = computeRelationshipScore(stats, now);
  const tier = tierForScore(score);

  const row: typeof contactRelationship.$inferInsert = {
    contactId,
    score,
    tier,
    lastInteractionAt: stats.lastInteractionAt,
    interactionCount: stats.interactionCount,
    updatedAt: now,
  };

  db.insert(contactRelationship)
    .values(row)
    .onConflictDoUpdate({
      target: contactRelationship.contactId,
      set: {
        score,
        tier,
        lastInteractionAt: stats.lastInteractionAt,
        interactionCount: stats.interactionCount,
        updatedAt: now,
      },
    })
    .run();

  return parse(row as typeof contactRelationship.$inferSelect);
}

/**
 * Read the relationship signal for a contact, recomputing from live channel
 * stats (self-healing cache). Returns null if the contact does not exist.
 */
export function getContactRelationship(
  contactId: string,
): ContactRelationship | null {
  const db = getDb();
  const exists = db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .get();
  if (!exists) return null;
  return recomputeContactRelationship(contactId);
}
