/**
 * The relevance gate — what an episode is allowed to propose.
 *
 * Cue has already shipped the failure this exists to prevent. `arrivals` had
 * no gate before work-item creation and produced "101 things from email"; the
 * fix (`arrivals/arrival-gate.ts`) was deterministic rules, then a floor that
 * always surfaces, then a model for the ambiguous middle. An always-on
 * microphone is that same failure multiplied by every sentence somebody says
 * in a day, so the shape is reused here rather than reinvented.
 *
 * The layers, in order, and the order is the design:
 *
 *  1. **The human floor.** An episode a person ⚑ marked always proposes. They
 *     pressed the button; there is no judgement left to make, and the frames
 *     put "YOU MARKED THIS" above anything Cue inferred. This runs FIRST and
 *     nothing below can overturn it.
 *  2. **Deterministic silence rules.** Too short, too few words, no verbs of
 *     commitment — no model needed, and a model would be slower and less
 *     predictable at exactly these.
 *  3. **The model**, for the genuinely ambiguous middle only.
 *
 * Two invariants, both inherited and both load-bearing:
 *
 *   · **Fail OPEN, into PROPOSED — never into filed.** Every failure (the
 *     judge throws, times out, returns nothing parseable, is disabled) lets
 *     the episode through as proposals the owner reviews. This is the safe
 *     direction here precisely because nothing files without acceptance: the
 *     worst case of failing open is a queue item somebody dismisses, whereas
 *     failing closed silently loses the sentence that mattered. It is the same
 *     rule as the arrival gate and the opposite of what "fail closed" would
 *     mean in a system that acted on its own.
 *   · **Never guess into a gap.** An episode with nothing in it produces
 *     nothing, and that is a calm day rather than an error.
 *
 * What survives the gate is a set of PROPOSALS. Nothing here writes work — see
 * `memory/schema/halo.ts` for why acceptance is a row transition and not a
 * reviewer's promise.
 */

import { getLogger } from "../util/logger.js";

const log = getLogger("halo-gate");

export type HaloGateVerdict = "propose" | "quiet";

export type HaloGateReason =
  /** The owner marked it. The floor — nothing overturns this. */
  | "marked"
  /** Not enough was said to be about anything. */
  | "too_short"
  /** Words, but none of them a commitment, a decision or a question. */
  | "no_commitment"
  /** The model's call, on the ambiguous middle. */
  | "judged"
  /** The judge was unavailable or unintelligible — fail open. */
  | "unjudged";

export interface HaloGateDecision {
  verdict: HaloGateVerdict;
  reason: HaloGateReason;
  /**
   * `confident` | `unsure` — the tier a proposal from this episode starts at.
   * An unsure episode's proposals wait behind the fold rather than diluting
   * the queue. Never a percentage: see the schema.
   */
  confidenceTier: "confident" | "unsure";
}

export interface HaloEpisodeForGate {
  /** Seconds of audio actually in the episode. */
  heardSeconds: number;
  transcript: string;
  /** Ids of ⚑/✦ marks inside it. Non-empty means the floor applies. */
  markIds?: string[];
}

/**
 * Below this an "episode" is a corridor exchange, not a conversation. Twenty
 * seconds is one segment file — the smallest thing the device can produce.
 */
const MIN_HEARD_SECONDS = 45;

/** Fewer words than this and there is nothing to be about. */
const MIN_WORDS = 25;

/**
 * The shape of a commitment, a decision, or a question somebody owes an
 * answer to. Deliberately a coarse net: it only decides whether the MODEL gets
 * asked, so a false positive costs one judge call and a false negative would
 * cost somebody their promise. When in doubt this matches.
 */
const COMMITMENT_PATTERNS = [
  /\bI(?:'| a)?ll\b/i,
  /\bwe(?:'| wi)?ll\b/i,
  /\blet me\b/i,
  /\bcan you\b/i,
  /\bcould you\b/i,
  /\bwe (?:should|need to|agreed|decided)\b/i,
  /\bI (?:need to|have to|should|will|promise)\b/i,
  /\bsend (?:you|me|it|the|over)\b/i,
  /\b(?:by|before|on) (?:mon|tue|wed|thu|fri|sat|sun|tomorrow|next week|end of)/i,
  /\bdeadline\b/i,
  /\bfollow up\b/i,
  /\bget back to (?:you|me|him|her|them)\b/i,
  /\bremind me\b/i,
];

/** Deterministic layers only — no model, no network. Exported for testing. */
export function screenEpisode(
  episode: HaloEpisodeForGate,
): HaloGateDecision | null {
  // Layer 1 — the floor. Runs before every other test, and wins.
  if (episode.markIds && episode.markIds.length > 0) {
    return {
      verdict: "propose",
      reason: "marked",
      confidenceTier: "confident",
    };
  }

  const text = episode.transcript.trim();
  const words = text ? text.split(/\s+/).length : 0;

  if (episode.heardSeconds < MIN_HEARD_SECONDS || words < MIN_WORDS) {
    return { verdict: "quiet", reason: "too_short", confidenceTier: "unsure" };
  }

  if (!COMMITMENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      verdict: "quiet",
      reason: "no_commitment",
      confidenceTier: "unsure",
    };
  }

  // Ambiguous middle — the caller asks the model.
  return null;
}

/** Asks the model whether this episode is worth proposing from. */
export type HaloEpisodeJudge = (
  episode: HaloEpisodeForGate,
) => Promise<{ propose: boolean; confident: boolean } | null>;

/**
 * Decide what an episode may propose.
 *
 * The judge is injected rather than imported so this module holds no provider
 * and no timeout policy of its own — the same reason the observation driver
 * takes its capture source. A missing judge is a normal state (unconfigured,
 * capped, disabled) and resolves the same way a failing one does: open.
 */
export async function gateEpisode(
  episode: HaloEpisodeForGate,
  judge?: HaloEpisodeJudge | null,
): Promise<HaloGateDecision> {
  const screened = screenEpisode(episode);
  if (screened) return screened;

  if (!judge) {
    return { verdict: "propose", reason: "unjudged", confidenceTier: "unsure" };
  }

  try {
    const answer = await judge(episode);
    if (!answer) {
      log.warn("Halo episode judge returned nothing; proposing unsure");
      return {
        verdict: "propose",
        reason: "unjudged",
        confidenceTier: "unsure",
      };
    }
    return {
      verdict: answer.propose ? "propose" : "quiet",
      reason: "judged",
      confidenceTier: answer.confident ? "confident" : "unsure",
    };
  } catch (err) {
    // Fail open. An outage must never silently swallow somebody's day.
    log.warn({ err }, "Halo episode judge failed; proposing unsure");
    return { verdict: "propose", reason: "unjudged", confidenceTier: "unsure" };
  }
}
