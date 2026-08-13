// ---------------------------------------------------------------------------
// Memory retrospective — enqueue helper.
// ---------------------------------------------------------------------------
//
// Enqueue a `memory_retrospective` job for the given conversation. Gates on:
//   - Source conversation isn't a memory-retrospective conversation itself
//     (recursion guard — we never run a retrospective over reflective
//     musings from the retrospective agent's own writes).
//   - The unprocessed tail contains user activity, when
//     `memory.retrospective.requireUserActivity` is on (the default).
//     Assistant-only stretches carry no user turn, so their window anchor is
//     undecidable and their content is a recap of work captured at its
//     source; the gate defers them until real user activity arrives.
//     Living here, every trigger kind funnels through one check (port of
//     upstream ff10e008e1).
//
// All four trigger types funnel through `upsertMemoryRetrospectiveJob` which
// coalesces rapid enqueues into a single pending row per conversation.
// `lifecycle` and `compaction` triggers get a small debounce so the job runs
// after the corresponding signal settles; `interval` and `message_count`
// fire immediately.

import { getConfig } from "../config/loader.js";
import {
  isUntrustedTrustClass,
  type TrustClass,
} from "../runtime/actor-trust-resolver.js";
import { getLogger } from "../util/logger.js";
import { getConversationSource } from "./conversation-crud.js";
import { isMemoryEnabled, upsertMemoryRetrospectiveJob } from "./jobs-store.js";
import {
  hasQualifyingUserMessageAfter,
  retrospectiveRequiresUserActivity,
} from "./memory-retrospective-activity.js";
import { isMemoryRetrospectiveSource } from "./memory-retrospective-constants.js";
import { getRetrospectiveState } from "./memory-retrospective-state.js";

const log = getLogger("memory-retrospective-enqueue");

export type MemoryRetrospectiveTrigger =
  | "interval"
  | "message_count"
  | "compaction"
  | "lifecycle";

const COMPACTION_DEBOUNCE_MS = 500;

/**
 * Returns true when a job row was upserted, false when a gate skipped the
 * enqueue (or the upsert failed).
 */
export function enqueueMemoryRetrospectiveIfEnabled(args: {
  conversationId: string;
  trigger: MemoryRetrospectiveTrigger;
}): boolean {
  const { conversationId, trigger } = args;

  if (!isMemoryEnabled()) {
    return false;
  }

  if (isMemoryRetrospectiveConversation(conversationId)) {
    log.debug(
      { conversationId, trigger },
      "Skipping memory-retrospective enqueue: source is a memory-retrospective conversation",
    );
    return false;
  }

  if (!passesUserActivityGate(conversationId, trigger)) {
    return false;
  }

  const runAfter =
    trigger === "compaction" ? Date.now() + COMPACTION_DEBOUNCE_MS : Date.now();

  try {
    upsertMemoryRetrospectiveJob({ conversationId }, runAfter);
  } catch (err) {
    log.warn(
      { err, conversationId, trigger },
      "Failed to upsert memory-retrospective job",
    );
    return false;
  }
  return true;
}

/**
 * The `memory.retrospective.requireUserActivity` gate: pass when the config
 * is off or the unprocessed tail (everything after the conversation's
 * `lastProcessedMessageId`) contains at least one user message carrying
 * non-tool_result content. A gate that cannot be evaluated (config or DB
 * unavailable) passes — an unevaluable gate must not silence retrospectives.
 */
function passesUserActivityGate(
  conversationId: string,
  trigger: MemoryRetrospectiveTrigger,
): boolean {
  try {
    if (!retrospectiveRequiresUserActivity(getConfig().memory.retrospective)) {
      return true;
    }
    const state = getRetrospectiveState(conversationId);
    if (
      hasQualifyingUserMessageAfter(
        conversationId,
        state?.lastProcessedMessageId ?? null,
      )
    ) {
      return true;
    }
    log.debug(
      { conversationId, trigger },
      "Skipping memory-retrospective enqueue: no user activity in the unprocessed tail",
    );
    return false;
  } catch (err) {
    log.warn(
      { err, conversationId, trigger },
      "User-activity gate check failed; enqueueing anyway",
    );
    return true;
  }
}

/**
 * Recursion guard. The retrospective bootstraps its own background
 * conversation; without this check, that conversation's lifecycle would
 * enqueue another retrospective on top of it, recursing.
 */
export function isMemoryRetrospectiveConversation(
  conversationId: string,
): boolean {
  const source = getConversationSource(conversationId);
  return source !== null && isMemoryRetrospectiveSource(source);
}

/**
 * Fire a memory-retrospective enqueue from the compaction site. Mirrors
 * `enqueueAutoAnalysisOnCompaction` — same trust-class gate (don't run a
 * guardian-trust background loop over untrusted-actor conversations) and
 * same best-effort error swallowing (never block compaction on enqueue
 * failures).
 */
export function enqueueMemoryRetrospectiveOnCompaction(
  conversationId: string,
  trustClass: TrustClass | undefined,
): void {
  if (isUntrustedTrustClass(trustClass)) {
    return;
  }
  try {
    enqueueMemoryRetrospectiveIfEnabled({
      conversationId,
      trigger: "compaction",
    });
  } catch {
    // Best-effort — never block compaction on enqueue failures.
  }
}
