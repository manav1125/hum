/**
 * Retire the work items a calendar watcher should never have minted.
 *
 * ── What this is cleaning up ───────────────────────────────────────────────
 * The calendar watcher was auto-provisioned with `intakeMode: 'came_in'`, the
 * same mode as Gmail, so every event it detected became a row in the owner's
 * queue. That is wrong on its own terms — a meeting is something you attend,
 * not something in a queue, and the day rail already shows it — and it became
 * visible when a single edit to a recurring series bumped `updated` on six
 * years of stored exception instances at once, minting 111 items in ninety
 * minutes, titled with dates in 2020 and 2021.
 *
 * The code fix (a pinned `record_only` intake mode plus a horizon bound in the
 * provider) stops the next one. This module deals with the rows already in
 * front of the owner.
 *
 * ── The discipline ─────────────────────────────────────────────────────────
 * DRY RUN BY DEFAULT — {@link cleanupCalendarWorkItems} writes only when
 * `apply` is true. NOTHING IS DELETED: an item is moved to `archived`, which
 * keeps the row, its notes, its history and its arrival. Every applied run
 * emits a manifest recording each item's previous status, and
 * {@link revertCalendarCleanup} puts them all back from it.
 *
 * ── What it refuses to touch ───────────────────────────────────────────────
 * Anything the owner has had a hand in. A calendar event that genuinely IS a
 * commitment needing preparation is a real thing, and the moment somebody
 * files one into a project, dates it, runs it or renames its notes, it has
 * stopped being noise and this tool has no business archiving it. Those items
 * are kept and the report says which signal saved each one, so "nothing was
 * touched" is a claim you can check rather than trust.
 *
 * The test is deliberately conservative in one direction only: an ambiguous
 * item is KEPT. Signals written by Cue itself (the triage assessment, the
 * comprehension pass that rewrites a title, `updated_at` moving because of
 * either) are NOT owner touches and are ignored — treating them as touches
 * would exempt every row and make the tool useless.
 */

import { getDb } from "../memory/db-connection.js";
import { workItemComprehension } from "../memory/schema.js";
import { getLogger } from "../util/logger.js";
import {
  listWorkItems,
  updateWorkItem,
  type WorkItem,
} from "../work-items/work-item-store.js";
import { listWatcherEvents } from "./watcher-store.js";

const log = getLogger("calendar-cleanup");

/** Work-item `source_type` values a calendar watcher writes. */
export const CALENDAR_CHANNELS = [
  "watcher:google-calendar",
  "watcher:outlook-calendar",
] as const;

/** Actor recorded on every write this tool makes. */
export const CLEANUP_ACTOR = "calendar-work-item-cleanup";

/** Manifest format version, so a future reader can refuse an old file. */
export const MANIFEST_VERSION = 1 as const;

/**
 * The notes intake stamps on a freshly minted arrival item: `From <watcher
 * name> · <event type>`. Notes that still match this were written by Cue;
 * notes that do not were written by somebody.
 */
const MINTED_NOTES = /^From .+ · [a-z_]+$/;

/**
 * The assignee `createWorkItem` stamps on every row when nobody said
 * otherwise. Treating it as a claim would mark every item as touched and make
 * this tool silently do nothing — which is exactly what the first run of its
 * own tests did.
 */
const DEFAULT_ASSIGNEE = "cue";

/** What the sweep decided about one item. */
export type CleanupAction = "archive" | "keep";

export interface CleanupItemReport {
  workItemId: string;
  title: string;
  /** The calendar event id this item came from, when it is still known. */
  externalId: string | null;
  status: string;
  action: CleanupAction;
  /** In plain words, why it is being archived or why it was left alone. */
  reason: string;
  /** Every owner-touch signal found on this row. Empty for an archived one. */
  touchedBy: string[];
  /**
   * Whether the underlying event has already finished. Reported, not acted on
   * — an upcoming meeting is no more a task than a past one. It is here so a
   * dry run shows at a glance how much of the batch is pure history.
   */
  eventEnded: boolean | null;
}

