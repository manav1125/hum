/**
 * Work outputs — the first-class registry of deliverables ("Sprint outputs")
 * produced by work-item runs. Powers the artifact cards on Mission detail and
 * the daily brief: doc/deck/sheet/image/video deliverables with the producing
 * agent, the owning mission, a one-line "why it exists", and a review state.
 *
 * Capture happens at ONE choke point: the work-item runner's completion path
 * (see registerOutputsForCompletedRun) — the only place that knows the
 * work item ↔ run conversation binding AND the terminal status. By the time
 * the runner's completion path executes, every attachment the run's tools
 * produced (typed attachmentIds side channel and directive-resolved drafts
 * alike) is already linked to the run conversation's assistant messages via
 * message_attachments, so one query captures them all.
 *
 * Referential integrity is by convention (store-enforced, no FKs), matching
 * work-item-store / mission-store.
 */

import { randomUUID } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";

import { getAttachmentsByIds } from "../memory/attachments-store.js";
import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import {
  attachments,
  messageAttachments,
  messages,
  projects,
  workOutputs,
} from "../memory/schema/index.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("work-output-store");

// ── Types ────────────────────────────────────────────────────────────

export type WorkOutputKind =
  | "document"
  | "deck"
  | "spreadsheet"
  | "pdf"
  | "image"
  | "video"
  | "other";

export type WorkOutputReviewState = "pending" | "approved";

export interface WorkOutput {
  id: string;
  workItemId: string;
  /** Denormalized from the work item's project at write time. */
  missionId: string | null;
  projectId: string | null;
  /** Set for file-backed outputs; the client renders/opens via attachment routes. */
  attachmentId: string | null;
  /** Set for link-backed outputs (deployed site, shared doc…). */
  externalUrl: string | null;
  kind: WorkOutputKind;
  title: string;
  /** One-line "why it exists" purpose shown on the card. */
  why: string | null;
  /** The assignee that produced it; null reads as "cue". */
  agent: string | null;
  reviewState: WorkOutputReviewState;
  createdAt: number;
}

/**
 * A work output enriched with the backing attachment's render metadata —
 * enough for the client to draw the card without another round-trip: images
 * and PDFs render client-side from the attachment content route, videos have
 * a stored thumbnail, everything else falls back to a kind icon.
 */
export interface WorkOutputWithAttachment extends WorkOutput {
  attachment: {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    hasThumbnail: boolean;
  } | null;
}

// ── Kind derivation ──────────────────────────────────────────────────

const DECK_EXTENSIONS = new Set(["ppt", "pptx", "key", "odp"]);
const SPREADSHEET_EXTENSIONS = new Set(["xls", "xlsx", "csv", "tsv", "ods"]);
const DOCUMENT_EXTENSIONS = new Set([
  "doc",
  "docx",
  "md",
  "txt",
  "rtf",
  "odt",
  "html",
  "htm",
  "tex",
]);

/**
 * Map a produced file's mime type (plus filename extension as a fallback for
 * generic mimes like application/octet-stream) onto the card taxonomy.
 */
export function deriveOutputKind(
  mimeType: string,
  filename: string,
): WorkOutputKind {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  if (mime.includes("presentation") || mime.includes("powerpoint")) {
    return "deck";
  }
  if (
    mime.includes("spreadsheet") ||
    mime.includes("ms-excel") ||
    mime === "text/csv" ||
    mime === "text/tab-separated-values"
  ) {
    return "spreadsheet";
  }
  if (
    mime.startsWith("text/") ||
    mime.includes("wordprocessing") ||
    mime.includes("msword") ||
    mime === "application/rtf"
  ) {
    return "document";
  }

  const ext = filename.includes(".")
    ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase()
    : "";
  if (ext === "pdf") return "pdf";
  if (DECK_EXTENSIONS.has(ext)) return "deck";
  if (SPREADSHEET_EXTENSIONS.has(ext)) return "spreadsheet";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  return "other";
}

// ── CRUD ─────────────────────────────────────────────────────────────

export function createWorkOutput(opts: {
  workItemId: string;
  missionId?: string | null;
  projectId?: string | null;
  attachmentId?: string | null;
  externalUrl?: string | null;
  kind: WorkOutputKind;
  title: string;
  why?: string | null;
  agent?: string | null;
}): WorkOutput {
  const db = getDb();
  const output: WorkOutput = {
    id: randomUUID(),
    workItemId: opts.workItemId,
    missionId: opts.missionId ?? null,
    projectId: opts.projectId ?? null,
    attachmentId: opts.attachmentId ?? null,
    externalUrl: opts.externalUrl ?? null,
    kind: opts.kind,
    title: opts.title,
    why: opts.why ?? null,
    agent: opts.agent ?? null,
    reviewState: "pending",
    createdAt: Date.now(),
  };
  db.insert(workOutputs).values(output).run();
  return output;
}

export function getWorkOutput(id: string): WorkOutput | undefined {
  const db = getDb();
  return db.select().from(workOutputs).where(eq(workOutputs.id, id)).get() as
    | WorkOutput
    | undefined;
}

/** Newest-first outputs for one work item (its last runs' deliverables). */
export function listWorkItemOutputs(workItemId: string): WorkOutput[] {
  const db = getDb();
  return db
    .select()
    .from(workOutputs)
    .where(eq(workOutputs.workItemId, workItemId))
    .orderBy(desc(workOutputs.createdAt), sql`rowid DESC`)
    .all() as WorkOutput[];
}

