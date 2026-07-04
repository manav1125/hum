/**
 * Project knowledge — Claude-Projects-style reference material attached to a
 * cowork project so every task run in that project has it available.
 *
 * Two kinds live in one table (project_knowledge):
 *   - kind='file': a row linking the project to an existing attachments.id
 *     (the upload itself goes through the normal attachment upload route).
 *   - kind='link': a URL pointer surfaced to the agent as reference material.
 *
 * How files reach the running agent: the agent's sandboxed filesystem tools
 * (file_read / file_list / bash) are bounded to the workspace directory, so
 * {@link ensureProjectKnowledgeFiles} materializes each file attachment onto
 * disk at a stable path INSIDE that boundary —
 * `<workspace>/projects/<projectId>/knowledge/<id8>-<filename>` — and the
 * work-item runner lists those absolute paths in the run preamble. The agent
 * can then genuinely read the bytes with its own tools mid-run.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { asc, eq, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import {
  deleteAttachment,
  getAttachmentById,
  getFilePathForAttachment,
} from "../memory/attachments-store.js";
import { getDb } from "../memory/db-connection.js";
import { projectKnowledge } from "../memory/schema/index.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("project-knowledge-store");

export type ProjectKnowledgeKind = "file" | "link";

export interface ProjectKnowledgeItem {
  id: string;
  projectId: string;
  kind: ProjectKnowledgeKind;
  attachmentId: string | null;
  url: string | null;
  label: string | null;
  addedAt: number;
}

/** A knowledge row enriched with attachment metadata for display. */
export interface ProjectKnowledgeView extends ProjectKnowledgeItem {
  /** Original filename for kind='file'; null for links. */
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

/** A knowledge entry resolved for a run: files carry an on-disk path. */
export interface MaterializedProjectKnowledge {
  id: string;
  kind: ProjectKnowledgeKind;
  /** Display label — falls back to the filename / URL. */
  label: string;
  /** Absolute workspace-internal path for kind='file' (null if unavailable). */
  absPath: string | null;
  url: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

// ---------------------------------------------------------------------------
// Materialization paths
// ---------------------------------------------------------------------------

/** Directory the agent reads project knowledge from during a run. */
export function getProjectKnowledgeDir(projectId: string): string {
  return join(getWorkspaceDir(), "projects", projectId, "knowledge");
}

function sanitizeFilename(name: string): string {
  const cleaned = basename(name).replace(/[^a-zA-Z0-9._ -]/g, "_");
  return cleaned.length > 0 ? cleaned : "file";
}

/**
 * Stable, collision-free on-disk name for a knowledge file: the first 8 chars
 * of the row id + the sanitized original filename. Deterministic so repeated
 * materialization is idempotent, unique so two "notes.md" never clash.
 */
function materializedFilename(id: string, filename: string): string {
  return `${id.slice(0, 8)}-${sanitizeFilename(filename)}`;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function addProjectFileKnowledge(opts: {
  projectId: string;
  attachmentId: string;
  label?: string;
}): ProjectKnowledgeView {
  const attachment = getAttachmentById(opts.attachmentId);
  if (!attachment) {
    throw new Error(`Attachment not found: ${opts.attachmentId}`);
  }

  const db = getDb();
  const row: ProjectKnowledgeItem = {
    id: uuid(),
    projectId: opts.projectId,
    kind: "file",
    attachmentId: opts.attachmentId,
    url: null,
    label: opts.label?.trim() || attachment.originalFilename,
    addedAt: Date.now(),
  };
  db.insert(projectKnowledge).values(row).run();

  // Materialize eagerly so the first run in the project pays no upload-decode
  // cost and a broken attachment surfaces at attach time, not mid-run.
  try {
    materializeFileRow(row);
  } catch (err) {
    log.warn(
      { err: String(err), knowledgeId: row.id },
      "failed to eagerly materialize project knowledge file (will retry at run time)",
    );
  }

  return {
    ...row,
    filename: attachment.originalFilename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  };
}

export function addProjectLinkKnowledge(opts: {
  projectId: string;
  url: string;
  label?: string;
}): ProjectKnowledgeView {
  const db = getDb();
  const row: ProjectKnowledgeItem = {
    id: uuid(),
    projectId: opts.projectId,
    kind: "link",
    attachmentId: null,
    url: opts.url,
    label: opts.label?.trim() || opts.url,
    addedAt: Date.now(),
  };
  db.insert(projectKnowledge).values(row).run();
  return { ...row, filename: null, mimeType: null, sizeBytes: null };
}

export function getProjectKnowledgeItem(
  id: string,
): ProjectKnowledgeItem | undefined {
  const db = getDb();
  return db
    .select()
    .from(projectKnowledge)
    .where(eq(projectKnowledge.id, id))
    .get() as ProjectKnowledgeItem | undefined;
}

/** All knowledge rows for a project, oldest-first, with attachment metadata. */
export function listProjectKnowledge(
  projectId: string,
): ProjectKnowledgeView[] {
  const db = getDb();
  const rows = db
    .select()
    .from(projectKnowledge)
    .where(eq(projectKnowledge.projectId, projectId))
    // rowid tie-break keeps same-millisecond inserts in insertion order.
    .orderBy(asc(projectKnowledge.addedAt), sql`rowid ASC`)
    .all() as ProjectKnowledgeItem[];

  return rows.map((row) => {
    if (row.kind === "file" && row.attachmentId) {
      const attachment = getAttachmentById(row.attachmentId);
      return {
        ...row,
        filename: attachment?.originalFilename ?? null,
        mimeType: attachment?.mimeType ?? null,
        sizeBytes: attachment?.sizeBytes ?? null,
      };
    }
    return { ...row, filename: null, mimeType: null, sizeBytes: null };
  });
}

/**
 * Remove one knowledge entry: delete the row, remove the materialized copy,
 * and best-effort delete the underlying attachment (refused by the attachments
 * store when a chat message still references it — that copy keeps living).
 */
export function removeProjectKnowledge(
  projectId: string,
  id: string,
): "deleted" | "not_found" {
  const row = getProjectKnowledgeItem(id);
  if (!row || row.projectId !== projectId) return "not_found";

  const db = getDb();
  db.delete(projectKnowledge).where(eq(projectKnowledge.id, id)).run();

  if (row.kind === "file" && row.attachmentId) {
    const attachment = getAttachmentById(row.attachmentId);
    if (attachment) {
      const materialized = join(
        getProjectKnowledgeDir(projectId),
        materializedFilename(row.id, attachment.originalFilename),
      );
      try {
        if (existsSync(materialized)) unlinkSync(materialized);
      } catch (err) {
        log.debug(
          { err: String(err), path: materialized },
          "failed to remove materialized knowledge file (ignored)",
        );
      }
    }
    try {
      deleteAttachment(row.attachmentId);
    } catch (err) {
      log.debug(
        { err: String(err), attachmentId: row.attachmentId },
        "failed to delete knowledge attachment (ignored)",
      );
    }
  }

  return "deleted";
}

/**
 * Drop every knowledge row for a project (called when the project itself is
 * deleted) plus the materialized directory. Attachments are best-effort
 * cleaned via the per-row path.
 */
export function removeAllProjectKnowledge(projectId: string): void {
  for (const row of listProjectKnowledge(projectId)) {
    removeProjectKnowledge(projectId, row.id);
  }
  try {
    rmSync(join(getWorkspaceDir(), "projects", projectId), {
      recursive: true,
      force: true,
    });
  } catch (err) {
    log.debug(
      { err: String(err), projectId },
      "failed to remove project knowledge dir (ignored)",
    );
  }
}

// ---------------------------------------------------------------------------
// Run-time materialization
// ---------------------------------------------------------------------------

/**
 * Write one file row's bytes to its stable workspace path (idempotent — skips
 * when the file already exists). Returns the absolute path, or null when the
 * attachment row/bytes are gone.
 */
function materializeFileRow(row: ProjectKnowledgeItem): string | null {
  if (row.kind !== "file" || !row.attachmentId) return null;

  const meta = getAttachmentById(row.attachmentId);
  if (!meta) return null;

  const dir = getProjectKnowledgeDir(row.projectId);
  const target = join(dir, materializedFilename(row.id, meta.originalFilename));
  if (existsSync(target)) return target;

  mkdirSync(dir, { recursive: true });

  // File-backed attachments copy straight from disk (no base64 round-trip
  // through memory for large files); inline ones decode the stored base64.
  const sourcePath = getFilePathForAttachment(row.attachmentId);
  if (sourcePath && existsSync(sourcePath)) {
    copyFileSync(sourcePath, target);
    return target;
  }

  if (!meta.dataBase64) return null;
  writeFileSync(target, Buffer.from(meta.dataBase64, "base64"));
  return target;
}

/**
 * Ensure every file in the project's knowledge exists on disk inside the
 * agent's sandbox boundary, and return the resolved entries (files with
 * absolute paths, links with URLs) for the run preamble. Never throws —
 * a knowledge failure must not break a run.
 */
export function ensureProjectKnowledgeFiles(
  projectId: string,
): MaterializedProjectKnowledge[] {
  const out: MaterializedProjectKnowledge[] = [];
  for (const row of listProjectKnowledge(projectId)) {
    if (row.kind === "link") {
      out.push({
        id: row.id,
        kind: "link",
        label: row.label ?? row.url ?? "link",
        absPath: null,
        url: row.url,
        mimeType: null,
        sizeBytes: null,
      });
      continue;
    }
    let absPath: string | null = null;
    try {
      absPath = materializeFileRow(row);
    } catch (err) {
      log.warn(
        { err: String(err), knowledgeId: row.id, projectId },
        "failed to materialize project knowledge file for run",
      );
    }
    out.push({
      id: row.id,
      kind: "file",
      label: row.label ?? row.filename ?? "file",
      absPath,
      url: null,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
    });
  }
  return out;
}
