/**
 * Projects — named containers that group work items ("Q4 launch",
 * "Customer Acme"). Work items point at a project via the nullable
 * work_items.project_id column; integrity is enforced here (delete nulls the
 * references) rather than with a foreign key, so removing a project can never
 * strand or cascade-delete the underlying work.
 *
 * Cowork PM fields (migration 288): a project carries a `context` brief the
 * agent reads before working ANY of its tasks, a freeform `category`, plus
 * `pinned`/`sortIndex` for ordering.
 */

import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, sql } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { projects, workItems } from "../memory/schema/index.js";
import type { WorkItemStatus } from "./work-item-store.js";

export type ProjectStatus = "active" | "archived";

export interface Project {
  id: string;
  title: string;
  emoji: string | null;
  color: string | null;
  status: ProjectStatus;
  /** Freeform bucket: "personal" | "professional" | "other" | anything. */
  category: string | null;
  /** Project brief/instructions the agent reads before working any task here. */
  context: string | null;
  /** Manual ordering key; smaller sorts first. Null falls back to createdAt. */
  sortIndex: number | null;
  /** 1 = pinned (floats to the top of the list), 0 = normal. */
  pinned: number;
  createdAt: number;
  updatedAt: number;
}

/** Per-status task counts plus the single most-urgent next task for a project. */
export interface ProjectStats {
  counts: {
    queued: number;
    running: number;
    awaiting_review: number;
    done: number;
    /** Total live (non-terminal) items — queued + running + awaiting_review. */
    open: number;
    total: number;
  };
  /** The single most-urgent next actionable task, or null when none. */
  nextTask: {
    id: string;
    title: string;
    status: WorkItemStatus;
    dueAt: number | null;
    priorityTier: number;
  } | null;
}

export interface ProjectWithStats extends Project {
  stats: ProjectStats;
}