export interface CleanupReport {
  channels: string[];
  /** False on a dry run: every number below is what WOULD have happened. */
  applied: boolean;
  scanned: number;
  archived: number;
  kept: number;
  /** Of the archived items, how many were for events already in the past. */
  archivedPastEvents: number;
  /** Where the undo manifest was written (null on a dry run). */
  manifestPath: string | null;
  items: CleanupItemReport[];
}

export interface CleanupManifest {
  version: typeof MANIFEST_VERSION;
  appliedAt: number;
  channels: string[];
  items: Array<{
    workItemId: string;
    title: string;
    /** The status the item had before this tool changed it. */
    previousStatus: string;
  }>;
}

export interface CleanupOptions {
  /** Work-item `sourceType`s to sweep. Defaults to {@link CALENDAR_CHANNELS}. */
  channels?: readonly string[];
  /** Write. Defaults to FALSE — the dry run is the review gate. */
  apply?: boolean;
  /** Stop after this many candidates. */
  limit?: number;
  /** Injectable clock, for deciding whether an event has already happened. */
  now?: number;
  /** How many watcher events to index when resolving event times. */
  eventScanLimit?: number;
}

/** How many watcher events to pull when indexing payloads by external id. */
const DEFAULT_EVENT_SCAN_LIMIT = 20_000;

/** True for a labels column that holds at least one actual label. */
function hasLabels(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length > 0 : true;
  } catch {
    return raw.trim().length > 0;
  }
}

/**
 * Every reason this item belongs to the owner rather than to the watcher.
 *
 * Each entry is a fact about a column somebody had to act to set. Read the
 * list, not the boolean: the report prints these verbatim so a kept item can
 * be argued with.
 *
 * `comprehendedDueAt` is the deadline Cue's own comprehension pass extracted
 * for this item, when it extracted one. It has to be passed in because a due
 * date is the one field on this row that BOTH the owner and Cue write, and
 * treating Cue's own output as the owner's hand would exempt an item from a
 * cleanup on the strength of a title Cue also wrote. Verified against the live
 * data: two of the calendar rows carried a comprehended verb-phrase title and
 * a deadline and nothing else — no project, no run, no edit.
 */
export function ownerTouchSignals(
  item: WorkItem,
  comprehendedDueAt?: number | null,
): string[] {
  const touched: string[] = [];

  // Status. A queued item is exactly where intake left it; anything else means
  // it was started, finished, parked or filed by hand.
  if (item.status !== "queued") touched.push(`status is "${item.status}"`);

  if (item.projectId) touched.push("filed into a project");
  if (item.dueAt !== null && item.dueAt !== comprehendedDueAt) {
    touched.push("given a due date");
  }
  // An empty `[]` is what an automatic pass leaves behind, not a label.
  if (hasLabels(item.labels)) touched.push("labelled");
  if (item.assignee && item.assignee !== DEFAULT_ASSIGNEE) {
    touched.push(`assigned to ${item.assignee}`);
  }
  if (item.taskBudgetCents) touched.push("given a budget");
  if (item.context) touched.push("has notes the owner added");
  if (item.waitingOn) touched.push("marked as waiting on someone");

  // A run happened. Any of the three is enough — they are written at
  // different points of the run lifecycle and a crash can leave only one.
  if (item.lastRunId) touched.push("has been run");
  else if (item.lastRunConversationId) touched.push("has a run conversation");
  else if (item.lastRunStatus) touched.push(`has a run result`);
  if (item.lastProgressNote) touched.push("has a progress note");
  if (item.recoveryAttempts > 0) touched.push("was recovered after a run");
  if (item.livenessState) touched.push(`liveness "${item.livenessState}"`);
  if (item.completedElsewhere) touched.push("marked done elsewhere");

  // Tool approval is always an explicit human decision.
  if (item.approvalStatus && item.approvalStatus !== "none") {
    touched.push(`approval "${item.approvalStatus}"`);
  }
  if (item.approvedTools) touched.push("has approved tools");

  // Notes. Intake writes `From <watcher> · <event type>` and nothing else
  // rewrites them, so anything else in there is a person's hand.
  if (item.notes && !MINTED_NOTES.test(item.notes)) {
    touched.push("notes were edited");
  }

  return touched;
}

