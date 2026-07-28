/**
 * The executor-side bridge into the autonomy ledger.
 *
 * `ToolExecutor.executeInternal` is the single chokepoint every tool call
 * passes through — pre-execution gates, permission check, execution, and every
 * early return converge there — so one hook here covers connectors, host tools,
 * shells, browsers and proxy meta-tools without touching a single call site.
 *
 * Everything in this module is **observation only**:
 *   · it never re-parses the tool's JSON result to infer what happened — the
 *     outcome and the approval provenance are passed in as typed arguments
 *     from the executor's own state (per assistant/CLAUDE.md);
 *   · it is wrapped so that no classification, resolution, or DB failure can
 *     escape into the tool path.
 */

import type { ToolContext } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import {
  type LedgerApprovalMode,
  recordAutonomyLedgerEntry,
} from "./autonomy-ledger-store.js";
import {
  classifyConsequentialAction,
  describeLedgerEntry,
  type LedgerOutcome,
} from "./consequential-action.js";

const log = getLogger("autonomy-ledger");

/**
 * Approval provenance the executor already holds by the time a tool call
 * settles. Typed side channel — never derived from the result payload.
 */
export interface LedgerApprovalProvenance {
  /** A one-time scoped grant authorised this invocation. */
  grantConsumed?: boolean;
  /** The owner answered a confirmation card for this invocation. */
  approvedViaPrompt?: boolean;
  /** A standing trust rule matched (its id). */
  matchedTrustRuleId?: string;
  /** The permission checker's approval mode ("auto" / "prompt" / …). */
  approvalMode?: string;
  /** The permission checker's human-readable approval reason. */
  approvalReason?: string;
}

/**
 * Collapse the executor's provenance fields into the single "how was this
 * authorised?" answer the ledger stores. Order matters: an explicit human
 * answer outranks a standing rule, which outranks a grant, which outranks
 * "nobody asked".
 */
function resolveApprovedVia(
  provenance: LedgerApprovalProvenance,
): LedgerApprovalMode {
  if (provenance.approvedViaPrompt) return "inline_card";
  if (provenance.matchedTrustRuleId) return "trust_rule";
  if (provenance.grantConsumed) return "scoped_grant";
  return "auto";
}

/**
 * Record one consequential tool attempt. No-ops silently when the tool is not
 * consequential (the common case) and swallows every failure.
 *
 * @param outcome  What actually happened, from the executor's control flow —
 *                 `parked`/`denied` for a gate rejection, `executed` for a
 *                 completed call, `failed` for a thrown/errored one.
 */
export function recordConsequentialToolAction(opts: {
  toolName: string;
  input: Record<string, unknown>;
  context: ToolContext;
  outcome: LedgerOutcome;
  durationMs?: number;
  reason?: string;
  provenance?: LedgerApprovalProvenance;
}): void {
  try {
    const action = classifyConsequentialAction(opts.toolName, opts.input);
    if (!action) return;

    // "Unattended" is the same test the approval gate uses to decide whether
    // to park an external send — an explicit `isInteractive === false`.
    const attended = opts.context.isInteractive !== false;
    const provenance = opts.provenance ?? {};

    recordAutonomyLedgerEntry({
      toolName: opts.toolName,
      actionClass: action.actionClass,
      summary: describeLedgerEntry({
        action,
        outcome: opts.outcome,
        attended,
      }),
      target: action.target,
      outcome: opts.outcome,
      attended,
      // Only an executed action was ever authorised; a parked/denied/failed
      // one was not, and claiming otherwise would be a lie on the ledger.
      approvedVia:
        opts.outcome === "executed" ? resolveApprovedVia(provenance) : null,
      approvalDetail:
        opts.outcome === "executed"
          ? (provenance.approvalReason ??
            provenance.matchedTrustRuleId ??
            provenance.approvalMode ??
            null)
          : null,
      conversationId: opts.context.conversationId,
      requestId: opts.context.requestId ?? null,
      durationMs: opts.durationMs ?? null,
      reason: opts.reason ?? null,
    });
  } catch (err) {
    log.warn(
      { err: String(err), toolName: opts.toolName, outcome: opts.outcome },
      "autonomy-ledger hook failed (ignored — the tool call was not affected)",
    );
  }
}
