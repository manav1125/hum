/**
 * Decide how a Home feed action should execute: run silently in the
 * background, open a foreground thread the user drives, or pause for the
 * user's approval before doing anything consequential.
 *
 * This is the "smart default" behind the Home action split-button. It is a
 * pure, deterministic mapping from (a) a lexical read of what the action
 * actually does and (b) the user's per-category autonomy policy. No model is
 * involved — classification is keyword-based and biased toward the *more*
 * cautious reading, mirroring the doctrine in `permissions/autonomy-class.ts`
 * (when in doubt, treat it as consequential).
 *
 * Resolution:
 *   classifyFeedActionMode(action) -> AutonomyClass   (what kind of work is this?)
 *   resolveDefaultMode(class, policy) -> FeedActionMode (so how do we run it?)
 *
 * The autonomy policy maps each class to auto | ask | never:
 *   - auto  -> "background"  (low-risk: research/draft -> run to completion)
 *   - ask   -> "needs_you"   (consequential: never silently fire; surface an approval)
 *   - never -> "thread"      (let the user drive it by hand; we never auto-run)
 */

import type { AutonomyClass } from "../permissions/autonomy-class.js";
import type { AutonomyPolicyMap } from "../permissions/autonomy-policy-reader.js";
import type { FeedAction } from "./feed-types.js";

/** How a feed action runs once triggered. */
export type FeedActionMode = "background" | "thread" | "needs_you";

// Spending money or deleting/cancelling state — the most consequential, so
// checked first and dominant.
const MONEY_PATTERNS =
  /\b(pay|charge|refund|invoice|purchase|buy|order|transfer|wire|subscribe|checkout|top ?up|withdraw|deposit)\b/i;
const DELETE_PATTERNS =
  /\b(delete|remove|cancel|revoke|unsubscribe|archive|wipe|purge|deactivate)\b/i;

// EXPLICIT send verbs — these mean something actually goes out, and they
// dominate over "draft" (so "draft and send the reply" is a send, not a draft).
const STRONG_SEND_PATTERNS =
  /\b(send|sends|sending|sent|post|posts|publish|tweet|forward|submit|dispatch|broadcast)\b/i;

// Drafting/composing — low-risk: produces text the user reviews, nothing goes
// out. Checked before the weaker send words so "Draft reply" stays a draft.
const DRAFT_PATTERNS =
  /\b(draft|compose|write|prepare|prep|outline|rephrase|rewrite)\b/i;

// Weaker, ambiguous "outward" words (reply/respond/message as nouns or soft
// verbs). With no explicit send verb AND no draft verb, bias to the cautious
// reading and treat these as send.
const WEAK_SEND_PATTERNS =
  /\b(reply|respond|email|e-mail|message|dm|notify|invite|share|ping|nudge)\b/i;

const RESEARCH_PATTERNS =
  /\b(research|find|look ?up|search|summari[sz]e|review|check|confirm|investigate|read|gather|analy[sz]e|look into|look at|track|monitor)\b/i;

/**
 * Classify what a feed action *does* from its label + prompt. Order matters:
 *   money/delete  -> dominant (most consequential)
 *   strong-send   -> explicit send verb beats "draft"
 *   draft         -> composing text, nothing leaves
 *   weak-send     -> reply/respond with no draft verb -> cautious "send"
 *   research      -> read-only
 *   other         -> unknown -> cautious default
 */
export function classifyFeedActionMode(action: FeedAction): AutonomyClass {
  const text = `${action.label ?? ""} ${action.prompt ?? ""}`;

  if (MONEY_PATTERNS.test(text)) return "money";
  if (DELETE_PATTERNS.test(text)) return "delete";
  if (STRONG_SEND_PATTERNS.test(text)) return "send";
  if (DRAFT_PATTERNS.test(text)) return "draft";
  if (WEAK_SEND_PATTERNS.test(text)) return "send";
  if (RESEARCH_PATTERNS.test(text)) return "research";

  // Unknown intent — treat as consequential ("other" defaults to ask).
  return "other";
}

/**
 * Map an autonomy class + the user's policy to the default execution mode.
 *
 *   auto  -> background  (run it now, post the result back)
 *   ask   -> needs_you   (hold for explicit approval; never auto-fire)
 *   never -> thread      (open a conversation the user drives by hand)
 */
export function resolveDefaultMode(
  autonomyClass: AutonomyClass,
  policy: AutonomyPolicyMap,
): FeedActionMode {
  switch (policy[autonomyClass]) {
    case "auto":
      return "background";
    case "ask":
      return "needs_you";
    case "never":
      return "thread";
    default:
      // Unknown/missing policy entry — be cautious.
      return "needs_you";
  }
}

/**
 * Whether a feed action is eligible to run in the background at all. Used by
 * the UI to decide if the "Run in background" override should be offered or
 * warned against. Consequential classes are never silently backgroundable by
 * default, though the user can still force it via the override.
 */
export function allowsBackground(autonomyClass: AutonomyClass): boolean {
  return autonomyClass === "research" || autonomyClass === "draft";
}