/** End of the calendar event behind an item, in epoch ms, when knowable. */
function eventEndFromPayload(payloadJson: string): number | null {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as { end?: unknown; start?: unknown };
    const raw = typeof p.end === "string" && p.end ? p.end : p.start;
    if (typeof raw !== "string" || raw === "") return null;
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/**
 * Sweep calendar-sourced work items, archiving the untouched ones.
 *
 * Returns a report whether or not anything was written; on a dry run every
 * count describes what an `apply` run would do.
 */
export function cleanupCalendarWorkItems(opts: CleanupOptions = {}): {
  report: CleanupReport;
  manifest: CleanupManifest | null;
} {
  const channels = [...(opts.channels ?? CALENDAR_CHANNELS)];
  const apply = opts.apply ?? false;
  const now = opts.now ?? Date.now();

  const report: CleanupReport = {
    channels,
    applied: apply,
    scanned: 0,
    archived: 0,
    kept: 0,
    archivedPastEvents: 0,
    manifestPath: null,
    items: [],
  };

  // Deadlines Cue extracted for itself. See `ownerTouchSignals`: without this,
  // an item Cue titled and dated on its own way in looks like one the owner
  // dated by hand. Best-effort — an unreadable table just means those items
  // are kept, which is the safe direction.
  const comprehendedDueAt = new Map<string, number | null>();
  try {
    for (const row of getDb()
      .select({
        workItemId: workItemComprehension.workItemId,
        dueAt: workItemComprehension.dueAt,
      })
      .from(workItemComprehension)
      .all()) {
      comprehendedDueAt.set(row.workItemId, row.dueAt);
    }
  } catch (err) {
    log.warn(
      { err: String(err) },
      "could not read comprehension deadlines; items Cue dated itself will be kept",
    );
  }

  // Index event payloads by external id so we can say whether each item's
  // meeting has already happened. Best-effort: a missing event costs a line in
  // the report, never a decision.
  const endByExternalId = new Map<string, number | null>();
  try {
    for (const event of listWatcherEvents({
      limit: opts.eventScanLimit ?? DEFAULT_EVENT_SCAN_LIMIT,
    })) {
      if (!endByExternalId.has(event.externalId)) {
        endByExternalId.set(
          event.externalId,
          eventEndFromPayload(event.payloadJson),
        );
      }
    }
  } catch (err) {
    log.warn(
      { err: String(err) },
      "could not index watcher events; the report will not say which meetings are past",
    );
  }

  // `includeUnComprehended` because this is a WRITER: it must reason about
  // every row that exists, not the subset a reader would be shown.
  const candidates = listWorkItems({ includeUnComprehended: true }).filter(
    (item) =>
      item.sourceType !== null &&
      channels.includes(item.sourceType) &&
      item.status !== "archived",
  );

  const manifestItems: CleanupManifest["items"] = [];

  for (const item of candidates) {
    if (opts.limit !== undefined && report.scanned >= opts.limit) break;
    report.scanned++;

    const externalId = item.sourceId ?? null;
    const end = externalId ? (endByExternalId.get(externalId) ?? null) : null;
    const eventEnded = end === null ? null : end < now;

    const touchedBy = ownerTouchSignals(
      item,
      comprehendedDueAt.get(item.id) ?? undefined,
    );
    if (touchedBy.length > 0) {
      report.kept++;
      report.items.push({
        workItemId: item.id,
        title: item.title,
        externalId,
        status: item.status,
        action: "keep",
        reason: "you have worked on this one, so it was left exactly as it is",
        touchedBy,
        eventEnded,
      });
      continue;
    }

    if (apply) {
      try {
        updateWorkItem(
          item.id,
          { status: "archived" },
          { actor: CLEANUP_ACTOR },
        );
      } catch (err) {
        // A write failure must leave the item where it was, and must not stop
        // the sweep.
        log.warn(
          { err: String(err), workItemId: item.id },
          "could not archive this item; left it in the lane",
        );
        report.kept++;
        report.items.push({
          workItemId: item.id,
          title: item.title,
          externalId,
          status: item.status,
          action: "keep",
          reason: "Cue could not archive this one, so it stayed in the lane",
          touchedBy: [],
          eventEnded,
        });
        continue;
      }
      manifestItems.push({
        workItemId: item.id,
        title: item.title,
        previousStatus: item.status,
      });
    }

    report.archived++;
    if (eventEnded === true) report.archivedPastEvents++;
    report.items.push({
      workItemId: item.id,
      title: item.title,
      externalId,
      status: item.status,
      action: "archive",
      reason:
        eventEnded === true
          ? "a meeting that has already happened is not something to do"
          : "a meeting is something you attend, not something in your queue",
      touchedBy: [],
      eventEnded,
    });
  }

  const manifest: CleanupManifest | null = apply
    ? {
        version: MANIFEST_VERSION,
        appliedAt: now,
        channels,
        items: manifestItems,
      }
    : null;

  return { report, manifest };
}

export interface RevertReport {
  /** False on a dry run. */
  applied: boolean;
  restored: number;
  /** Items the manifest names that are no longer archived — left alone. */
  skipped: Array<{ workItemId: string; reason: string }>;
}

/**
 * Put back everything an applied run archived.
 *
 * Only touches items that are still `archived`: if the owner has since done
 * something with one, their state wins and the revert reports the skip rather
 * than overwriting it.
 */
export function revertCalendarCleanup(
  manifest: CleanupManifest,
  opts: { apply?: boolean } = {},
): RevertReport {
  const apply = opts.apply ?? false;
  const out: RevertReport = { applied: apply, restored: 0, skipped: [] };

  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(
      `Unrecognised manifest version ${String(manifest.version)} (expected ${MANIFEST_VERSION})`,
    );
  }

  const byId = new Map(
    listWorkItems({ includeUnComprehended: true }).map((i) => [i.id, i]),
  );

  for (const entry of manifest.items) {
    const item = byId.get(entry.workItemId);
    if (!item) {
      out.skipped.push({
        workItemId: entry.workItemId,
        reason: "no longer exists",
      });
      continue;
    }
    if (item.status !== "archived") {
      out.skipped.push({
        workItemId: entry.workItemId,
        reason: `is "${item.status}" now — someone changed it since, so it was left alone`,
      });
      continue;
    }
    if (apply) {
      updateWorkItem(
        entry.workItemId,
        { status: entry.previousStatus as WorkItem["status"] },
        { actor: CLEANUP_ACTOR },
      );
    }
    out.restored++;
  }

  return out;
}

