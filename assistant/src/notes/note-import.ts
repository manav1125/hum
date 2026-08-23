/**
 * Bringing an existing pile of notes in.
 *
 * This is what converts Notes from a feature that needs six months of
 * discipline into one that is worth something on night one. Someone arriving
 * with two years of Apple Notes should be able to ask questions of them
 * immediately, rather than waiting to accumulate a pile they already have.
 *
 * ## The extraction window is the whole design
 *
 * Imported notes are **searchable immediately, always**. The only question
 * the import asks is what to *propose as work*, and the default is
 * `last_month` for a reason worth stating plainly: proposing 73 tasks from
 * two years of archive is how you make someone's HQ unusable on their first
 * day. It is also dishonest — a two-year-old "call the dentist" is not a
 * live commitment, and treating it as one degrades every real proposal
 * beside it.
 *
 * `all` and `none` both exist because the default cannot be right for
 * everyone: someone importing last quarter's project notes means all of it,
 * and someone importing a decade of journals means none.
 *
 * ## Nothing leaves the machine
 *
 * Parsing happens here, in the daemon, on the owner's own device. There is no
 * upload step and no third-party parser — which is the same promise the
 * memory import makes, and the reason people are willing to hand over a
 * decade of private writing at all.
 */

import { getLogger } from "../util/logger.js";
import { createNote, type Note } from "./note-store.js";

const log = getLogger("note-import");

/** What to PROPOSE from. Everything imported is searchable regardless. */
export type ImportExtractionWindow = "last_month" | "all" | "none";

/** Where the pile came from. Display only — an import obeys acceptance too. */
export type ImportTool =
  | "apple-notes"
  | "notion"
  | "obsidian"
  | "mem"
  | "markdown"
  | "unknown";

/** Hard cap per call, so one drag-and-drop cannot wedge the daemon. */
export const MAX_IMPORT_NOTES = 2_000;

const LAST_MONTH_MS = 31 * 24 * 3600_000;

export interface ImportNoteInput {
  title?: string;
  body: string;
  /** The note's own date where the export carried one. */
  occurredAt?: number;
}

export interface ImportSummary {
  imported: number;
  /** Skipped as empty — an export full of blank notes is normal. */
  skipped: number;
  /**
   * How many are inside the extraction window and will be read. The number
   * the owner is shown BEFORE anything is proposed, so "only the last month"
   * is a promise they can check rather than one they have to trust.
   */
  queuedForReading: number;
  window: ImportExtractionWindow;
}

/**
 * Which imported notes get read for things to do.
 *
 * Exported and tested separately because it is the decision the whole feature
 * turns on, and because "the default proposes only recent work" is a claim
 * that should be checkable rather than asserted.
 */
export function selectForExtraction(
  notes: readonly Note[],
  window: ImportExtractionWindow,
  now = Date.now(),
): Note[] {
  if (window === "none") return [];
  if (window === "all") return [...notes];
  return notes.filter((note) => now - note.occurredAt <= LAST_MONTH_MS);
}

/**
 * Split a markdown export into notes, one per file.
 *
 * A `# heading` on the first line becomes the title, which is what every tool
 * in this list writes — and if it does not, the first line is the title
 * anyway, exactly as a typed note behaves.
 */
export function parseMarkdownExport(
  files: readonly { name: string; content: string }[],
): ImportNoteInput[] {
  return files.flatMap((file) => {
    const body = file.content.trim();
    if (!body) return [];
    const firstLine = body.split("\n")[0]?.trim() ?? "";
    const heading = /^#{1,3}\s+(.*)$/.exec(firstLine);
    return [
      {
        // A filename is a fallback, not a preference: `2026-03-14-1423.md`
        // tells the owner nothing, and the heading they wrote does.
        title: heading?.[1]?.trim() || firstLine || file.name,
        body: heading ? body.split("\n").slice(1).join("\n").trim() : body,
      },
    ];
  });
}

/**
 * Import a batch.
 *
 * Every note is written with `source: "import"`, and **imported notes obey
 * acceptance exactly like something typed by hand** — the import creates
 * notes, never tasks. Returning the reading queue rather than reading here
 * keeps that boundary intact: this module holds no extractor.
 */
export function importNotes(
  inputs: readonly ImportNoteInput[],
  options: { tool?: ImportTool; window?: ImportExtractionWindow } = {},
): { summary: ImportSummary; notes: Note[]; toRead: Note[] } {
  const window = options.window ?? "last_month";
  const tool = options.tool ?? "unknown";

  const capped = inputs.slice(0, MAX_IMPORT_NOTES);
  const notes: Note[] = [];
  let skipped = 0;

  for (const input of capped) {
    const body = input.body?.trim() ?? "";
    if (!body) {
      skipped += 1;
      continue;
    }
    try {
      notes.push(
        createNote({
          body,
          ...(input.title ? { title: input.title } : {}),
          source: "import",
          sourceDetail: tool,
          // The note's own date where the export had one. Without this every
          // imported note would date from the import, which would put a
          // decade of writing at the top of today's list and make the
          // last-month window meaningless.
          ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        }),
      );
    } catch (err) {
      // One malformed note must not sink the batch — someone importing ten
      // years of writing will have a few strange rows in there.
      log.warn({ err: String(err) }, "skipped a note during import");
      skipped += 1;
    }
  }

  const toRead = selectForExtraction(notes, window);
  return {
    summary: {
      imported: notes.length,
      skipped: skipped + Math.max(0, inputs.length - capped.length),
      queuedForReading: toRead.length,
      window,
    },
    notes,
    toRead,
  };
}
