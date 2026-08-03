/**
 * The Library, composed.
 *
 * There was no "library" in this daemon — there were four registries that
 * each held a slice of one, and every surface picked whichever slice it could
 * reach. The phone's Library picked `work_outputs`, which is not a library at
 * all: it is the deliverable registry the work-item runner writes at the
 * completion of a run (see work-output-store.ts). On the owner's production
 * daemon that table held TWO rows against 452 work items, so a screen titled
 * "Library" rendered two cards — one of them a `browser-screenshot.jpeg` — and
 * called it "2 things Cue made", while 66 apps, 13 documents and 35 generated
 * files sat one query away.
 *
 * This module is that missing query. It composes the four registries into one
 * newest-first list, under one stated scope:
 *
 *   **Everything you made WITH Cue.** Files Cue generated in a thread, the
 *   documents it wrote, the apps it built, and the deliverables a work run
 *   registered. NOT things you uploaded to it — those are inputs, they live in
 *   the thread you sent them to, and the desktop Library has always drawn that
 *   line (attachments-store.ts: "the Library is everything you and Cue MADE
 *   together, not uploads"). One library definition, not two.
 *
 * The four sources, and what each one uniquely brings:
 *
 *   `work_outputs`  provenance — the work item, the project, the producing
 *                   agent, the human review state. Nothing else carries these.
 *   `attachments`   the actual generated files, ALL kinds. The desktop's media
 *                   rail asks for `audio,video,image` only, which is why 12
 *                   spreadsheets and 11 PDFs were invisible there too.
 *   `documents`     canvas documents.
 *   `apps`          built apps.
 *
 * Files are the spine: a `work_outputs` row is merged ONTO its attachment
 * rather than listed beside it, so an approved deliverable appears once, with
 * its provenance, and never twice.
 *
 * Review state is only ever read, never invented. A file, document or app that
 * no run registered has `reviewState: null` — there is no review state to
 * report, and a "REVIEW" badge on an artefact nobody queued for review is a
 * fabricated status.
 */

import { listApps } from "../memory/app-store.js";
import {
  listAttachments,
  TOOL_CAPTURE_FILENAME_PREFIXES,
} from "../memory/attachments-store.js";
import { rawAll } from "../memory/raw-query.js";
import { getLogger } from "../util/logger.js";
import {
  deriveOutputKind,
  listRecentOutputs,
  type WorkOutputKind,
} from "../work-items/work-output-store.js";

const log = getLogger("library-store");

/** Which registry an entry came from. The client renders provenance from it. */
export type LibrarySource = "output" | "file" | "document" | "app";

/** The card taxonomy — the work-output kinds plus the one they cannot express. */
export type LibraryItemKind = WorkOutputKind | "app";

export interface LibraryItem {
  /** Stable and source-qualified: two registries may share an underlying id. */
  id: string;
  source: LibrarySource;
  /** Present only on run-registered deliverables. */
  workItemId: string | null;
  missionId: string | null;
  projectId: string | null;
  attachmentId: string | null;
  externalUrl: string | null;
  /** The canvas document's surface id — how the client opens it. */
  documentId: string | null;
  appId: string | null;
  kind: LibraryItemKind;
  title: string;
  why: string | null;
  agent: string | null;
  /**
   * `null` means "this artefact was never queued for review", which is not the
   * same as pending. Only `work_outputs` rows carry a real one.
   */
  reviewState: "pending" | "approved" | null;
  createdAt: number;
  attachment: {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    hasThumbnail: boolean;
  } | null;
}

/**
 * Every value the `attachments.kind` column takes, so the file spine is the
 * whole spine. `listAttachments` matches `kind IN (…) OR mime_type LIKE 'k/%'`;
 * passing the media three (its default) is what hid every PDF and spreadsheet,
 * because those are stored with `kind = 'document'`.
 */
const ALL_ATTACHMENT_KINDS = ["audio", "video", "image", "document"];

/** The daemon's ceiling for one library page. */
export const LIBRARY_LIMIT_MAX = 500;
const LIBRARY_LIMIT_DEFAULT = 200;

/**
 * True for a tool-internal capture — a screenshot the agent took while
 * working, not something it made for you. Mirrors the SQL denylist
 * `listAttachments` applies, so the two readers cannot drift.
 */
function isToolCapture(filename: string): boolean {
  const lower = filename.toLowerCase();
  return TOOL_CAPTURE_FILENAME_PREFIXES.some((p) => lower.startsWith(p));
}

interface DocumentRow {
  surface_id: string;
  title: string;
  word_count: number;
  created_at: number;
}

/**
 * The composed library, newest first.
 *
 * Best-effort per source by design: one registry being unavailable must not
 * blank the other three. A source that throws is logged and contributes
 * nothing — but note the route above this treats a total failure as an error,
 * because "your library is empty" is the one answer this must never guess.
 */
