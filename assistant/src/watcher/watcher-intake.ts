/**
 * Watcher intake — decide what each newly-detected watcher event becomes.
 *
 * This is the event-driven ingress the cadence-based missions lack, and it is
 * where the "chief of staff that filters" promise is either kept or broken.
 * Every hit takes exactly one of three paths:
 *
 *   1. A **playbook** the owner configured claims it (they already said this
 *      kind of thing matters, so no judging is needed).
 *   2. The relevance gate **surfaces** it — a parked work item in the Came-in
 *      lane, exactly as before.
 *   3. The relevance gate **files** it — recorded in `arrivals` with a reason
 *      in the owner's words, browsable and reversible, but NOT in the lane and
 *      NOT something they must look at.
 *
 * A surfaced hit then takes one of two further paths. If it belongs to a
 * conversation, or an automated sender, the owner already has an open item
 * for, it is **grouped**: folded into that item as an update, with a member
 * row recording what was combined so the merge is visible and can be split
 * back out. Otherwise it becomes its own item — and that item is then
 * **comprehended**: read for what it actually asks the owner to DO, so the
 * lane says "Renew Brinc Innovation Africa's annual return" rather than
 * "Email from CIPA <info@cipa.co.bw>: 2026 Annual Return Due…".
 *
 * Both of those steps fail toward the previous behaviour, never past it: a
 * grouping failure gives the message its own row, and a comprehension failure
 * leaves the subject line in place. Neither may wedge intake, so the
 * comprehension call is one batched flash-tier request bounded by a deadline
 * race, run AFTER every arrival has already been recorded and surfaced.
 *
 * The founding invariant still holds and is now stronger: nothing a watcher
 * saw is silently dropped. Every hit gets an `arrivals` row whichever path it
 * takes, so "arrived / filed / kept" is a census rather than an estimate, and
 * "filed" always means recorded-and-findable — never deleted.
 *
 * Dedupe is handled upstream: `watcher_events` has a UNIQUE (watcher_id,
 * external_id) constraint, so `insertWatcherEvent` only surfaces genuinely new
 * events. `recordArrival` is idempotent on (channel, external_id) as a second
 * belt — a replayed poll must not inflate what the owner is shown.
 */

import {
  type ArrivalExtractor,
  comprehendArrivals,
  type ComprehensionCandidate,
} from "../arrivals/arrival-comprehension.js";
import {
  decideArrivals,
  type DecideArrivalsOptions,
} from "../arrivals/arrival-gate.js";
import {
  attachArrivalToGroup,
  recordGroupAnchor,
} from "../arrivals/arrival-grouping.js";
import { buildArrivalSignals } from "../arrivals/arrival-signals.js";
import { recordArrival } from "../arrivals/arrival-store.js";
import { createWorkItemForArrival } from "../arrivals/arrival-surface.js";
import { DECISION_ID_PREFIX } from "../calendar/calendar-decisions.js";
import {
  evaluatePlaybooksForEvent,
  type PlaybookEvent,
} from "../playbooks/playbook-runtime.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import {
  listWorkItems,
  updateWorkItem,
} from "../work-items/work-item-store.js";
import { triageAndMaybeAutoRunWorkItem } from "../work-items/work-item-triage.js";
import type { WatcherDecision } from "./provider-types.js";
import type { Watcher, WatcherEvent } from "./watcher-store.js";

const log = getLogger("watcher-intake");

/**
 * What happened to one event. `filed` is new: the hit was recorded but did not
 * become work. The engine stamps these onto `watcher_events.disposition`.
 */
export type IntakeDisposition =
  | "playbook"
  | "came_in"
  | "grouped"
  | "filed"
  | "error";

/**
 * Everything intake accepts for tests. Production passes nothing.
 *
 * The gate's options ride along unchanged; `extractor` is the comprehension
 * side's one injectable seam (a network call, not logic).
 */
export interface IntakeOptions extends DecideArrivalsOptions {
  extractor?: ArrivalExtractor;
  /** Injectable clock for the deadline-plausibility bounds. */
  now?: number;
}

export interface IntakeResult {
  /** Events that a playbook handled. */
  playbookFired: number;
  /** Events filed straight into the Came-in lane (no playbook matched). */
  cameInFiled: number;
  /** Events the relevance gate kept out of the lane. */
  filedAway: number;
}

/** The channel key a watcher's events carry (e.g. 'watcher:gmail'). */
export function watcherChannel(watcher: Watcher): string {
  return `watcher:${watcher.providerId}`;
}

