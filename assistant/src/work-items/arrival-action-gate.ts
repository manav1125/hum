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
 * Items promoted in one sweep.
 *
 * Small on purpose, but note that this alone bounds nothing useful: sweeps run
 * on the drainer's five-minute tick, so a per-sweep cap of three still permits
 * 864 promotions a day. The rolling cap below is the one that matters.
 */
export const MAX_PROMOTIONS_PER_SWEEP = 3;

/**
 * Items promoted in any rolling 24 hours.
 *
 * This is the real bound, and it exists because the per-sweep cap multiplied
 * by the sweep rate is not a limit anyone would accept: 3 × 288 sweeps a day
 * is 864 unattended runs, each costing money. There is no backstop behind
 * that — an agent's `capCents` is null unless someone set one, and on
 * production none of the four had.
 *
 * Twelve is chosen against the observed shape of the backlog rather than as a
 * round number. Of ~1,300 captured items, the genuinely actionable share is a
 * small fraction; twelve a day drains that fraction over days while keeping a
 * miscalibrated judge — or a prompt regression — to something the owner can
 * notice and stop before it has done much. A gate that can only be wrong
 * twelve times a day is recoverable; one that can be wrong 864 times is not.
 */
export const MAX_PROMOTIONS_PER_DAY = 12;

/** Label stamped when an item is actually promoted, so the rolling cap can count. */
export const ACTION_GATE_PROMOTED_LABEL = "action-gate:promoted";

const DAY_MS = 24 * 60 * 60 * 1000;

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

/**
 * Promotions in the last 24 hours, counted from the items themselves.
 *
 * Deliberately derived from durable state rather than an in-process counter: a
 * daemon restart must not reset the budget, or a crash loop becomes a way to
 * promote without limit.
 */
export function promotionsInLastDay(now = Date.now()): number {
  try {
    return listWorkItems({ includeUnComprehended: true }).filter(
      (i) =>
        parseLabels(i.labels).includes(ACTION_GATE_PROMOTED_LABEL) &&
        i.updatedAt > now - DAY_MS,
    ).length;
  } catch {
    // Unreadable queue: assume the budget is spent. Failing toward inaction
    // is the same choice made everywhere else in this module.
    return MAX_PROMOTIONS_PER_DAY;
  }
}

export interface ActionGateSweepResult {
  considered: number;
  promoted: number;
  /** True when the sweep stopped early because the daily budget was spent. */
  dailyCapReached?: boolean;
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

  // Spend the daily budget before paying for a judgement it cannot act on.
  const alreadyPromoted = promotionsInLastDay();
  const remainingToday = MAX_PROMOTIONS_PER_DAY - alreadyPromoted;
  if (remainingToday <= 0) {
    log.info(
      { alreadyPromoted },
      "action gate daily promotion cap reached; considering nothing this sweep",
    );
    return { ...result, dailyCapReached: true };
  }

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
    const budgetLeft =
      result.promoted < MAX_PROMOTIONS_PER_SWEEP &&
      result.promoted < remainingToday;
    if (actionable && !budgetLeft) result.dailyCapReached = true;
    const promoting = actionable && budgetLeft;

    try {
      // One write per item, carrying every label it should end up with.
      // Stamping "considered" separately and then writing again would read
      // `item.labels` from the stale in-memory row and drop it.
      const labels = parseLabels(item.labels);
      if (!labels.includes(ACTION_GATE_LABEL)) labels.push(ACTION_GATE_LABEL);
      if (promoting && !labels.includes(ACTION_GATE_PROMOTED_LABEL)) {
        // The promoted label is how the rolling cap counts, so it has to be
        // durable rather than an in-process tally.
        labels.push(ACTION_GATE_PROMOTED_LABEL);
      }

      // Clearing the marker makes the item ELIGIBLE, not started. The
      // existing auto-run gate still decides whether anything runs, and every
      // floor it enforces is untouched by this.
      updateWorkItem(
        item.id,
        {
          labels: JSON.stringify(labels),
          ...(promoting ? { autoRunEligibility: null } : {}),
        },
        { actor: "action-gate" },
      );
      result.considered++;
      if (promoting) {
        result.promoted++;
        log.info(
          { workItemId: item.id, sourceType: item.sourceType },
          "action gate promoted a captured item to auto-run eligible",
        );
      }
    } catch (err) {
      log.warn(
        { err, workItemId: item.id },
        "action gate could not update an item; leaving it parked",
      );
    }
  }

  return result;
}
