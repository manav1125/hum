/**
 * Accepting a proposal — **the only place in Notes that writes to HQ, memory
 * or People.**
 *
 * Everything upstream of this file (`note-extraction.ts`, `note-conflict.ts`,
 * `note-store.ts`) records proposals and nothing else. This module is the
 * single door between "Cue found something in your note" and "it is now in
 * your work", and it opens only on an explicit human decision. Not on high
 * confidence, not on a timer, not in bulk without someone pressing the
 * button.
 *
 * The concentration is the design. An extraction engine that can write on its
 * own is a different and much worse product, and a rule spread across four
 * modules is a rule that gets forgotten in the fifth. Here it is one import
 * list to check, and a guard test checks it.
 *
 * ## What each kind becomes
 *
 *   · `task`         → a task template + a work item, filed by the same
 *                      triage pass every other deterministic producer uses,
 *                      carrying `noteId` so the work remembers the note.
 *   · `memory`       → a concept page, honouring the conflict resolution the
 *                      owner chose (replace / keep both / ignore).
 *   · `person_trait` → a line on the contact's notes.
 *
 * ## Failure is never silent and never partial
 *
 * If the write fails, the proposal stays `proposed`. It is never marked
 * accepted for something that did not happen — a rail that says "Filed 3
 * tasks" when two landed is worse than one that says it could not.
 */

import { searchContacts, upsertContact } from "../contacts/contact-store.js";
import { readPage, slugify, writePage } from "../memory/v2/page-store.js";
import { createTask } from "../tasks/task-store.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import {
  createWorkItemWithPermissions,
  deleteWorkItem,
  getWorkItem,
} from "../work-items/work-item-store.js";
import {
  conservativeRequiredToolsForCapture,
  triageAndMaybeAutoRunWorkItem,
} from "../work-items/work-item-triage.js";
import {
  getExtraction,
  getNote,
  type NoteConflictResolution,
  type NoteExtraction,
  recordExtractionDecision,
  reopenExtraction,
} from "./note-store.js";

const log = getLogger("note-accept");

export type AcceptResult =
  | {
      status: "accepted";
      extraction: NoteExtraction;
      refType: "work_item" | "memory_page" | "contact";
      refId: string;
    }
  /** The owner chose `ignore` on a conflict — recorded as dismissed, no write. */
  | { status: "dismissed"; extraction: NoteExtraction }
  | { status: "not_found" }
  /** Already decided. Accepting twice must not create the thing twice. */
  | { status: "already_decided"; extraction: NoteExtraction }
  | { status: "failed"; error: string };

export interface AcceptOptions {
  /**
   * Required when the proposal carries a conflict. Defaults to `keep_both`
   * — the answer that loses nothing — rather than to `replace`, because a
   * caller that forgot to ask must not be the reason a true fact is
   * overwritten.
   */
  resolution?: NoteConflictResolution;
}

/**
 * Turn one proposal into the thing it proposes.
 *
 * Order matters: the write happens FIRST and the row is marked accepted only
 * once it succeeded, carrying the id of what was created. A row marked
 * accepted with nothing behind it is a lie the rail would then repeat.
 */