/**
 * Mint the work items for decisions a `record_only` source derived.
 *
 * The narrow exception to "a recording source hands the owner nothing", and it
 * deliberately shares almost none of the machinery above. There is no relevance
 * gate (the rule that produced the decision IS the judgement, and it is
 * deterministic), no grouping (a decision is not a message in a thread) and no
 * comprehension pass (the title is already the decision — sending it to a model
 * to be reworded could only make it worse, and would spend a call to do it).
 *
 * Idempotency rests on `recordArrival` being idempotent on (channel,
 * externalId) plus the decision's key being derived from the events rather than
 * generated: the same conflict re-derived on every poll for the next three
 * months finds its own arrival row and stops. The second guard —
 * `arrival.workItemId` — covers the poll that recorded an arrival and then
 * failed before minting, which must retry rather than be lost.
 *
 * Returns how many work items were newly minted.
 */
export function fileWatcherDecisions(
  watcher: Watcher,
  decisions: readonly WatcherDecision[],
): number {
  if (decisions.length === 0) return 0;
  const channel = watcherChannel(watcher);
  let minted = 0;

  for (const decision of decisions) {
    try {
      const arrival = recordArrival({
        channel,
        externalId: decision.externalId,
        watcherId: watcher.id,
        title: decision.title,
        snippet: decision.snippet,
        sourceContext: JSON.stringify({
          origin: channel,
          watcherId: watcher.id,
          watcherName: watcher.name,
          eventType: decision.kind,
          sourceId: decision.externalId,
          snippet: decision.snippet.slice(0, 500),
        }),
        disposition: "surfaced",
        reason: decision.reason,
        decidedBy: "rule",
        ruleId: decision.ruleId,
      });

      // Already in front of the owner from an earlier poll.
      if (arrival.workItemId) continue;

      const workItem = createWorkItemForArrival(arrival, {
        notes: `From ${watcher.name} · ${decision.kind}`,
      });
      minted++;

      // Best-effort, and separately guarded: triage picks the lens a decision
      // belongs in (a dinner clash is life, a review clash is work), and a
      // model outage must cost the lens, never the item — which by this point
      // already exists and is bound to its arrival.
      void triageAndMaybeAutoRunWorkItem(workItem.id, {
        skipAutoRun: true,
      }).catch((err: unknown) => {
        log.warn(
          { err: String(err), workItemId: workItem.id },
          "triage failed for a calendar decision (item still surfaced)",
        );
      });
    } catch (err) {
      log.warn(
        { err: String(err), watcherId: watcher.id, key: decision.externalId },
        "failed to mint a decision (others unaffected)",
      );
    }
  }

  if (minted > 0) {
    log.info({ watcherId: watcher.id, minted }, "decisions surfaced");
    broadcastMessage({ type: "tasks_changed" });
  }
  return minted;
}

/**
 * The decision keys this watcher currently has in front of the owner.
 *
 * `queued` only, and that is the whole of the safety argument for retiring
 * anything. The moment an item is running, awaiting review, done, cancelled or
 * archived, somebody has taken a position on it — and a row somebody has moved
 * is theirs, not the detector's to reach back into.
 */
export function openDecisionKeys(watcher: Watcher): string[] {
  const channel = watcherChannel(watcher);
  try {
    return listWorkItems({ includeUnComprehended: true })
      .filter(
        (item) =>
          item.sourceType === channel &&
          item.status === "queued" &&
          (item.sourceId ?? "").startsWith(DECISION_ID_PREFIX),
      )
      .map((item) => item.sourceId as string);
  } catch (err) {
    // No keys means nothing is offered for retirement, which means nothing is
    // hidden. This failure costs the sweep, never an item.
    log.warn(
      { err: String(err), watcherId: watcher.id },
      "could not read open decisions (nothing retired this poll)",
    );
    return [];
  }
}

/**
 * Retire the decisions the source has proved are settled.
 *
 * The other half of "a conflict is work": work that is finished leaves the
 * lane. Without this the detector only ever adds — a conflict key carries no
 * date and is idempotent forever, so the row for a dinner the owner moved
 * three weeks ago sits in the lane until they dismiss it by hand. That is the
 * no-op the flood guard was supposed to prevent, arriving one row at a time.
 *
 * `archived`, never `done`: the owner resolved this on their calendar, and
 * marking it done would be Cue claiming a completion it had no part in. The
 * row, its notes and its arrival all survive, and the note says which fact
 * retired it so "why did this leave my lane" has an answer on the item itself.
 *
 * The proof is the caller's to make. This function trusts `keys` and only
 * re-checks the one thing it owns: that the item is still `queued`.
 */
