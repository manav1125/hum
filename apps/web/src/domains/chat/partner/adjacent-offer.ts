/**
 * "While I was in there — the security questionnaire is still open with Rachel,
 * six days now. Chase it too?"
 *
 * Design calls this bubble the whole product, and the constraints are the
 * point: **two is nagging; unrelated is creepy.** So this module enforces the
 * two constraints that can be enforced in the client:
 *
 *  1. **At most one per turn.** Extra offers are dropped, not stacked.
 *  2. **Only from what the turn touched.** An offer may declare which source
 *     family it came from (`from: "mail"`). If it declares one the turn did not
 *     actually read, it is a general sweep of the user's data wearing an
 *     adjacency costume, and it is dropped.
 *
 * An offer that declares nothing is kept. We do not silently invent a reason to
 * drop it, and we do not pretend to have verified it — the honesty rule cuts
 * both ways.
 */

import type {
  AnswerSource,
  SourceFamily,
} from "@/domains/chat/partner/answer-sources";
import type { Surface } from "@/domains/chat/types/types";
import {
  rec,
  str,
} from "@/domains/chat/components/surfaces/surface-parse-helpers";

export const ADJACENT_OFFER_SURFACE_TYPE = "adjacent_offer";

export interface AdjacentOffer {
  surface: Surface;
  /** What Cue noticed. One sentence. */
  note: string;
  /** The source family it came from, when it says. */
  from?: SourceFamily;
}

/** Read an `adjacent_offer` surface. Null when it says nothing. */
export function parseAdjacentOffer(surface: Surface): AdjacentOffer | null {
  const data = rec(surface.data) ?? {};
  const note = (str(data.note) ?? str(data.text) ?? surface.title ?? "").trim();
  if (!note) return null;
  const from = str(data.from)?.trim();
  return {
    surface,
    note,
    ...(from ? { from: from as SourceFamily } : {}),
  };
}

/**
 * Pick the single offer this turn is allowed to make, or null.
 *
 * `sources` is the turn's derived provenance (see `deriveAnswerSources`). An
 * offer whose declared family is absent from it never reaches the user.
 */
export function selectAdjacentOffer(
  surfaces: readonly Surface[],
  sources: readonly AnswerSource[],
): AdjacentOffer | null {
  const touched = new Set(sources.map((s) => s.family));
  for (const surface of surfaces) {
    if (surface.surfaceType !== ADJACENT_OFFER_SURFACE_TYPE) continue;
    const offer = parseAdjacentOffer(surface);
    if (!offer) continue;
    if (offer.from && !touched.has(offer.from)) continue;
    return offer;
  }
  return null;
}

/**
 * Every adjacent-offer surface in the turn EXCEPT the one allowed through.
 *
 * The transcript renders surfaces one at a time as it walks the message's
 * content blocks, so the "only one" rule has to be decided up front over the
 * whole set and then applied per surface. Ids in this set render nothing.
 */
export function suppressedOfferSurfaceIds(
  surfaces: readonly Surface[],
  sources: readonly AnswerSource[],
): Set<string> {
  const kept = selectAdjacentOffer(surfaces, sources);
  const suppressed = new Set<string>();
  for (const surface of surfaces) {
    if (surface.surfaceType !== ADJACENT_OFFER_SURFACE_TYPE) continue;
    if (kept && surface.surfaceId === kept.surface.surfaceId) continue;
    suppressed.add(surface.surfaceId);
  }
  return suppressed;
}