export async function acceptExtraction(
  extractionId: string,
  options: AcceptOptions = {},
): Promise<AcceptResult> {
  const extraction = getExtraction(extractionId);
  if (!extraction) return { status: "not_found" };
  if (extraction.state !== "proposed") {
    return { status: "already_decided", extraction };
  }

  const note = getNote(extraction.noteId);
  if (!note) return { status: "not_found" };

  const resolution: NoteConflictResolution = extraction.conflict
    ? (options.resolution ?? "keep_both")
    : "keep_both";

  // "Ignore" is a real answer to a conflict, and it writes nothing at all.
  if (extraction.conflict && resolution === "ignore") {
    const decided = recordExtractionDecision(extractionId, "dismissed", {
      conflictResolution: "ignore",
    });
    return { status: "dismissed", extraction: decided ?? extraction };
  }

  try {
    switch (extraction.kind) {
      case "task": {
        const id = await acceptAsTask(extraction, note.id);
        return finish(extractionId, extraction, "work_item", id, resolution);
      }
      case "memory": {
        const written = await acceptAsMemory(extraction, resolution);
        return finish(
          extractionId,
          extraction,
          "memory_page",
          written.slug,
          resolution,
          { line: written.line },
        );
      }
      case "person_trait": {
        const written = acceptAsPersonTrait(extraction);
        return finish(
          extractionId,
          extraction,
          "contact",
          written.contactId,
          resolution,
          { line: written.line },
        );
      }
      default:
        return { status: "failed", error: `unknown kind ${extraction.kind}` };
    }
  } catch (err) {
    // The proposal stays `proposed` so the owner can try again. Nothing is
    // marked filed that isn't.
    log.warn(
      { err: String(err), extractionId, kind: extraction.kind },
      "accepting a note extraction failed; leaving it proposed",
    );
    return { status: "failed", error: String(err) };
  }
}

function finish(
  extractionId: string,
  extraction: NoteExtraction,
  refType: "work_item" | "memory_page" | "contact",
  refId: string,
  resolution: NoteConflictResolution,
  /** Exactly what was written, so undo can take back that and only that. */
  applied?: Record<string, unknown>,
): AcceptResult {
  const decided = recordExtractionDecision(extractionId, "accepted", {
    acceptedRefType: refType,
    acceptedRefId: refId,
    ...(extraction.conflict ? { conflictResolution: resolution } : {}),
    ...(applied ? { applied } : {}),
  });
  return {
    status: "accepted",
    extraction: decided ?? extraction,
    refType,
    refId,
  };
}

/** Dismiss a proposal. Writes nothing anywhere — that is the entire point. */
export function dismissExtraction(extractionId: string): AcceptResult {
  const extraction = getExtraction(extractionId);
  if (!extraction) return { status: "not_found" };
  if (extraction.state !== "proposed") {
    return { status: "already_decided", extraction };
  }
  const decided = recordExtractionDecision(extractionId, "dismissed");
  return { status: "dismissed", extraction: decided ?? extraction };
}

// -- task --------------------------------------------------------------------

function payloadString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Mint the task, then hand it to the same triage pass every other
 * deterministic producer uses — so an accepted note-task is ranked, filed
 * onto its best-matching project, and governed by the existing autonomy
 * policy exactly like a captured commitment. Notes do not get their own
 * autonomy rules; acceptance IS the human decision, and what happens after
 * it is the policy the owner already set.
 */
async function acceptAsTask(
  extraction: NoteExtraction,
  noteId: string,
): Promise<string> {
  const title =
    payloadString(extraction.payload, "title") ??
    payloadString(extraction.payload, "detail") ??
    "Untitled";
  const detail = payloadString(extraction.payload, "detail") ?? title;

  const task = createTask({ title, template: detail });
  const notes = `From your note · ${new Date().toISOString().slice(0, 10)}`;
  const requiredTools = conservativeRequiredToolsForCapture(title, notes);

  const workItem = createWorkItemWithPermissions({
    taskId: task.id,
    title,
    notes,
    priorityTier: 1,
    noteId,
    ...(requiredTools ? { requiredTools } : {}),
  });

  await triageAndMaybeAutoRunWorkItem(workItem.id);
  return workItem.id;
}

// -- memory ------------------------------------------------------------------

/**
 * Write the fact to a concept page.
 *
 * `keep_both` appends, so the older value survives alongside the newer with
 * both dates readable — which is what makes it a safe default for the prices
 * and dates that legitimately change. `replace` swaps the contradicted
 * sentence and nothing else on the page; it is the only destructive path in
 * Notes, and it runs only because someone chose it by name.
 */