export function retireResolvedDecisions(
  watcher: Watcher,
  keys: readonly string[],
): number {
  if (keys.length === 0) return 0;
  const channel = watcherChannel(watcher);
  const wanted = new Set(keys);
  let retired = 0;

  let items: ReturnType<typeof listWorkItems>;
  try {
    items = listWorkItems({ includeUnComprehended: true });
  } catch (err) {
    log.warn(
      { err: String(err), watcherId: watcher.id },
      "could not read work items (nothing retired this poll)",
    );
    return 0;
  }

  for (const item of items) {
    if (item.sourceType !== channel) continue;
    if (item.status !== "queued") continue;
    if (!item.sourceId || !wanted.has(item.sourceId)) continue;
    try {
      updateWorkItem(item.id, {
        status: "archived",
        notes: [item.notes, RESOLVED_NOTE].filter(Boolean).join("\n"),
      });
      retired++;
    } catch (err) {
      log.warn(
        { err: String(err), workItemId: item.id },
        "failed to retire a settled decision (others unaffected)",
      );
    }
  }

  if (retired > 0) {
    log.info({ watcherId: watcher.id, retired }, "settled decisions retired");
    broadcastMessage({ type: "tasks_changed" });
  }
  return retired;
}

/** Why a decision left the lane, written onto the item that left. */
const RESOLVED_NOTE =
  "Retired by Cue: the calendar no longer shows these overlapping.";

function toPlaybookEvent(watcher: Watcher, event: WatcherEvent): PlaybookEvent {
  return {
    channel: watcherChannel(watcher),
    watcherId: watcher.id,
    title: event.summary || `${watcher.name}: ${event.eventType}`,
    summary: event.payloadJson,
    sourceType: watcherChannel(watcher),
    sourceId: event.externalId,
    sourceContext: JSON.stringify({
      origin: watcherChannel(watcher),
      watcherId: watcher.id,
      watcherName: watcher.name,
      eventType: event.eventType,
      sourceId: event.externalId,
      snippet: event.summary.slice(0, 500),
      capturedAt: event.createdAt,
    }),
  };
}

/**
 * File a batch of new watcher events. Best-effort per event: one failure never
 * blocks the rest, and a failure always errs toward the owner seeing the item.
 * Returns per-event dispositions so the engine can stamp them.
 *
 * `opts` is injected by tests only (a deterministic judge / floor context);
 * production callers pass nothing and get the real gate.
 */
