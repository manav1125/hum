/**
 * The read side of the volume valve: given work items, which ones interrupt?
 *
 * This is what HQ calls. It does three things and nothing else — reads each
 * item's stamped band, compares it against the current stop, and returns BOTH
 * halves with the reason attached. It never queries a model, never writes a
 * decision, and never removes a row from anybody's database.
 *
 * ## Suppressed is not absent
 *
 * {@link applyValve} returns `shown` and `held` as two lists, not one filtered
 * list. A caller that wants the old behaviour concatenates them. A caller that
 * wants HQ renders `shown` and puts `held.length` behind a tappable number.
 * What no caller can do is receive a short list with no indication that it is
 * short — the shape of the return value makes "6 of 74" the easy thing to
 * render and "6, and you'll never know about the other 68" the hard one.
 *
 * ## Fail open, three ways
 *
 *   1. **No band row → shown.** Every work item that predates the valve, every
 *      item whose stamping failed, every item written by a code path that has
 *      never heard of the valve. There is no backfill, so on the day this
 *      ships that is every one of the owner's 131 standing items, and they all
 *      keep interrupting.
 *   2. **An unreadable bands table → everything shown.** `getBands` returns an
 *      empty map on any error, which by (1) means nothing is held.
 *   3. **An unreadable stops table → the default stop**, and a default stop
 *      only ever holds items something positively decided to quiet.
 *
 * There is no fourth way, because there is nothing else here that can fail:
 * no network, no model, no timeout, no budget. The valve is a comparison.
 */

import type { WorkItem } from "../work-items/work-item-store.js";
import {
  applyRest,
  BAND_EVERYTHING,
  BAND_URGENT,
  bandPassesStop,
  collapseSenderStreams,
  liveFloor,
  type ValveBand,
  type ValveStop,
} from "./valve-bands.js";
import {
  boostedProjectIds,
  getBands,
  getGlobalStop,
  markSurfaced,
  type ValveBandRow,
} from "./valve-store.js";

/**
 * One item, plus why it is or is not in front of the owner.
 *
 * The band and the reason ride on every item in BOTH lists. A held item that
 * could not say why it is held would be indistinguishable from a lost one,
 * and the owner would be right not to trust it.
 */
export interface ValvedWorkItem {
  item: WorkItem;
  band: ValveBand;
  /** The rule that set the band, e.g. 'automated_sender'. */
  ruleId: string;
  /** The owner's words. */
  reason: string;
  /** True when this item has no band row and is therefore loud by default. */
  unbanded: boolean;
}

export interface ValveResult {
  /** Items at or above the stop. What HQ draws. */
  shown: ValvedWorkItem[];
  /**
   * Items below the stop. NOT hidden — this is the "4 queued, none need you"
   * number, and every entry carries the reason it is here.
   */
  held: ValvedWorkItem[];
  /** The stop these lists were computed against. */
  stop: ValveStop;
  /** How many `shown` items are only shown because they have no band. */
  unbandedCount: number;
}

export interface ApplyValveOptions {
  /** Defaults to the owner's saved global stop. */
  stop?: ValveStop;
  /**
   * Record that the shown items reached the owner, so already-seen work can
   * rest on a later read. Off by default: a count, a preview or a test must
   * not be able to burn an item's one guaranteed appearance. Only the read
   * that actually renders HQ should pass true.
   */
  markSeen?: boolean;
  now?: number;
}

/**
 * The band an item carries when nothing has banded it.
 *
 * Urgent, and the constant is named rather than inlined so that anyone
 * tempted to make unbanded items quiet has to change a line that says what
 * they are doing.
 */
export const UNBANDED_BAND: ValveBand = BAND_URGENT;