/** Render a report a human can read line by line. */
export function formatCleanupReport(report: CleanupReport): string {
  const lines: string[] = [];
  lines.push(
    report.applied
      ? `Calendar work-item cleanup — APPLIED to ${report.channels.join(", ")}`
      : `Calendar work-item cleanup — DRY RUN over ${report.channels.join(", ")} (nothing was written)`,
  );
  lines.push(
    `${report.scanned} scanned · ${report.archived} to archive · ${report.kept} kept` +
      (report.archived > 0
        ? ` · ${report.archivedPastEvents} of the archived are meetings that already happened`
        : ""),
  );

  const kept = report.items.filter((i) => i.action === "keep");
  if (kept.length > 0) {
    lines.push("", `Kept (${kept.length}) — you have touched these:`);
    for (const i of kept) {
      lines.push(`  · ${i.title}`);
      lines.push(
        `      ${i.reason}${i.touchedBy.length > 0 ? ` [${i.touchedBy.join("; ")}]` : ""}`,
      );
    }
  }

  const archived = report.items.filter((i) => i.action === "archive");
  if (archived.length > 0) {
    lines.push(
      "",
      `Archived (${archived.length}) — nothing deleted, all restorable from the manifest:`,
    );
    for (const i of archived) {
      lines.push(`  · ${i.title}`);
    }
  }

  if (report.manifestPath) {
    lines.push("", `Undo manifest: ${report.manifestPath}`);
  }
  return lines.join("\n");
}