/** Newest-first outputs across a mission (the mission-detail artifact rail). */
export function listMissionOutputs(missionId: string): WorkOutput[] {
  const db = getDb();
  return db
    .select()
    .from(workOutputs)
    .where(eq(workOutputs.missionId, missionId))
    .orderBy(desc(workOutputs.createdAt), sql`rowid DESC`)
    .all() as WorkOutput[];
}

/** Newest-first outputs across everything (the daily brief's "Cue made these"). */
export function listRecentOutputs(opts?: { limit?: number }): WorkOutput[] {
  const db = getDb();
  return db
    .select()
    .from(workOutputs)
    .orderBy(desc(workOutputs.createdAt), sql`rowid DESC`)
    .limit(Math.max(1, Math.min(opts?.limit ?? 50, 200)))
    .all() as WorkOutput[];
}

export function setWorkOutputReviewState(
  id: string,
  reviewState: WorkOutputReviewState,
): WorkOutput | undefined {
  const db = getDb();
  db.update(workOutputs)
    .set({ reviewState })
    .where(eq(workOutputs.id, id))
    .run();
  return getWorkOutput(id);
}

// ── Attachment enrichment ────────────────────────────────────────────

/**
 * Attach render metadata (filename/mime/size/has-thumbnail) for file-backed
 * outputs in one bulk lookup. No thumbnailer here by design: images and PDFs
 * render client-side from the attachment content route, videos already have a
 * stored thumbnail, and other kinds get client-side kind icons.
 */
export function enrichOutputsWithAttachments(
  outputs: WorkOutput[],
): WorkOutputWithAttachment[] {
  const ids = outputs
    .map((o) => o.attachmentId)
    .filter((id): id is string => id != null);
  // No hydrateFileData: metadata only — the client lazy-loads bytes via the
  // attachment content route.
  const metaById = new Map(getAttachmentsByIds(ids).map((a) => [a.id, a]));
  return outputs.map((o) => {
    const meta = o.attachmentId ? metaById.get(o.attachmentId) : undefined;
    return {
      ...o,
      attachment: meta
        ? {
            id: meta.id,
            filename: meta.originalFilename,
            mimeType: meta.mimeType,
            sizeBytes: meta.sizeBytes,
            hasThumbnail: meta.thumbnailBase64 != null,
          }
        : null,
    };
  });
}

// ── Capture (the runner's completion hook) ───────────────────────────

/**
 * Attachments the run's tools produced, i.e. every attachment linked to an
 * ASSISTANT message of the run conversation. User-uploaded inputs are linked
 * to user messages, so they are naturally excluded.
 */
function listRunProducedAttachments(conversationId: string): Array<{
  id: string;
  originalFilename: string;
  mimeType: string;
}> {
  const db = getDb();
  return db
    .selectDistinct({
      id: attachments.id,
      originalFilename: attachments.originalFilename,
      mimeType: attachments.mimeType,
    })
    .from(attachments)
    .innerJoin(
      messageAttachments,
      eq(messageAttachments.attachmentId, attachments.id),
    )
    .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "assistant"),
      ),
    )
    .all();
}

/**
 * Register the deliverables of a completed work-item run: one work_outputs
 * row per attachment the run produced. Idempotent — the unique
 * (work_item_id, attachment_id) index turns re-registration (runner retry,
 * duplicate completion) into a no-op. mission_id is denormalized from the
 * work item's project at write time.
 *
 * Best-effort by contract: callers treat a capture failure as non-fatal (the
 * run itself succeeded), so this never throws.
 */
export function registerOutputsForCompletedRun(
  workItem: {
    id: string;
    title: string;
    projectId: string | null;
    assignee: string | null;
  },
  conversationId: string,
): WorkOutput[] {
  try {
    const db = getDb();
    const missionId = workItem.projectId
      ? (db
          .select({ missionId: projects.missionId })
          .from(projects)
          .where(eq(projects.id, workItem.projectId))
          .get()?.missionId ?? null)
      : null;

    const produced = listRunProducedAttachments(conversationId);
    if (produced.length === 0) return [];

    const raw = getSqliteFrom(db);
    const insert = raw.prepare(/*sql*/ `INSERT OR IGNORE INTO work_outputs
        (id, work_item_id, mission_id, project_id, attachment_id, external_url,
         kind, title, why, agent, review_state, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'pending', ?)`);

    const registered: WorkOutput[] = [];
    for (const att of produced) {
      const output: WorkOutput = {
        id: randomUUID(),
        workItemId: workItem.id,
        missionId,
        projectId: workItem.projectId,
        attachmentId: att.id,
        externalUrl: null,
        kind: deriveOutputKind(att.mimeType, att.originalFilename),
        title: att.originalFilename,
        why: `Deliverable from “${workItem.title}”`,
        agent: workItem.assignee ?? "cue",
        reviewState: "pending",
        createdAt: Date.now(),
      };
      const result = insert.run(
        output.id,
        output.workItemId,
        output.missionId,
        output.projectId,
        output.attachmentId,
        output.kind,
        output.title,
        output.why,
        output.agent,
        output.createdAt,
      );
      // changes === 0 → this (work item, attachment) pair was already
      // registered by an earlier completion; skip silently.
      if (result.changes > 0) registered.push(output);
    }
    return registered;
  } catch (err) {
    log.warn(
      { err: String(err), workItemId: workItem.id, conversationId },
      "failed to register work outputs for completed run (ignored)",
    );
    return [];
  }
}