function toValved(
  item: WorkItem,
  row: ValveBandRow | undefined,
  now: number,
  boosted: ReadonlySet<string>,
): ValvedWorkItem {
  // Asked first and answered first. The live floor is about the item's state
  // right now — Cue blocked on the owner, a deadline inside a day, a mission
  // turned up — and it outranks anything stamped, because a band recorded
  // yesterday cannot know that Cue got stuck this morning. It only ever
  // raises: there is no live rule that quiets anything.
  const floor = liveFloor(item, { now, boostedProjectIds: boosted });
  if (floor) {
    return {
      item,
      band: floor.band,
      ruleId: floor.ruleId,
      reason: floor.reason,
      unbanded: !row,
    };
  }
  if (!row) {
    return {
      item,
      band: UNBANDED_BAND,
      ruleId: "unbanded",
      reason:
        "Cue hasn't sized this one up yet, so it's keeping it in front of you",
      unbanded: true,
    };
  }
  const rested = applyRest(
    {
      band: row.band,
      // The stored rule id is a plain string by the time it comes back out of
      // SQLite; `applyRest` only compares it, so widening here is safe and
      // avoids a cast that would let an unknown id masquerade as a known one.
      ruleId: row.ruleId as never,
      reason: row.reason,
      bandedBy: row.bandedBy,
    },
    row.surfacedAt,
    now,
  );
  return {
    item,
    band: rested.band,
    ruleId: rested.ruleId,
    reason: rested.reason,
    unbanded: false,
  };
}

/**
 * Split work items into what interrupts and what waits.
 *
 * Pure apart from the band read and the optional seen-marking, and both of
 * those degrade to "show it" rather than throwing.
 */
export function applyValve(
  items: WorkItem[],
  opts: ApplyValveOptions = {},
): ValveResult {
  const now = opts.now ?? Date.now();
  const stop = opts.stop ?? getGlobalStop();
  const bands = getBands(items.map((i) => i.id));
  // One query per read, not one per item — and if it throws, `boostedProjectIds`
  // returns an empty set, which costs a boost rather than the whole read.
  const boosted = boostedProjectIds();

  const valvedAll = items.map((item) =>
    toValved(item, bands.get(item.id), now, boosted),
  );

  // The stream collapse. A batch-level rule, so it lives here rather than in
  // the per-item bander: nine messages from one machine are one stream, and
  // you cannot see that from inside any one of them. The newest from every
  // sender is exempt, so this thins streams and never silences a source.
  const streamHeld = collapseSenderStreams(
    valvedAll.map((v) => ({
      itemId: v.item.id,
      senderKey: bands.get(v.item.id)?.senderKey ?? null,
      band: v.band,
      ruleId: v.ruleId,
      // `createdAt` is when Cue noticed, which is the right clock HERE: this
      // is a statement about how much arrived at once, not about the
      // correspondent, so an item's own arrival order is what matters.
      occurredAt: v.item.createdAt,
    })),
  );

  const shown: ValvedWorkItem[] = [];
  const held: ValvedWorkItem[] = [];
  let unbandedCount = 0;

  for (const valved of valvedAll) {
    const streamReason = streamHeld.get(valved.item.id);
    const effective: ValvedWorkItem = streamReason
      ? {
          ...valved,
          band: BAND_EVERYTHING,
          ruleId: "sender_stream",
          reason: streamReason,
        }
      : valved;
    if (bandPassesStop(effective.band, stop)) {
      shown.push(effective);
      if (effective.unbanded) unbandedCount += 1;
    } else {
      held.push(effective);
    }
  }

  if (opts.markSeen && shown.length > 0) {
    markSurfaced(
      shown.filter((v) => !v.unbanded).map((v) => v.item.id),
      now,
    );
  }

  return { shown, held, stop, unbandedCount };
}

/** Per-band counts over a set of items, for the Glance strip's numbers. */
export function countByBand(
  valved: ValvedWorkItem[],
): Record<ValveBand, number> {
  const counts: Record<ValveBand, number> = {
    urgent: 0,
    needs_you: 0,
    everything: 0,
  };
  for (const v of valved) counts[v.band] += 1;
  return counts;
}