export function listLibraryItems(opts?: { limit?: number }): LibraryItem[] {
  const limit = Math.max(
    1,
    Math.min(opts?.limit ?? LIBRARY_LIMIT_DEFAULT, LIBRARY_LIMIT_MAX),
  );
  // Read wide, then cap: an item is only droppable after everything has been
  // merged and sorted, or the cap would silently favour whichever source was
  // read first.
  const readAhead = LIBRARY_LIMIT_MAX;

  const outputs = safely("outputs", () =>
    listRecentOutputs({ limit: readAhead }),
  );
  const files = safely("files", () =>
    listAttachments({ kinds: ALL_ATTACHMENT_KINDS, limit: readAhead }),
  );
  const documents = safely("documents", () =>
    rawAll<DocumentRow>(/*sql*/ `
      SELECT surface_id, title, word_count, created_at
      FROM documents
      ORDER BY created_at DESC
      LIMIT ${readAhead}
    `),
  );
  const apps = safely("apps", () => listApps());

  const outputByAttachment = new Map(
    outputs
      .filter((o) => o.attachmentId != null)
      .map((o) => [o.attachmentId as string, o]),
  );

  const items: LibraryItem[] = [];
  const claimedOutputIds = new Set<string>();

  // 1. The files Cue generated. Each carries its work-run provenance when a
  //    run registered it.
  for (const file of files) {
    const output = outputByAttachment.get(file.id);
    if (output) claimedOutputIds.add(output.id);
    items.push({
      id: output ? output.id : `file:${file.id}`,
      source: output ? "output" : "file",
      workItemId: output?.workItemId ?? null,
      missionId: output?.missionId ?? null,
      projectId: output?.projectId ?? null,
      attachmentId: file.id,
      externalUrl: null,
      documentId: null,
      appId: null,
      kind:
        output?.kind ?? deriveOutputKind(file.mimeType, file.originalFilename),
      title: output?.title ?? file.originalFilename,
      why: output?.why ?? null,
      agent: output?.agent ?? null,
      reviewState: output?.reviewState ?? null,
      createdAt: output?.createdAt ?? file.createdAt,
      attachment: {
        id: file.id,
        filename: file.originalFilename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        hasThumbnail: file.thumbnailBase64 != null,
      },
    });
  }

  // 2. Outputs the file spine did not account for. Two shapes reach here and
  //    they are NOT the same:
  //
  //      · link-backed (a deployed site, a shared doc) — real, keep it;
  //      · file-backed whose attachment row is gone — also real, keep it: the
  //        card still opens the thing it was made for, and hiding a row
  //        because its bytes moved is how a library starts lying.
  //
  //    What does NOT reach here is a tool capture, which is dropped
  //    explicitly below. That is the ONE deliberate exclusion, and it is a
  //    judgement about what the artefact IS — not an outage, not a timeout.
  for (const output of outputs) {
    if (claimedOutputIds.has(output.id)) continue;
    if (output.attachmentId && isToolCapture(output.title)) continue;
    items.push({
      id: output.id,
      source: "output",
      workItemId: output.workItemId,
      missionId: output.missionId,
      projectId: output.projectId,
      attachmentId: output.attachmentId,
      externalUrl: output.externalUrl,
      documentId: null,
      appId: null,
      kind: output.kind,
      title: output.title,
      why: output.why,
      agent: output.agent,
      reviewState: output.reviewState,
      createdAt: output.createdAt,
      attachment: null,
    });
  }

  // 3. Canvas documents.
  for (const doc of documents) {
    items.push({
      id: `document:${doc.surface_id}`,
      source: "document",
      workItemId: null,
      missionId: null,
      projectId: null,
      attachmentId: null,
      externalUrl: null,
      documentId: doc.surface_id,
      appId: null,
      kind: "document",
      title: doc.title,
      why:
        doc.word_count > 0
          ? `Document · ${doc.word_count.toLocaleString("en-US")} words`
          : "Document",
      agent: null,
      reviewState: null,
      createdAt: doc.created_at,
      attachment: null,
    });
  }

  // 4. Apps.
  for (const app of apps) {
    items.push({
      id: `app:${app.id}`,
      source: "app",
      workItemId: null,
      missionId: null,
      projectId: null,
      attachmentId: null,
      externalUrl: null,
      documentId: null,
      appId: app.id,
      kind: "app",
      title: app.name,
      why: app.description ?? null,
      agent: null,
      reviewState: null,
      createdAt: app.createdAt,
      attachment: null,
    });
  }

  items.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  return items.slice(0, limit);
}

/**
 * Read one source. A thrown source contributes nothing and says so in the log
 * — it must not take the other three down with it.
 */
function safely<T>(source: string, read: () => T[]): T[] {
  try {
    return read();
  } catch (err) {
    log.warn({ err: String(err), source }, "library source unavailable");
    return [];
  }
}
