/**
 * Deciding which surfaced arrivals Cue should actually act on.
 *
 * This is the missing consumer in the work loop. Everything upstream of it
 * works: watchers capture, and the relevance gate
 * (`arrivals/arrival-gate.ts`) decides what the owner should SEE — on
 * production it filed 66% of 6,381 arrivals and surfaced the rest. What no
 * step ever asked is the different question that comes next: **of the things
 * worth showing you, which ones is Cue supposed to do something about?**
 *
 * Nothing answered it, so every surfaced arrival was created `parked` and
 * stayed there. 1,692 of them accumulated in the queued lane, 1,325 in a
 * single month, and the only way out was the owner pressing Run on each one
 * by hand. Eighteen work items have ever completed.
 *
 * ## This gate only ever promotes
 *
 * It can move an item from parked to eligible. It cannot archive, hide, or
 * file anything. That restraint is deliberate and load-bearing:
 *
 *   · Filing is the relevance gate's job, and it already does it with a
 *     safety floor and a fail-open guarantee. A second component making the
 *     same judgement would be a second reconstruction of it, and the two
 *     would drift — silently, in whichever direction hid more of the owner's
 *     mail.
 *   · A gate that can only promote has a bounded worst case. If it is wrong,
 *     an item becomes *eligible* — and eligibility is not action. Every
 *     existing control still stands between it and anything happening: the
 *     hard-deny tool floor, the per-category autonomy policy, the agent's
 *     tier and pause, the budget cap, and the concurrency limit. None of
 *     them are bypassed or consulted here.
 *
 * ## Failure leaves the item parked
 *
 * The relevance gate fails OPEN — a judge that times out surfaces the mail,
 * because an outage must never swallow somebody's message. This gate fails
 * the other way, and for the same underlying reason: there, the failure mode
 * to avoid is hiding something from the owner; here, it is acting without
 * being asked. Both resolve toward the owner staying in control. A judge that
 * throws, times out, or answers unparseably promotes nothing.
 *
 * ## Only system-parked items are eligible
 *
 * `autoRunEligibility: "parked"` currently carries two different meanings —
 * "the owner parked this, never auto-run it" (its documented purpose, per
 * migration 305) and "the watcher created this and had no opinion". Promoting
 * the first would override a deliberate instruction; promoting the second is
 * the entire point. They are indistinguishable in that one column.
 *
 * So eligibility is decided by PROVENANCE instead: only items whose
 * `sourceType` marks them as watcher-created are considered, because those
 * were parked by `createWorkItemForArrival` as a default, not by a person.
 * Anything a human touched is out of scope by construction.
 */

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";
import { runBtwSidechain } from "../runtime/btw-sidechain.js";
import { getLogger } from "../util/logger.js";
import {
  listWorkItems,
  updateWorkItem,
  type WorkItem,
} from "./work-item-store.js";

const log = getLogger("arrival-action-gate");

/**
 * Label stamped on every item this gate has ruled on, so a sweep never pays
 * to judge the same item twice. Present with either verdict — the point is
 * "considered", not "promoted".
 */
export const ACTION_GATE_LABEL = "action-gate:considered";

/**
 * Items sent to the judge in one call.
 *
 * Matches the relevance gate's batch size for the same measured reason: the
 * flash call site resolves to a reasoning model, and a batch that reaches it
 * is ambiguous by construction, so it deliberates. Eight answers inside the
 * budget with margin.
 */
export const MAX_ACTION_BATCH = 8;

/**
 * Items promoted per sweep, across all batches.
 *
 * A deliberately small number. The queue holds a backlog measured in
 * thousands, and a gate that promoted even a tenth of it in one pass would
 * hand the runner more concurrent work than the owner has ever seen it do —
 * which is alarming regardless of whether each individual call was right.
 * The backlog drains over days, visibly, and the cap is the thing that makes
 * a mistake recoverable rather than a flood.
 */
export const MAX_PROMOTIONS_PER_SWEEP = 3;

/** `sourceType` prefixes that mark an item as watcher-created. */
const WATCHER_SOURCE_PREFIX = "watcher:";

function parseLabels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((l): l is string => typeof l === "string")
      : [];
  } catch {
    // A malformed labels blob must not make an item permanently
    // unconsiderable, nor crash the sweep. Treat it as unlabelled.
    return [];
  }
}

function hasBeenConsidered(item: WorkItem): boolean {
  return parseLabels(item.labels).includes(ACTION_GATE_LABEL);
}

/**
 * Whether this gate is allowed to have an opinion about an item at all.
 *
 * Every condition is about provenance and state, never about content — the
 * content judgement belongs to the judge, and mixing the two here would make
 * the safety properties depend on a prompt.
 */
export function isActionGateCandidate(item: WorkItem): boolean {
  return (
    item.status === "queued" &&
    item.autoRunEligibility === "parked" &&
    // Watcher-created, therefore parked by default rather than by a person.
    (item.sourceType?.startsWith(WATCHER_SOURCE_PREFIX) ?? false) &&
    // Untouched since capture: an assignee, a due date or a project means
    // somebody has already made a decision about this item, and a decision
    // is not this gate's to revisit.
    item.assignee !== null &&
    item.assignee.trim().toLowerCase() === "cue" &&
    !hasBeenConsidered(item)
  );
}

/** The judge's verdict for one item. */
export interface ActionVerdict {
  id: string;
  /** True only when Cue should take this on without being asked. */
  actionable: boolean;
}

