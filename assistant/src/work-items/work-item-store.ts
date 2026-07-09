import { asc, desc, eq, inArray, sql } from "drizzle-orm";

import { reconcileFeedForWorkItemStatus } from "../home/feed-writer.js";
import { getDb } from "../memory/db-connection.js";
import { workItems } from "../memory/schema.js";
import { getTask } from "../tasks/task-store.js";
import { recordWorkItemEvent } from "./work-item-events.js";

// ── Types ────────────────────────────────────────────────────────────

export type WorkItemStatus =
  | "queued"
  | "running"
  | "awaiting_review"
  | "failed"
  | "cancelled"
  | "done"
  | "archived";

export interface WorkItem {
  id: string;
  taskId: string;
  title: string;
  notes: string | null;
  status: WorkItemStatus;
  priorityTier: number;
  sortIndex: number | null;
  lastRunId: string | null;
  lastRunConversationId: string | null;
  lastRunStatus: string | null;
  sourceType: string | null;
  sourceId: string | null;
  requiredTools: string | null;
  approvedTools: string | null;
  approvalStatus: string | null;
  projectId: string | null;
  dueAt: number | null;
  labels: string | null;
  assignee: string | null;
  /** WS1 (302-budget-policies): per-task hard cap in cents; null/0 = unlimited (default). */
  taskBudgetCents: number | null;
  /** Per-task notes/context the user adds; injected into the agent before a run. */
  context: string | null;
  /** JSON snapshot of where the task came from (origin + original snippet). */
  sourceContext: string | null;
  /** Epoch ms; bumped on any event/update so ranking de-prioritizes stale items. */
  lastActivityAt: number | null;
  /**
   * One-line live-activity note ("Searching the web…") the runner stamps while
   * the item is `running`; cleared on terminal statuses. Lets Activity/Projects
   * boards show mid-run progress instead of a bare "running" badge.
   */
  lastProgressNote: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── CRUD ─────────────────────────────────────────────────────────────

export function createWorkItem(opts: {
  taskId: string;
  title: string;
  notes?: string;
  priorityTier?: number;
  sortIndex?: number;
  sourceType?: string;
  sourceId?: string;
  requiredTools?: string;
  projectId?: string;
  dueAt?: number;
  /** JSON array string of freeform labels. */
  labels?: string;
  /** Defaults to "cue" — the AI runs it unless a human claims it. */
  assignee?: string;
  /** Per-task notes/context the user adds; read by the agent before a run. */
  context?: string;
  /** WS1: per-task hard cap in cents; null/0 = unlimited (default). */
  taskBudgetCents?: number | null;
  /** JSON snapshot of where the task came from (origin + original snippet). */
  sourceContext?: string;
  /** Audit-trail attribution for the created event (default "system"). */
  actor?: string;
}): WorkItem {
  const db = getDb();
  const now = Date.now();
  const id = crypto.randomUUID();
  const item: WorkItem = {
    id,
    taskId: opts.taskId,
    title: opts.title,
    notes: opts.notes ?? null,
    status: "queued",
    priorityTier: opts.priorityTier ?? 1,
    sortIndex: opts.sortIndex ?? null,
    lastRunId: null,
    lastRunConversationId: null,
    lastRunStatus: null,
    sourceType: opts.sourceType ?? null,
    sourceId: opts.sourceId ?? null,
    requiredTools: opts.requiredTools ?? null,
    approvedTools: null,
    approvalStatus: "none",
    projectId: opts.projectId ?? null,
    dueAt: opts.dueAt ?? null,
    labels: opts.labels ?? null,
    assignee: opts.assignee ?? "cue",
    taskBudgetCents: opts.taskBudgetCents ?? null,
    context: opts.context ?? null,
    sourceContext: opts.sourceContext ?? null,
    // A freshly-created item is maximally fresh — seed last_activity_at so
    // ranking treats new captures as active from the moment they land.
    lastActivityAt: now,
    lastProgressNote: null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(workItems).values(item).run();
  recordWorkItemEvent({
    workItemId: id,
    kind: "created",
    toStatus: "queued",
    actor: opts.actor ?? "system",
  });
  return item;
}

/**
 * Create a work item without any pre-approved permissions. Items start
 * with `approvalStatus: 'none'` and no `approvedTools` — approval
 * happens only via the explicit preflight flow before execution.
 */
export function createWorkItemWithPermissions(opts: {
  taskId: string;
  title: string;
  notes?: string;
  priorityTier?: number;
  sortIndex?: number;
  sourceType?: string;
  sourceId?: string;
  requiredTools?: string;
}): WorkItem {
  return createWorkItem(opts);
}

export function getWorkItem(id: string): WorkItem | undefined {
  const db = getDb();
  return db.select().from(workItems).where(eq(workItems.id, id)).get() as
    | WorkItem
    | undefined;
}

export function listWorkItems(opts?: {
  status?: WorkItemStatus;
  projectId?: string;
}): WorkItem[] {
  const db = getDb();
  let query = db.select().from(workItems);
  if (opts?.status) {
    query = query.where(eq(workItems.status, opts.status)) as typeof query;
  }
  if (opts?.projectId) {
    query = query.where(
      eq(workItems.projectId, opts.projectId),
    ) as typeof query;
  }
  // Overdue live items float above everything, then the normal tier/rank order.
  const overdueFirst = sql`CASE WHEN ${workItems.dueAt} IS NOT NULL AND ${workItems.dueAt} < ${Date.now()} AND ${workItems.status} IN ('queued','running','awaiting_review') THEN 0 ELSE 1 END`;
  return query
    .orderBy(
      overdueFirst,
      asc(workItems.priorityTier),
      asc(workItems.sortIndex),
      desc(workItems.updatedAt),
    )
    .all() as WorkItem[];
}

export function updateWorkItem(
  id: string,
  updates: Partial<
    Pick<
      WorkItem,
      | "title"
      | "notes"
      | "status"
      | "priorityTier"
      | "sortIndex"
      | "lastRunId"
      | "lastRunConversationId"
      | "lastRunStatus"
      | "requiredTools"
      | "approvedTools"
      | "approvalStatus"
      | "projectId"
      | "dueAt"
      | "labels"
      | "assignee"
      | "context"
      | "sourceContext"
      | "lastProgressNote"
    >
  >,
  opts?: { actor?: string },
): WorkItem | undefined {
  const db = getDb();
  // Read-before-write so status transitions land in the audit trail from a
  // single choke point (routes, runner, triage, and cancel all pass through
  // here).
  const existing = getWorkItem(id);
  const now = Date.now();
  // Any mutation counts as activity — bump last_activity_at so next-move
  // ranking treats the item as fresh and stops de-prioritizing it as stale.
  db.update(workItems)
    .set({ ...updates, updatedAt: now, lastActivityAt: now })
    .where(eq(workItems.id, id))
    .run();
  if (
    existing &&
    updates.status !== undefined &&
    updates.status !== existing.status
  ) {
    recordWorkItemEvent({
      workItemId: id,
      kind: "status_changed",
      fromStatus: existing.status,
      toStatus: updates.status,
      actor: opts?.actor ?? "system",
    });
    // Keep the Home feed in lockstep with the queue from the status chokepoint
    // itself: any transition into a terminal state (done/cancelled/archived/
    // failed) dismisses the item's mirror card, no matter which code path
    // performed the update (routes, runner, tools, daemon handlers).
    // Fire-and-forget + idempotent — a no-op for non-terminal statuses.
    reconcileFeedForWorkItemStatus({
      id,
      title: updates.title ?? existing.title,
      sourceType: existing.sourceType,
      sourceId: existing.sourceId,
      status: updates.status,
    });
  }
  return getWorkItem(id);
}

export function deleteWorkItem(id: string): void {
  const db = getDb();
  db.delete(workItems).where(eq(workItems.id, id)).run();
}

// ── Queue Removal ───────────────────────────────────────────────────

interface RemoveWorkItemResult {
  success: boolean;
  title: string;
  message: string;
}

/**
 * Shared helper for removing a single work item from the queue by ID.
 * Used by both task_delete (compat path) and task_list_remove so all
 * single-item deletions follow one codepath.
 */
export function removeWorkItemFromQueue(id: string): RemoveWorkItemResult {
  const item = getWorkItem(id);
  if (!item) {
    return {
      success: false,
      title: "",
      message: `No work item found with ID "${id}"`,
    };
  }
  deleteWorkItem(item.id);
  // A deleted work-item must not leave its mirror "Run it" card behind on
  // Home — treat deletion as a cancellation for feed-coupling purposes.
  reconcileFeedForWorkItemStatus({ ...item, status: "cancelled" });
  return {
    success: true,
    title: item.title,
    message: `Removed "${item.title}" from the task queue.`,
  };
}

// ── Selectors / Helpers ─────────────────────────────────────────────

interface WorkItemSelector {
  workItemId?: string;
  taskId?: string;
  title?: string;
  /** Disambiguator: filter by priority tier (0 = high, 1 = medium, 2 = low) */
  priorityTier?: number;
  /** Disambiguator: filter by status (queued, running, etc.) */
  status?: WorkItemStatus;
  /** Disambiguator: 1-indexed creation order (1 = oldest, 2 = second oldest, etc.) */
  createdOrder?: number;
}

export type ResolveWorkItemResult =
  | { status: "found"; workItem: WorkItem }
  | { status: "not_found"; message: string }
  | { status: "ambiguous"; matches: WorkItem[]; message: string };

const PRIORITY_TIER_LABELS: Record<number, string> = {
  0: "high",
  1: "medium",
  2: "low",
};

function formatAmbiguityMessage(
  selectorLabel: string,
  matches: WorkItem[],
): string {
  const lines = matches.map(
    (m) =>
      `  - ID: ${m.id} | title: "${m.title}" | priority: ${
        PRIORITY_TIER_LABELS[m.priorityTier] ?? m.priorityTier
      } | status: ${m.status}`,
  );
  return `Multiple items match '${selectorLabel}'. Please specify which one:\n${lines.join(
    "\n",
  )}`;
}

/** Find all active work items for a given task ID */
export function findActiveWorkItemsByTaskId(taskId: string): WorkItem[] {
  return listWorkItems().filter(
    (i) =>
      i.taskId === taskId && i.status !== "done" && i.status !== "archived",
  );
}

/**
 * Statuses that count as "still in the queue" for dedup purposes — an item
 * that is queued, running, or awaiting review is a live duplicate. Terminal
 * states (done, failed, cancelled, archived) are not: re-enqueuing the same
 * commitment after it finished/failed is legitimate (a retry).
 */
const ACTIVE_DEDUP_STATUSES: ReadonlySet<WorkItemStatus> = new Set([
  "queued",
  "running",
  "awaiting_review",
]);

/** Find all active work items matching a title (case-insensitive exact match) */
export function findActiveWorkItemsByTitle(title: string): WorkItem[] {
  const normalized = title.trim().toLowerCase();
  return listWorkItems().filter(
    (i) =>
      i.title.trim().toLowerCase() === normalized &&
      i.status !== "done" &&
      i.status !== "archived",
  );
}

/**
 * Find an existing active (queued/running/awaiting_review) work item that
 * represents the same commitment, so the enqueue path can skip minting a
 * duplicate. Match precedence, strongest first:
 *
 *  1. **`(sourceType, sourceId, title)`** — same source bucket (feed item /
 *     channel thread) AND same normalized title. The title guard keeps two
 *     genuinely different commitments from one thread from collapsing.
 *  2. **`(sourceType, title)` — channel + title fallback.** When the strict
 *     key misses but the item carries a real channel `sourceType`, match any
 *     active item on the *same channel* with the *same normalized title*. This
 *     closes the duplicate-in-queue bug: an action-board card's derived
 *     `sourceId` is its feed-item id (`action-board:<date>:<index>`), which
 *     changes between board builds when the LLM reorders cards — so the same
 *     commitment ("Send OTP to Aileen…") re-dispatched from a rebuilt board got
 *     a *different* `sourceId`, slipped past key #1, and minted a second
 *     work-item with an identical title + channel. Scoping the fallback to the
 *     same `sourceType` + normalized title + still-active status collapses that
 *     duplicate without over-collapsing: two different titles, or the same
 *     title on a different channel, still stay distinct (key #1's
 *     cross-channel/cross-title guarantees are preserved).
 *  3. **title-only** — when no source at all is available (genuine local
 *     tasks), fall back to a title-only match.
 *
 * Returns the most recently-updated match, or `undefined` if none.
 */
export function findActiveWorkItemBySource(opts: {
  title: string;
  sourceType?: string | null;
  sourceId?: string | null;
}): WorkItem | undefined {
  const normalizedTitle = opts.title.trim().toLowerCase();
  const sourceType = opts.sourceType ?? null;
  const sourceId = opts.sourceId ?? null;

  const active = listWorkItems().filter((i) =>
    ACTIVE_DEDUP_STATUSES.has(i.status),
  );
  const titleEq = (i: WorkItem) =>
    i.title.trim().toLowerCase() === normalizedTitle;

  if (sourceId) {
    // 1. Strong key: same source bucket AND same title.
    const strict = active.filter(
      (i) =>
        i.sourceType === sourceType && i.sourceId === sourceId && titleEq(i),
    );
    if (strict.length > 0) {
      return strict.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    }
    // 2. Channel + title fallback: same channel sourceType + same title, even
    // when the per-build sourceId differs. Only when a channel sourceType is
    // present, so two source-less commitments on no channel never collapse here.
    if (sourceType) {
      const byChannel = active.filter(
        (i) => i.sourceType === sourceType && titleEq(i),
      );
      if (byChannel.length > 0) {
        return byChannel.sort((a, b) => b.updatedAt - a.updatedAt)[0];
      }
    }
    return undefined;
  }

  // No source to key on — title-only dedup.
  const byTitle = active.filter(titleEq);
  return byTitle.sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/**
 * Terminal statuses — a work item that has finished its lifecycle. These are
 * the items the Activity "Recently done" lane surfaces.
 */
const TERMINAL_DEDUP_STATUSES: ReadonlySet<WorkItemStatus> = new Set([
  "done",
  "failed",
  "cancelled",
  "archived",
]);

/**
 * Collapse duplicate TERMINAL work items for a read surface (Activity →
 * "Recently done"). Two terminal items collapse when they share the same
 * normalized title AND the same source channel (`sourceType`); the
 * most-recently-updated row in each group is kept.
 *
 * This is the terminal-state analogue of {@link findActiveWorkItemBySource}'s
 * channel+title fallback: the same commitment re-dispatched from a rebuilt
 * action board lands two distinct work-item rows (the per-build `sourceId`
 * differs), and once both finish they BOTH show in "Recently done" as the same
 * task twice (e.g. "Reply on WordPress guidance" ×2). Grouping on
 * `(sourceType, title)` — sourceId deliberately excluded — collapses that.
 *
 * Pure and non-destructive: unlike {@link dedupeWorkItems} this only filters
 * the in-memory list for display, never deleting rows, so historical/retry
 * records are preserved. Source-less items key on title only; an item with a
 * title but no source never collapses with one carrying a channel (their keys
 * differ), so genuinely distinct tasks stay separate.
 */
export function dedupeTerminalWorkItemsForDisplay(
  items: WorkItem[],
): WorkItem[] {
  const groups = new Map<string, WorkItem>();
  const passthrough: WorkItem[] = [];

  for (const item of items) {
    if (!TERMINAL_DEDUP_STATUSES.has(item.status)) {
      // Non-terminal items are never collapsed here — pass them through
      // untouched so this helper is safe to run over a mixed list.
      passthrough.push(item);
      continue;
    }
    const title = item.title.trim().toLowerCase();
    const key = item.sourceType
      ? `s:${item.sourceType} ${title}`
      : `t:${title}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, item);
      continue;
    }
    // Keep the most-recently-updated row; ties broken by id for determinism.
    if (
      item.updatedAt > existing.updatedAt ||
      (item.updatedAt === existing.updatedAt && item.id < existing.id)
    ) {
      groups.set(key, item);
    }
  }

  return [...passthrough, ...groups.values()];
}

export interface DedupeWorkItemsResult {
  /** Number of duplicate work items removed (donors). */
  collapsed: number;
  /** Number of dedup groups that had duplicates. */
  groups: number;
}

/**
 * Collapse EXISTING duplicate active work items into one canonical row per
 * dedup group. The grouping mirrors {@link findActiveWorkItemBySource}: items
 * with a source are keyed on `(sourceType, sourceId, normalizedTitle)`;
 * source-less items fall back to title-only. The OLDEST item in each group is
 * kept; the rest are deleted. Only `queued | running | awaiting_review` items
 * are eligible — terminal items (done/failed/cancelled/archived) are left
 * alone so historical/retry records are never destroyed.
 *
 * Idempotent: a second run finds no remaining duplicates and is a no-op.
 */
export function dedupeWorkItems(): DedupeWorkItemsResult {
  const db = getDb();
  const active = listWorkItems().filter((i) =>
    ACTIVE_DEDUP_STATUSES.has(i.status),
  );

  const groups = new Map<string, WorkItem[]>();
  for (const i of active) {
    const title = i.title.trim().toLowerCase();
    // Channel-keyed on (sourceType, title) — sourceId is deliberately
    // excluded so the same commitment re-dispatched from a rebuilt action
    // board (whose per-build sourceId changes) collapses to one row, matching
    // the live enqueue guard's channel+title fallback. Source-less items key
    // on title only.
    const key = i.sourceType ? `s:${i.sourceType} ${title}` : `t:${title}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(i);
    else groups.set(key, [i]);
  }

  let collapsed = 0;
  let dupGroups = 0;

  for (const bucket of groups.values()) {
    if (bucket.length <= 1) continue;
    dupGroups += 1;
    // Oldest wins; ties broken by id for determinism.
    const ranked = [...bucket].sort(
      (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
    );
    const donorIds = ranked.slice(1).map((d) => d.id);
    db.delete(workItems).where(inArray(workItems.id, donorIds)).run();
    collapsed += donorIds.length;
  }

  return { collapsed, groups: dupGroups };
}

/**
 * Apply disambiguator fields to narrow down a set of candidate matches.
 * Filters by priorityTier, then status, then picks by createdOrder if provided.
 * Returns the filtered list (may still contain multiple items if disambiguation
 * fields are insufficient).
 */
function applyDisambiguators(
  items: WorkItem[],
  selector: WorkItemSelector,
): WorkItem[] {
  let filtered = items;

  if (selector.priorityTier !== undefined) {
    filtered = filtered.filter((i) => i.priorityTier === selector.priorityTier);
  }

  if (selector.status !== undefined) {
    filtered = filtered.filter((i) => i.status === selector.status);
  }

  if (selector.createdOrder !== undefined && filtered.length > 0) {
    const sorted = [...filtered].sort((a, b) => a.createdAt - b.createdAt);
    const idx = selector.createdOrder - 1; // convert 1-indexed to 0-indexed
    if (idx >= 0 && idx < sorted.length) {
      filtered = [sorted[idx]];
    }
    // If createdOrder is out of range, return the full filtered list so the
    // caller can report ambiguity with the remaining candidates.
  }

  return filtered;
}

/**
 * Given a list of candidate matches, apply disambiguators and return a resolution result.
 * Centralises the disambiguate-or-return-ambiguous logic shared across selector branches.
 */
function resolveFromCandidates(
  items: WorkItem[],
  selectorLabel: string,
  selector: WorkItemSelector,
): ResolveWorkItemResult {
  if (items.length === 0) {
    return {
      status: "not_found",
      message: `No active work item found for "${selectorLabel}"`,
    };
  }
  if (items.length === 1) {
    return { status: "found", workItem: items[0] };
  }

  // Multiple matches — try to narrow down with disambiguator fields
  const narrowed = applyDisambiguators(items, selector);

  if (narrowed.length === 1) {
    return { status: "found", workItem: narrowed[0] };
  }
  if (narrowed.length === 0) {
    // Disambiguators filtered out everything — report the original set so the
    // caller sees what was available
    return {
      status: "ambiguous",
      matches: items,
      message: formatAmbiguityMessage(selectorLabel, items),
    };
  }
  return {
    status: "ambiguous",
    matches: narrowed,
    message: formatAmbiguityMessage(selectorLabel, narrowed),
  };
}

/**
 * Resolve a single active work item from a selector.
 * Tries fields in priority order: workItemId > taskId > title.
 * Only considers active items (status not 'done' or 'archived').
 * Returns a discriminated union so callers can handle ambiguity explicitly
 * instead of silently picking one match when multiple exist.
 *
 * When multiple items match, the optional disambiguator fields (priorityTier,
 * status, createdOrder) are applied to narrow down the set.
 */
export function resolveWorkItem(
  selector: WorkItemSelector,
): ResolveWorkItemResult {
  if (selector.workItemId) {
    const item = getWorkItem(selector.workItemId);
    if (!item)
      return {
        status: "not_found",
        message: `No work item found with ID "${selector.workItemId}"`,
      };
    if (item.status === "done" || item.status === "archived") {
      return {
        status: "not_found",
        message: `Work item "${selector.workItemId}" is ${item.status}`,
      };
    }
    return { status: "found", workItem: item };
  }

  if (selector.taskId) {
    const items = findActiveWorkItemsByTaskId(selector.taskId);
    return resolveFromCandidates(items, selector.taskId, selector);
  }

  if (selector.title) {
    const items = findActiveWorkItemsByTitle(selector.title);
    return resolveFromCandidates(items, selector.title, selector);
  }

  return {
    status: "not_found",
    message:
      "At least one selector field (workItemId, taskId, or title) must be provided",
  };
}

// ── Entity Identification ───────────────────────────────────────────

type EntityType = "task_template" | "work_item" | "unknown";

interface EntityIdentification {
  type: EntityType;
  id: string;
  title?: string;
}

/**
 * Determine whether an ID refers to a task template (tasks table) or
 * a work item (work_items table). Used by tool error messages to give
 * the model corrective guidance when the wrong entity type is provided.
 */
export function identifyEntityById(id: string): EntityIdentification {
  const workItem = getWorkItem(id);
  if (workItem) {
    return { type: "work_item", id: workItem.id, title: workItem.title };
  }

  const task = getTask(id);
  if (task) {
    return { type: "task_template", id: task.id, title: task.title };
  }

  return { type: "unknown", id };
}

/**
 * Build a corrective error message when a work item ID is passed where
 * a task template ID is expected.
 */
export function buildWorkItemMismatchError(
  id: string,
  title: string,
  expectedTool: string,
): string {
  return [
    `Entity mismatch: The ID "${id}" refers to a work item ("${title}"), not a task template.`,
    `Corrective action: Use ${expectedTool} to operate on work items in the task queue.`,
    `Selector fields: work_item_id: "${id}" or title: "${title}"`,
  ].join("\n");
}

/**
 * Build a corrective error message when a task template ID is passed where
 * a work item ID is expected.
 */
export function buildTaskTemplateMismatchError(
  id: string,
  title: string,
  expectedTool: string,
): string {
  return [
    `Entity mismatch: The ID "${id}" refers to a task template ("${title}"), not a work item.`,
    `Corrective action: Use ${expectedTool} to operate on task templates.`,
    `Selector fields: task_id: "${id}" or task_name: "${title}"`,
  ].join("\n");
}