export async function fileWatcherEventsToCameIn(
  watcher: Watcher,
  events: WatcherEvent[],
  opts: IntakeOptions = {},
): Promise<Map<string, IntakeDisposition>> {
  const dispositions = new Map<string, IntakeDisposition>();
  const channel = watcherChannel(watcher);

  // ── Pass 1: playbooks ────────────────────────────────────────────────
  // A playbook is the owner having already said "this kind of thing matters",
  // so it outranks the gate entirely and never consumes a judging call.
  const ungated: Array<{ event: WatcherEvent; pbEvent: PlaybookEvent }> = [];
  for (const event of events) {
    try {
      const pbEvent = toPlaybookEvent(watcher, event);
      const fired = await evaluatePlaybooksForEvent(pbEvent);
      if (fired) {
        recordArrival({
          channel,
          externalId: event.externalId,
          watcherId: watcher.id,
          eventId: event.id,
          title: pbEvent.title,
          snippet: event.summary,
          sourceContext: pbEvent.sourceContext,
          disposition: "surfaced",
          reason: "one of your playbooks claimed this",
          decidedBy: "playbook",
          occurredAt: event.occurredAt,
        });
        dispositions.set(event.id, "playbook");
        continue;
      }
      ungated.push({ event, pbEvent });
    } catch (err) {
      log.warn(
        { err: String(err), watcherId: watcher.id, eventId: event.id },
        "playbook evaluation failed (event still goes to the gate)",
      );
      // A playbook failure must not lose the event — push it to the gate,
      // which biases toward surfacing.
      ungated.push({ event, pbEvent: toPlaybookEvent(watcher, event) });
    }
  }
  if (ungated.length === 0) return dispositions;

  // ── Pass 2: the relevance gate ───────────────────────────────────────
  // One batched decision for the whole poll: the deterministic rules and the
  // safety floor are per-item and free, and the ambiguous middle shares a
  // single model call.
  const signals = ungated.map(({ event, pbEvent }) =>
    buildArrivalSignals({
      channel,
      externalId: event.externalId,
      title: pbEvent.title,
      summary: event.summary,
      payloadJson: event.payloadJson,
    }),
  );

  let decisions: Awaited<ReturnType<typeof decideArrivals>>;
  try {
    decisions = await decideArrivals(signals, opts);
  } catch (err) {
    // decideArrivals is written not to reject; if it somehow does, every event
    // surfaces. An outage must never swallow somebody's mail.
    log.warn(
      { err: String(err), watcherId: watcher.id },
      "relevance gate failed (surfacing everything)",
    );
    decisions = new Map();
  }

  // Items minted this poll, collected for the single batched comprehension
  // call below. Grouped messages are deliberately absent: they are updates to
  // an item that was already read, not new things to name.
  const comprehensionCandidates: ComprehensionCandidate[] = [];
  let grouped = 0;

  for (const { event, pbEvent } of ungated) {
    try {
      const decision = decisions.get(event.externalId) ?? {
        disposition: "surfaced" as const,
        reason: "Cue could not judge this one, so it kept it for you",
        decidedBy: "fallback" as const,
        ruleId: null,
        confidence: null,
      };
      const signal = signals.find((s) => s.externalId === event.externalId);

      const arrival = recordArrival({
        channel,
        externalId: event.externalId,
        watcherId: watcher.id,
        eventId: event.id,
        title: pbEvent.title,
        senderAddress: signal?.senderAddress ?? null,
        senderName: signal?.senderName ?? null,
        snippet: signal?.snippet ?? event.summary,
        sourceContext: pbEvent.sourceContext,
        disposition: decision.disposition,
        reason: decision.reason,
        decidedBy: decision.decidedBy,
        ruleId: decision.ruleId,
        confidence: decision.confidence,
        occurredAt: event.occurredAt,
      });

      if (arrival.disposition === "filed") {
        // Recorded, browsable, reversible — and not in the owner's lane.
        dispositions.set(event.id, "filed");
        continue;
      }

      // An idempotent re-record can return a row that already has a work item
      // (a replayed poll); do not mint a second one for the same arrival.
      if (arrival.workItemId) {
        dispositions.set(event.id, "came_in");
        continue;
      }

      // Is this the same thing as something the owner already has open — the
      // next reply in a conversation, or the fifteenth alert from one robot?
      // Folding it in beats adding a row they have to read twice. Returns null
      // for anything that opens a new group, or when grouping is off, so the
      // path below is unchanged from the pre-grouping behaviour.
      const attachment = signal
        ? attachArrivalToGroup(arrival, signal, {
            ...(opts.now !== undefined ? { now: opts.now } : {}),
          })
        : null;
      if (attachment) {
        grouped++;
        log.info(
          {
            watcherId: watcher.id,
            workItemId: attachment.workItem.id,
            groupKind: attachment.groupKind,
            count: attachment.count,
          },
          "arrival folded into an existing item",
        );
        dispositions.set(event.id, "grouped");
        continue;
      }

      const workItem = createWorkItemForArrival(arrival, {
        notes: `From ${watcher.name} · ${event.eventType}`,
      });
      // Open a group so the NEXT message in this conversation (or from this
      // robot) has something to find. Best-effort: no anchor simply means the
      // item never grows a group.
      if (signal) recordGroupAnchor(arrival, signal, workItem.id);
      await triageAndMaybeAutoRunWorkItem(workItem.id, { skipAutoRun: true });
      comprehensionCandidates.push({
        workItemId: workItem.id,
        arrivalId: arrival.id,
        title: workItem.title,
        snippet: arrival.snippet,
        senderName: arrival.senderName,
        senderAddress: arrival.senderAddress,
      });
      dispositions.set(event.id, "came_in");
    } catch (err) {
      log.warn(
        { err: String(err), watcherId: watcher.id, eventId: event.id },
        "failed to file watcher event (others unaffected)",
      );
      dispositions.set(event.id, "error");
    }
  }

  // ── Pass 3: comprehension ────────────────────────────────────────────
  // One batched flash call for everything that became a new item this poll,
  // AFTER every arrival is already recorded and in the lane. A failure here
  // costs a good title, never an arrival — and it cannot wedge intake, because
  // `comprehendArrivals` never rejects and is bounded by its own deadline.
  let comprehended = 0;
  if (comprehensionCandidates.length > 0) {
    const result = await comprehendArrivals(comprehensionCandidates, {
      ...(opts.extractor ? { extractor: opts.extractor } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    comprehended = result.comprehended;
  }

  if (grouped > 0 || comprehended > 0) {
    // Titles changed and rows merged: clients hold stale copies until they
    // refetch, and a merge the owner cannot see happen is the one thing worse
    // than not merging.
    broadcastMessage({ type: "tasks_changed" });
  }

  return dispositions;
}