export function createProject(opts: {
  title: string;
  emoji?: string;
  color?: string;
  category?: string;
  context?: string;
  sortIndex?: number;
  pinned?: boolean;
}): Project {
  const db = getDb();
  const now = Date.now();
  const project: Project = {
    id: randomUUID(),
    title: opts.title,
    emoji: opts.emoji ?? null,
    color: opts.color ?? null,
    status: "active",
    category: opts.category ?? null,
    context: opts.context ?? null,
    sortIndex: opts.sortIndex ?? null,
    pinned: opts.pinned ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(projects).values(project).run();
  return project;
}

export function getProject(id: string): Project | undefined {
  const db = getDb();
  return db.select().from(projects).where(eq(projects.id, id)).get() as
    | Project
    | undefined;
}

/**
 * List projects; defaults to active only. Ordered pinned-first, then by the
 * manual `sortIndex` (nulls last), then newest-created — so a freshly pinned or
 * hand-ordered project surfaces where the user expects it.
 */
export function listProjects(opts?: { status?: ProjectStatus }): Project[] {
  const db = getDb();
  const status = opts?.status ?? "active";
  // NULL sort_index sorts after any real index within a pinned bucket.
  const sortIndexNullsLast = sql`CASE WHEN ${projects.sortIndex} IS NULL THEN 1 ELSE 0 END`;
  return db
    .select()
    .from(projects)
    .where(eq(projects.status, status))
    .orderBy(
      desc(projects.pinned),
      sortIndexNullsLast,
      asc(projects.sortIndex),
      desc(projects.createdAt),
    )
    .all() as Project[];
}

export function updateProject(
  id: string,
  updates: Partial<
    Pick<
      Project,
      | "title"
      | "emoji"
      | "color"
      | "status"
      | "category"
      | "context"
      | "sortIndex"
      | "pinned"
    >
  >,
): Project | undefined {
  const db = getDb();
  db.update(projects)
    .set({ ...updates, updatedAt: Date.now() })
    .where(eq(projects.id, id))
    .run();
  return getProject(id);
}

/**
 * Compute per-status task counts and the most-urgent next task for a project.
 * Returns undefined only when the project itself doesn't exist.
 *
 * "Next task" = the single most-urgent still-actionable item, ranked:
 *   1. awaiting_review before queued (a finished run needs the user first),
 *   2. then soonest due_at (nulls last),
 *   3. then priority tier (0 = high first),
 *   4. then freshest last_activity_at, id as a final tie-break.
 * Running/terminal items are never the "next task" (nothing to do on them).
 */
export function getProjectWithStats(id: string): ProjectWithStats | undefined {
  const project = getProject(id);
  if (!project) return undefined;
  return { ...project, stats: computeProjectStats(id) };
}

/** Shared stats computation — used by getProjectWithStats and listProjectsWithStats. */
function computeProjectStats(projectId: string): ProjectStats {
  const db = getDb();
  const rows = db
    .select({ status: workItems.status, count: sql<number>`count(*)` })
    .from(workItems)
    .where(eq(workItems.projectId, projectId))
    .groupBy(workItems.status)
    .all() as Array<{ status: WorkItemStatus; count: number }>;

  const byStatus = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    byStatus.set(r.status, r.count);
    total += r.count;
  }
  const queued = byStatus.get("queued") ?? 0;
  const running = byStatus.get("running") ?? 0;
  const awaitingReview = byStatus.get("awaiting_review") ?? 0;
  const done = byStatus.get("done") ?? 0;

  // Most-urgent actionable item. Deterministic SQL ordering mirrors the doc
  // comment: awaiting_review first, then soonest due, then tier, then freshest.
  const nextTaskRow = db
    .select({
      id: workItems.id,
      title: workItems.title,
      status: workItems.status,
      dueAt: workItems.dueAt,
      priorityTier: workItems.priorityTier,
    })
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, projectId),
        sql`${workItems.status} IN ('awaiting_review','queued')`,
      ),
    )
    .orderBy(
      sql`CASE WHEN ${workItems.status} = 'awaiting_review' THEN 0 ELSE 1 END`,
      sql`CASE WHEN ${workItems.dueAt} IS NULL THEN 1 ELSE 0 END`,
      asc(workItems.dueAt),
      asc(workItems.priorityTier),
      sql`COALESCE(${workItems.lastActivityAt}, ${workItems.updatedAt}) DESC`,
      asc(workItems.id),
    )
    .limit(1)
    .get() as
    | {
        id: string;
        title: string;
        status: WorkItemStatus;
        dueAt: number | null;
        priorityTier: number;
      }
    | undefined;

  return {
    counts: {
      queued,
      running,
      awaiting_review: awaitingReview,
      done,
      open: queued + running + awaitingReview,
      total,
    },
    nextTask: nextTaskRow ?? null,
  };
}

/** List projects with per-project stats, in the same order as {@link listProjects}. */
export function listProjectsWithStats(opts?: {
  status?: ProjectStatus;
}): ProjectWithStats[] {
  return listProjects(opts).map((p) => ({
    ...p,
    stats: computeProjectStats(p.id),
  }));
}

/**
 * Persist a new manual ordering. `orderedIds` is the desired top-to-bottom
 * order; each project's `sortIndex` is set to its position (0-based). Unknown
 * ids are skipped. Does not touch `pinned` — pinned projects still float above
 * within the new order because {@link listProjects} sorts pinned first.
 */
export function reorderProjects(orderedIds: string[]): void {
  const db = getDb();
  const now = Date.now();
  orderedIds.forEach((id, index) => {
    db.update(projects)
      .set({ sortIndex: index, updatedAt: now })
      .where(eq(projects.id, id))
      .run();
  });
}

/**
 * Hard-delete a project. Work items that referenced it keep living — their
 * project_id is nulled so they fall back to the ungrouped pool.
 */
export function deleteProject(id: string): void {
  const db = getDb();
  db.update(workItems)
    .set({ projectId: null, updatedAt: Date.now() })
    .where(eq(workItems.projectId, id))
    .run();
  db.delete(projects).where(eq(projects.id, id)).run();
}
