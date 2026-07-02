/**
 * Projects — named containers that group work items ("Q4 launch",
 * "Customer Acme"). Work items point at a project via the nullable
 * work_items.project_id column; integrity is enforced here (delete nulls the
 * references) rather than with a foreign key, so removing a project can never
 * strand or cascade-delete the underlying work.
 */

import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { projects, workItems } from "../memory/schema/index.js";

export type ProjectStatus = "active" | "archived";

export interface Project {
  id: string;
  title: string;
  emoji: string | null;
  color: string | null;
  status: ProjectStatus;
  createdAt: number;
  updatedAt: number;
}

export function createProject(opts: {
  title: string;
  emoji?: string;
  color?: string;
}): Project {
  const db = getDb();
  const now = Date.now();
  const project: Project = {
    id: randomUUID(),
    title: opts.title,
    emoji: opts.emoji ?? null,
    color: opts.color ?? null,
    status: "active",
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

/** List projects; defaults to active only. */
export function listProjects(opts?: { status?: ProjectStatus }): Project[] {
  const db = getDb();
  const status = opts?.status ?? "active";
  return db
    .select()
    .from(projects)
    .where(eq(projects.status, status))
    .orderBy(asc(projects.title))
    .all() as Project[];
}

export function updateProject(
  id: string,
  updates: Partial<Pick<Project, "title" | "emoji" | "color" | "status">>,
): Project | undefined {
  const db = getDb();
  db.update(projects)
    .set({ ...updates, updatedAt: Date.now() })
    .where(eq(projects.id, id))
    .run();
  return getProject(id);
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
