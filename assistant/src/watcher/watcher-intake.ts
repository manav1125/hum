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
  decideArrivals,
  type DecideArrivalsOptions,
} from "../arrivals/arrival-gate.js";
import { buildArrivalSignals } from "../arrivals/arrival-signals.js";
import { recordArrival } from "../arrivals/arrival-store.js";
import { createWorkItemForArrival } from "../arrivals/arrival-surface.js";
import {
  evaluatePlaybooksForEvent,
  type PlaybookEvent,
} from "../playbooks/playbook-runtime.js";
import { getLogger } from "../util/logger.js";
import { triageAndMaybeAutoRunWorkItem } from "../work-items/work-item-triage.js";
import type { Watcher, WatcherEvent } from "./watcher-store.js";

const log = getLogger("watcher-intake");

/**
 * What happened to one event. `filed` is new: the hit was recorded but did not
 * become work. The engine stamps these onto `watcher_events.disposition`.
 */
export type IntakeDisposition = "playbook" | "came_in" | "filed" | "error";

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
  opts: DecideArrivalsOptions = {},
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

      const workItem = createWorkItemForArrival(arrival, {
        notes: `From ${watcher.name} · ${event.eventType}`,
      });
      await triageAndMaybeAutoRunWorkItem(workItem.id, { skipAutoRun: true });
      dispositions.set(event.id, "came_in");
    } catch (err) {
      log.warn(
        { err: String(err), watcherId: watcher.id, eventId: event.id },
        "failed to file watcher event (others unaffected)",
      );
      dispositions.set(event.id, "error");
    }
  }

  return dispositions;
}
