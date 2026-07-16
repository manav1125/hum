/**
 * Read-time derivation of a work item's *run provenance* — the honest trust
 * signal the HQ Done cards use to say whether Cue ran an item autonomously
 * ("auto") or a human was in the loop ("you_approved").
 *
 * Derived, never stored. The source of truth is the canonical guardian-request
 * ledger (`canonical_guardian_requests`) joined to the item's most recent run
 * conversation, plus the item's own pre-run tool-permission approval. Computing
 * it at read time means the signal can never drift from the approval records it
 * summarizes — there is no second copy to keep in sync, and no migration.
 *
 * Honesty invariant: an approval by a person always wins over "auto". A run is
 * only ever labeled autonomous once we have positively ruled out both an
 * approved in-run guardian gate and a pre-run permission approval.
 */
import { listCanonicalGuardianRequests } from "../memory/canonical-guardian-store.js";
import { getTaskRun } from "../tasks/task-store.js";
import type { WorkItem } from "./work-item-store.js";

/**
 * How a work item's terminal state came about:
 *  - `"you_approved"` — the owner approved a guardian gate raised during the
 *    run, or pre-approved the item's tool permissions before it ran.
 *  - `"auto"` — the item ran to completion with no owner-gated approval (an
 *    autonomous background run).
 *  - `"manual"` — the item reached `done` without Cue ever running it (the
 *    owner did the work / checked it off themselves).
 *  - `null` — not applicable: the item has not run and is not a manual
 *    completion (e.g. still queued, running, failed, or cancelled).
 */
export type RanProvenance = "auto" | "you_approved" | "manual" | null;

/**
 * Resolve the conversation id of an item's most recent run. Prefers the task
 * run's recorded conversation id (the authoritative binding), falling back to
 * the work item's stored `lastRunConversationId`. Returns null when the item
 * has never run.
 */
function runConversationId(item: WorkItem): string | null {
  if (item.lastRunId) {
    const run = getTaskRun(item.lastRunId);
    if (run?.conversationId) return run.conversationId;
  }
  return item.lastRunConversationId;
}

/**
 * True when the item's run reached a successfully-completed terminal state.
 * `awaiting_review` and `done` are both post-completion; `lastRunStatus ===
 * "completed"` covers a run that finished successfully before the item moved
 * on. A `failed`/`cancelled` item completed nothing, so it is not "auto".
 */
function ranToCompletion(item: WorkItem): boolean {
  return (
    item.lastRunStatus === "completed" ||
    item.status === "done" ||
    item.status === "awaiting_review"
  );
}

/**
 * Core classifier, parameterized on the already-resolved run conversation id
 * and an approved-conversation predicate so both the single-item and batch
 * paths share one honest decision tree.
 */
function classify(
  item: WorkItem,
  convId: string | null,
  isApprovedConversation: (conversationId: string) => boolean,
): RanProvenance {
  // Never ran under Cue. A terminal `done` item that produced no run is a
  // human completion; anything non-terminal simply hasn't run yet.
  if (!convId) {
    return item.status === "done" ? "manual" : null;
  }

  // A human was explicitly in the loop — either they pre-approved the item's
  // tool permissions, or they approved a guardian gate raised during the run.
  // Checked BEFORE "auto" so an approved run is never mislabeled autonomous.
  if (item.approvalStatus === "approved") return "you_approved";
  if (isApprovedConversation(convId)) return "you_approved";

  // Ran with no human in the loop. Only "auto" once it actually completed.
  return ranToCompletion(item) ? "auto" : null;
}

/** True when any guardian request tied to `conversationId` was approved. */
function hasApprovedGuardianRequest(conversationId: string): boolean {
  return (
    listCanonicalGuardianRequests({ conversationId, status: "approved" })
      .length > 0
  );
}

/**
 * Derive a single work item's run provenance. Issues its own guardian-ledger
 * lookup; use {@link withRanProvenance} to annotate a list without an N+1.
 */
export function deriveRanProvenance(item: WorkItem): RanProvenance {
  return classify(item, runConversationId(item), hasApprovedGuardianRequest);
}

/**
 * Annotate a list of work items with `ranProvenance`, resolving each item's run
 * conversation once and folding the approved-conversation check into a single
 * guardian-ledger query. Returns the store items widened with the derived
 * field, shaped for the work-item route response.
 */
export function withRanProvenance<T extends WorkItem>(
  items: T[],
): Array<T & { ranProvenance: RanProvenance }> {
  // Resolve each item's run conversation once (the only per-item DB read).
  const convById = new Map<string, string | null>();
  const runConvIds = new Set<string>();
  for (const item of items) {
    const cid = runConversationId(item);
    convById.set(item.id, cid);
    if (cid) runConvIds.add(cid);
  }

  // One query for all approved guardian requests, intersected with the run
  // conversations we actually care about.
  const approved = new Set<string>();
  if (runConvIds.size > 0) {
    for (const req of listCanonicalGuardianRequests({ status: "approved" })) {
      if (req.conversationId && runConvIds.has(req.conversationId)) {
        approved.add(req.conversationId);
      }
    }
  }

  return items.map((item) => ({
    ...item,
    ranProvenance: classify(item, convById.get(item.id) ?? null, (c) =>
      approved.has(c),
    ),
  }));
}
