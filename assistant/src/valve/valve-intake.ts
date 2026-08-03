/**
 * Banding at intake — the write side of the volume valve.
 *
 * One function, {@link bandWorkItem}, called wherever a work item comes into
 * existence. It resolves the two batch inputs the pure rules need (what the
 * owner has taught the valve, which missions they have turned up), runs
 * {@link bandItem}, and stamps the verdict.
 *
 * It is `void`-returning and swallows everything. That is safe for exactly one
 * reason and it is worth naming: **a work item with no band row is urgent.**
 * If this function throws, does nothing, is never called, or is deleted
 * outright, every affected item keeps interrupting the owner exactly as it
 * does today. The valve can only ever fail toward noise.
 */

import { type Arrival, getArrival } from "../arrivals/arrival-store.js";
import { getConfig } from "../config/loader.js";
import { ValveConfigSchema } from "../config/schemas/valve.js";
import { getLogger } from "../util/logger.js";
import type { WorkItem } from "../work-items/work-item-store.js";
import { type BandContext, bandItem, type BandVerdict } from "./valve-bands.js";
import {
  boostedProjectIds,
  learnedDownSenders,
  stampBand,
} from "./valve-store.js";

const log = getLogger("valve-intake");

/**
 * Is the valve switched on?
 *
 * Parsed through the schema rather than read off the object, for the same
 * reason the arrival gate does it: a config that predates this feature has no
 * `valve` key, and reading `.enabled` off undefined would throw. The throw
 * would be caught and read as "off", which is the safe direction but a
 * confusing thing to find in a log. Parsing gives the same answer honestly.
 *
 * Note which way "off" points. Disabled means nothing is banded, and an
 * unbanded item reads as urgent — so switching the valve off makes Cue
 * noisier, never quieter. That is the only acceptable direction for a
 * feature flag on a filter to fail.
 */
function valveEnabled(): boolean {
  try {
    return ValveConfigSchema.parse(getConfig().valve ?? {}).enabled;
  } catch (err) {
    log.warn({ err: String(err) }, "valve config unreadable — banding skipped");
    return false;
  }
}

/**
 * The batch inputs, resolved once for a whole intake run rather than per item.
 *
 * Two queries for a hundred arrivals instead of two hundred, and — more
 * importantly — it keeps {@link bandItem} free of I/O, so the rules stay a
 * pure function that a test can drive with a literal.
 */
export function buildBandContext(now = Date.now()): BandContext {
  const learned = learnedDownSenders();
  return {
    now,
    isLearnedDown: (senderKey) => learned.has(senderKey.toLowerCase()),
    boostedProjectIds: boostedProjectIds(),
  };
}

export interface BandWorkItemOptions {
  /** Built once per batch by {@link buildBandContext}; built here if absent. */
  ctx?: BandContext;
  /**
   * The arrival to band against, when the caller already holds a fresher copy
   * than `item.arrivalId` would fetch — the reversal path, where the row was
   * just rewritten, and the restore path, where the work item's `arrivalId`
   * may predate the link. Omit and it is looked up.
   */
  arrival?: Arrival | null;
}

/**
 * Band and stamp one work item. Never throws.
 *
 * Every option is optional so a single-item caller (a manual capture) can
 * skip the ceremony; batch callers should build the context once and pass it.
 */
export function bandWorkItem(
  item: WorkItem,
  opts: BandWorkItemOptions = {},
): BandVerdict | null {
  if (!valveEnabled()) return null;
  try {
    const context = opts.ctx ?? buildBandContext();
    const arrival =
      opts.arrival !== undefined
        ? opts.arrival
        : item.arrivalId
          ? (getArrival(item.arrivalId) ?? null)
          : null;
    const verdict = bandItem(item, arrival, context);
    stampBand({
      workItemId: item.id,
      verdict,
      arrivalId: arrival?.id ?? null,
      senderKey: arrival?.senderAddress ?? null,
      missionId: item.projectId ?? null,
    });
    return verdict;
  } catch (err) {
    // Deliberately does NOT stamp a `valve_error` row. Stamping would give the
    // item a band, and any band is quieter than no band. Leaving it unbanded
    // is what keeps it urgent, so the loudest outcome needs the loudest log
    // line rather than a database row that makes the failure look handled.
    log.warn(
      { err: String(err), workItemId: item.id },
      "valve could not band an item — it stays in front of the owner",
    );
    return null;
  }
}

/** Band a batch, sharing one context. Never throws. */
export function bandWorkItems(items: WorkItem[], now = Date.now()): void {
  if (items.length === 0) return;
  let ctx: BandContext;
  try {
    ctx = buildBandContext(now);
  } catch (err) {
    log.warn(
      { err: String(err), items: items.length },
      "valve could not build its context — the whole batch stays loud",
    );
    return;
  }
  for (const item of items) bandWorkItem(item, { ctx });
}