async function acceptAsMemory(
  extraction: NoteExtraction,
  resolution: NoteConflictResolution,
): Promise<{ slug: string; line: string }> {
  const fact =
    payloadString(extraction.payload, "detail") ??
    payloadString(extraction.payload, "title");
  if (!fact) throw new Error("memory proposal carried no text");

  const workspaceDir = getWorkspaceDir();
  const slug = memorySlugFor(extraction, fact);
  const existing = await readPage(workspaceDir, slug);
  const stamp = new Date().toISOString().slice(0, 10);
  const line = `- ${fact} _(from your note, ${stamp})_`;

  let body: string;
  if (!existing) {
    body = `${line}\n`;
  } else if (resolution === "replace" && extraction.conflict) {
    const target = extraction.conflict.existing.trim();
    body = existing.body.includes(target)
      ? existing.body.replace(
          target,
          `${fact} _(updated from your note, ${stamp})_`,
        )
      : `${existing.body.trimEnd()}\n${line}\n`;
  } else {
    body = `${existing.body.trimEnd()}\n${line}\n`;
  }

  const page = {
    slug,
    frontmatter: existing?.frontmatter ?? {
      edges: [],
      ref_files: [],
      ref_urls: [],
    },
    body,
  };
  await writePage(workspaceDir, page);
  return { slug, line };
}

/**
 * Which page a fact lands on. A conflicting fact goes back to the page it
 * disagreed with — otherwise "replace" would write a second page saying the
 * opposite of the first, which is the failure this whole screen exists to
 * prevent.
 */
function memorySlugFor(extraction: NoteExtraction, fact: string): string {
  const conflictSlug = extraction.conflict?.existingSource.split("· ")[1];
  if (conflictSlug) return conflictSlug.trim();
  return slugify(fact.split(/[.:;]/)[0] ?? fact);
}

// -- person trait ------------------------------------------------------------

/**
 * Append what was learned to the person's notes, matching an existing contact
 * by name where there is one. A new name creates a contact rather than
 * dropping the trait — a person you have written about once is a person.
 */
function acceptAsPersonTrait(extraction: NoteExtraction): {
  contactId: string;
  line: string;
} {
  const person = payloadString(extraction.payload, "person");
  const trait =
    payloadString(extraction.payload, "detail") ??
    payloadString(extraction.payload, "title");
  if (!person) throw new Error("person_trait proposal named no person");
  if (!trait) throw new Error("person_trait proposal carried no text");

  const matches = searchContacts({ query: person, limit: 1 });
  const existing = matches[0];
  const stamp = new Date().toISOString().slice(0, 10);
  const line = `- ${trait} (from your note, ${stamp})`;
  const appended = existing?.notes
    ? `${existing.notes.trimEnd()}\n${line}`
    : line;

  const saved = upsertContact({
    ...(existing ? { id: existing.id } : {}),
    displayName: existing?.displayName ?? person,
    notes: appended,
  });
  return { contactId: saved.id, line };
}

// -- undo ---------------------------------------------------------------------

export type UndoResult =
  | { status: "undone"; extraction: NoteExtraction }
  | { status: "not_found" }
  /** Nothing to undo — this was never accepted. */
  | { status: "not_accepted" }
  /**
   * The thing acceptance created has since been worked on, so taking it back
   * would destroy something rather than reverse something.
   */
  | { status: "too_late"; reason: string }
  | { status: "failed"; error: string };

/**
 * Take back an acceptance.
 *
 * ## Why this is bounded rather than always available
 *
 * Undo here is a **reversal**, not a delete. It exists so that pressing
 * Accept is not a decision you have to be sure about — which is only true
 * while the thing that was created is still exactly as acceptance left it.
 * Once a task has run, or someone has edited the page the fact landed on,
 * "undo" would be destroying work rather than reversing a click, and quietly
 * doing that would be far worse than declining.
 *
 * So it refuses, and says why. A refusal someone can understand beats an
 * undo that silently does the wrong thing.
 *
 * ## It takes back exactly what was written
 *
 * The line acceptance wrote was recorded at the time rather than
 * reconstructed now — reconstructing it would drift the moment the formatting
 * changes, and an undo that removes the wrong line is worse than none.
 */