/**
 * Parse the judge's reply into verdicts, keyed by item id.
 *
 * Unknown ids are dropped and missing items default to NOT actionable, so a
 * partial or malformed answer promotes less rather than more.
 */
export function parseActionVerdicts(
  text: string,
  validIds: ReadonlySet<string>,
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return out;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return out;
    for (const raw of parsed) {
      if (typeof raw !== "object" || raw == null) continue;
      const r = raw as { id?: unknown; actionable?: unknown };
      if (typeof r.id !== "string" || !validIds.has(r.id)) continue;
      // Only a literal `true` promotes. A string "yes", a 1, or an absent
      // field all read as "no" — the permissive direction has to be explicit.
      out.set(r.id, r.actionable === true);
    }
  } catch {
    return new Map();
  }
  return out;
}

/** The prompt. Exported so its wording is testable. */
export function buildActionPrompt(items: WorkItem[]): string {
  return [
    "You are deciding which of these captured items an assistant should take on WITHOUT being asked.",
    "",
    "Answer true ONLY when all of these hold:",
    "  - there is a concrete task in it, not just information to be aware of;",
    "  - it can be completed without a decision only the owner can make;",
    "  - doing it unprompted would be welcome rather than presumptuous.",
    "",
    "Answer false for anything informational, anything needing the owner's judgement, anything involving money, commitments, or messages sent on their behalf, and anything you are unsure about. False is the safe answer and the common one — most captured items are for the owner to read, not for you to act on.",
    "",
    "Items:",
    ...items.map(
      (i) =>
        `  - id: ${i.id}\n    title: ${i.title}\n    from: ${i.sourceType ?? "unknown"}${
          i.notes ? `\n    details: ${i.notes.slice(0, 300)}` : ""
        }`,
    ),
    "",
    'Reply with ONLY a JSON array, no prose: [{"id": "<id>", "actionable": true|false}]',
  ].join("\n");
}

/** How long the judge gets before the sweep gives up and promotes nothing. */
const ACTION_JUDGE_TIMEOUT_MS = 60_000;

async function judge(items: WorkItem[]): Promise<Map<string, boolean>> {
  const provider = await getConfiguredProvider("conversationTitle");
  // No provider is an outage, not a verdict — promote nothing.
  if (!provider) return new Map();
  const resolved = resolveCallSiteConfig("conversationTitle", getConfig().llm);
  const result = await runBtwSidechain({
    content: buildActionPrompt(items),
    provider,
    systemPrompt:
      "You decide what an assistant may take on unasked. Reply with ONLY the requested JSON array.",
    messages: [],
    tools: [],
    callSite: "conversationTitle",
    maxTokens: resolved.maxTokens,
    timeoutMs: ACTION_JUDGE_TIMEOUT_MS,
  });
  if (!result?.text) return new Map();
  return parseActionVerdicts(result.text, new Set(items.map((i) => i.id)));
}

/** Stamp the considered label without disturbing labels already present. */
function markConsidered(item: WorkItem): void {
  const labels = parseLabels(item.labels);
  if (labels.includes(ACTION_GATE_LABEL)) return;
  labels.push(ACTION_GATE_LABEL);
  updateWorkItem(
    item.id,
    { labels: JSON.stringify(labels) },
    { actor: "action-gate" },
  );
}

export interface ActionGateSweepResult {
  considered: number;
  promoted: number;
}

/**
 * One sweep: judge a bounded slice of unconsidered watcher arrivals and
 * promote the few that are genuinely Cue's to do.
 *
 * Never throws. This runs on a timer beside the queue drainer, and a judge
 * outage must not take the sweep — or the daemon — down with it.
 */
export async function sweepArrivalActionGate(): Promise<ActionGateSweepResult> {
  const result: ActionGateSweepResult = { considered: 0, promoted: 0 };
  let candidates: WorkItem[];
  try {
    candidates = listWorkItems({
      status: "queued",
      includeUnComprehended: true,
    })
      .filter(isActionGateCandidate)
      .slice(0, MAX_ACTION_BATCH);
  } catch (err) {
    log.error({ err }, "action gate could not read the queue; skipping sweep");
    return result;
  }
  if (candidates.length === 0) return result;

  let verdicts: Map<string, boolean>;
  try {
    verdicts = await judge(candidates);
  } catch (err) {
    // Fail toward inaction: leave every candidate parked and unlabelled so a
    // later sweep reconsiders them once the judge is healthy again.
    log.warn(
      { err, candidates: candidates.length },
      "action gate judge failed; promoting nothing this sweep",
    );
    return result;
  }

  for (const item of candidates) {
    // An item the judge did not mention is not actionable — an omission is
    // not consent.
    const actionable = verdicts.get(item.id) === true;
    try {
      markConsidered(item);
      result.considered++;
      if (!actionable) continue;
      if (result.promoted >= MAX_PROMOTIONS_PER_SWEEP) continue;

      // Clearing the marker makes the item ELIGIBLE, not started. The
      // existing auto-run gate still decides whether anything runs, and every
      // floor it enforces is untouched by this.
      updateWorkItem(
        item.id,
        { autoRunEligibility: null },
        { actor: "action-gate" },
      );
      result.promoted++;
      log.info(
        { workItemId: item.id, sourceType: item.sourceType },
        "action gate promoted a captured item to auto-run eligible",
      );
    } catch (err) {
      log.warn(
        { err, workItemId: item.id },
        "action gate could not update an item; leaving it parked",
      );
    }
  }

  return result;
}
