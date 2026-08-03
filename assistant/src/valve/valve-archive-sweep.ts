/**
 * The 48-hour rest sweep — design's "unreadable noise → auto-archive at 48h".
 *
 * ## Archive is not delete, and this file is where that has to be true
 *
 * `archived` is an existing, ordinary work-item status. An archived item is
 * still a row, still returned by `listWorkItems({ status: "archived" })`, still
 * carries its arrival, its band and the reason for both, and can be moved back
 * to `queued` by the same route that archives anything else. Nothing here
 * issues a DELETE, and nothing here touches `arrivals` — the record of what
 * came in and what Cue decided about it is untouched by definition.
 *
 * ## What it will and will not archive
 *
 * The eligibility list is deliberately short, and every entry on it is a
 * POSITIVE decision somebody made:
 *
 *   · `automated_sender` — a structural fact about the sender's address, with
 *     the transactional carve-out already applied upstream.
 *   · `learned_down` — the owner said so, at least twice, more often than they
 *     contradicted themselves.
 *
 * Everything else is excluded, and the exclusions matter more than the list:
 *
 *   · `gate_unsure` — the gate could not judge it. Archiving an item Cue never
 *     understood is how "I don't know" silently becomes "gone", which is the
 *     exact failure this codebase has already had once.
 *   · `cue_is_holding` — Cue's own queue. Archiving work Cue intends to run
 *     would cancel it by side effect.
 *   · `already_seen` — computed at read time, never stamped, so it cannot
 *     reach here anyway; listed so nobody adds it later.
 *   · Anything unbanded — no row, no eligibility. Never swept.
 *   · Anything not `queued` — running, awaiting review, failed. If it is
 *     moving or blocked on somebody, it is not noise.
 */

import { getConfig } from "../config/loader.js";
import { ValveConfigSchema } from "../config/schemas/valve.js";
import { getLogger } from "../util/logger.js";
import {
  listWorkItems,
  updateWorkItem,
} from "../work-items/work-item-store.js";
import { BAND_EVERYTHING, type ValveRuleId } from "./valve-bands.js";
import { getBands } from "./valve-store.js";

const log = getLogger("valve-archive-sweep");

/**
 * The only rules whose items may be archived. A closed set, typed as rule ids
 * so adding a rule to the union does not silently opt it in here.
 */
export const ARCHIVABLE_RULES: ReadonlySet<ValveRuleId> = new Set<ValveRuleId>([
  "automated_sender",
  "learned_down",
]);

/** At most this many per sweep, so one pass can never surprise the owner. */
export const MAX_ARCHIVES_PER_SWEEP = 50;

export interface ArchiveSweepResult {
  considered: number;
  archived: number;
  /** Set when the sweep did nothing because it is switched off. */
  skipped?: "disabled";
}

/**
 * Archive the quiet, aged, positively-demoted pile. Never throws.
 *
 * Returns counts rather than logging only, because "the sweep ran and did
 * nothing" and "the sweep did not run" are different facts and a caller — a
 * test, a health route, a person at a console — has to be able to tell them
 * apart. A no-op that reports success is how a dead branch stays dead.
 */
export function runValveArchiveSweep(now = Date.now()): ArchiveSweepResult {
  let cfg: ReturnType<typeof ValveConfigSchema.parse>;
  try {
    cfg = ValveConfigSchema.parse(getConfig().valve ?? {});
  } catch (err) {
    // A config we cannot read is not permission to archive anything.
    log.warn({ err: String(err) }, "valve config unreadable — sweep skipped");
    return { considered: 0, archived: 0, skipped: "disabled" };
  }
  if (!cfg.autoArchive.enabled) {
    return { considered: 0, archived: 0, skipped: "disabled" };
  }

  const cutoff = now - cfg.autoArchive.afterHours * 3_600_000;
  let considered = 0;
  let archived = 0;

  try {
    // Only `queued`. An item that is running, awaiting review or failed is
    // either moving or blocked on a person, and neither is noise.
    const candidates = listWorkItems({ status: "queued" }).filter(
      (item) => item.updatedAt <= cutoff,
    );
    if (candidates.length === 0) return { considered: 0, archived: 0 };

    const bands = getBands(candidates.map((i) => i.id));
    for (const item of candidates) {
      if (archived >= MAX_ARCHIVES_PER_SWEEP) break;
      const row = bands.get(item.id);
      // No band row → never swept. This is the same fail-open guarantee the
      // reader uses: unbanded means loud, and loud means untouchable here.
      if (!row) continue;
      if (row.band !== BAND_EVERYTHING) continue;
      // `bandedBy: 'fallback'` means the valve defaulted rather than decided.
      // A default is not a judgement and must never authorise an archive.
      if (row.bandedBy === "fallback") continue;
      if (!ARCHIVABLE_RULES.has(row.ruleId as ValveRuleId)) continue;

      considered += 1;
      try {
        updateWorkItem(
          item.id,
          {
            status: "archived",
            lastProgressNote: `Rested by the volume valve · ${row.reason}. Still here — reopen it any time.`,
          },
          { actor: "valve" },
        );
        archived += 1;
      } catch (err) {
        log.warn(
          { err: String(err), workItemId: item.id },
          "could not archive a rested item",
        );
      }
    }
  } catch (err) {
    log.warn({ err: String(err) }, "valve archive sweep failed");
    return { considered, archived };
  }

  if (archived > 0) {
    log.info(
      { considered, archived, afterHours: cfg.autoArchive.afterHours },
      "valve rested quiet work into the archive (nothing deleted)",
    );
  }
  return { considered, archived };
}

let activeTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic sweep. Idempotent. The timer is unref'd — it must never
 * hold the daemon process open.
 */
export function startValveArchiveSweeper(): { stop: () => void } {
  if (activeTimer) {
    const existing = activeTimer;
    return { stop: () => clearInterval(existing) };
  }
  const timer = setInterval(
    () => {
      try {
        runValveArchiveSweep();
      } catch (err) {
        log.warn({ err: String(err) }, "valve archive sweep tick threw");
      }
    },
    60 * 60 * 1000,
  );
  timer.unref?.();
  activeTimer = timer;
  log.info("valve archive sweeper started");
  return {
    stop() {
      clearInterval(timer);
      activeTimer = null;
    },
  };
}