export async function undoExtraction(
  extractionId: string,
): Promise<UndoResult> {
  const extraction = getExtraction(extractionId);
  if (!extraction) return { status: "not_found" };
  if (extraction.state !== "accepted") return { status: "not_accepted" };

  const refId = extraction.acceptedRefId;
  const applied = (extraction.payload as { applied?: { line?: string } })
    .applied;

  try {
    switch (extraction.acceptedRefType) {
      case "work_item": {
        if (!refId) break;
        const item = getWorkItem(refId);
        // Already gone: the acceptance has nothing left behind it, so
        // reopening the proposal is the whole of the undo.
        if (!item) break;
        if (item.status !== "queued" || item.lastRunId) {
          return {
            status: "too_late",
            reason:
              "Cue has already started on that one, so I've left it alone. You can cancel it in HQ.",
          };
        }
        deleteWorkItem(refId);
        break;
      }
      case "memory_page": {
        if (!refId || !applied?.line) break;
        const removed = await removeLineFromPage(refId, applied.line);
        if (!removed) {
          return {
            status: "too_late",
            reason:
              "That page has changed since, so I've left it as it is rather than guess at what to remove.",
          };
        }
        break;
      }
      case "contact": {
        if (!refId || !applied?.line) break;
        removeLineFromContact(refId, applied.line);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    // The proposal stays accepted, because it still is. Reopening it here
    // would leave a row saying "proposed" while the task sits in HQ.
    log.warn({ err: String(err), extractionId }, "undo failed");
    return { status: "failed", error: String(err) };
  }

  const reopened = reopenExtraction(extractionId);
  return { status: "undone", extraction: reopened ?? extraction };
}

/**
 * Remove one line from a concept page, and only if it is still there
 * unchanged. Returns false when it is not — someone has edited around it, and
 * guessing at what to take out would damage their memory rather than restore
 * it.
 */
async function removeLineFromPage(
  slug: string,
  line: string,
): Promise<boolean> {
  const workspaceDir = getWorkspaceDir();
  const page = await readPage(workspaceDir, slug);
  if (!page || !page.body.includes(line)) return false;

  const body = page.body
    .split("\n")
    .filter((row) => row.trim() !== line.trim())
    .join("\n");
  await writePage(workspaceDir, { ...page, body });
  return true;
}

function removeLineFromContact(contactId: string, line: string): void {
  const [contact] = searchContacts({ query: "", limit: 1 }).filter(
    (c) => c.id === contactId,
  );
  if (!contact?.notes || !contact.notes.includes(line)) return;
  upsertContact({
    id: contact.id,
    displayName: contact.displayName,
    notes: contact.notes
      .split("\n")
      .filter((row) => row.trim() !== line.trim())
      .join("\n"),
  });
}

/**
 * File commitments an answer surfaced, as work.
 *
 * **This is the acceptance step for the ask surface**, and it lives here for
 * the same reason everything else that writes does: `note-ask.ts` sits on the
 * proposal path and may not so much as import the work store
 * (`acceptance-boundary.test.ts` enforces that on the import, not the call,
 * "even if it never calls it, because the next edit will"). An answer reports
 * what is owed; only this turns one into a row, and only when asked.
 *
 * The work items carry no `noteId`: an answer is drawn from several stores
 * and is explicitly not saved as a note, so there is no single note for the
 * task to point back at. Claiming one would be inventing provenance.
 */
export async function fileCommitmentsAsWork(titles: string[]): Promise<number> {
  let created = 0;
  for (const title of titles) {
    try {
      const task = createTask({ title, template: title });
      const notes = `From an answer · ${new Date().toISOString().slice(0, 10)}`;
      const requiredTools = conservativeRequiredToolsForCapture(title, notes);
      const workItem = createWorkItemWithPermissions({
        taskId: task.id,
        title,
        notes,
        priorityTier: 1,
        ...(requiredTools ? { requiredTools } : {}),
      });
      await triageAndMaybeAutoRunWorkItem(workItem.id);
      created += 1;
    } catch (err) {
      // One bad title must not lose the rest of the owner's choices.
      log.debug({ err: String(err), title }, "ask: filing commitment failed");
    }
  }
  return created;
}
