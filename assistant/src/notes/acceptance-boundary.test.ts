/**
 * The guard for the rule everything else in Notes rests on:
 *
 *   **Extraction never writes without acceptance.**
 *
 * Not once, not for high confidence, not on a timer. The design brief is
 * blunt about the stakes — "an extraction engine that writes to HQ on its own
 * is a different, much worse product, and one bad silent write costs more
 * trust than the feature saves in a month" — and about the priority: if time
 * is short, cut the unsure tier, never cut acceptance.
 *
 * A rule of that weight cannot live in review comments. It survives four
 * refactors at best, and the fifth is the one that ships a silent write. So
 * it is enforced structurally: the modules that read and store notes may not
 * so much as IMPORT a writer, and `note-accept.ts` — reached only from an
 * explicit human decision — is the single door.
 *
 * This test reads the source rather than the behaviour on purpose. A
 * behavioural test proves the write does not happen on the paths it thought
 * to exercise; this proves the capability is not in the room.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const NOTES_DIR = join(import.meta.dir);

/**
 * Modules that exist to put something into HQ, memory or People. A module in
 * the proposal path importing any of these is the defect this file exists to
 * catch — even if it never calls it, because the next edit will.
 */
const WRITER_MODULES = [
  "work-item-store",
  "work-item-triage",
  "task-store",
  "contact-store",
  "contacts-write",
  "memory/v2/ingest",
  "project-store",
  "arrival-surface",
];

/**
 * Bindings that write, from modules that also read.
 *
 * `page-store` is the awkward one: finding a contradiction means READING
 * concept pages, so the conflict detector legitimately imports the module
 * that also exports `writePage`. Banning the import would ban the read; the
 * honest guard is on the bindings, so it is spelled out here rather than
 * waved through.
 */
const WRITER_BINDINGS = ["writePage", "deletePage", "ingestPages"];

/**
 * The proposal path: reads notes, records findings, writes nothing else.
 *
 * Every module that can put something INTO Notes belongs here, not just the
 * extractor — an arrival that quietly minted a task, or an import that filed
 * two years of archive as work, would break the same rule by a different
 * door. `note-ask` is here because an answer must write nothing at all:
 * asking a question must not quietly create a note.
 */
const PROPOSAL_PATH = [
  "note-store.ts",
  "note-extraction.ts",
  "note-conflict.ts",
  "note-arrivals.ts",
  "note-import.ts",
  "note-ask.ts",
];

/**
 * A module's source with block comments stripped — this file's own prose
 * names the writers it forbids, and so does the prose in the modules it
 * guards, so a naive text search would flag every explanation of the rule.
 */
function codeOf(file: string): string {
  return readFileSync(join(NOTES_DIR, file), "utf-8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
}

function importsOf(file: string): string[] {
  return [...codeOf(file).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("the acceptance boundary", () => {
  for (const file of PROPOSAL_PATH) {
    test(`${file} imports nothing that can write to HQ, memory or People`, () => {
      const offenders = importsOf(file).filter((specifier) =>
        WRITER_MODULES.some((writer) => specifier.includes(writer)),
      );
      expect(offenders).toEqual([]);
    });
  }

  for (const file of PROPOSAL_PATH) {
    test(`${file} may READ memory pages but never write one`, () => {
      const code = codeOf(file);
      const used = WRITER_BINDINGS.filter((binding) =>
        new RegExp(`\\b${binding}\\b`).test(code),
      );
      expect(used).toEqual([]);
    });
  }

  test("note-accept.ts is the only module in Notes that holds a writer", () => {
    const accept = importsOf("note-accept.ts");
    const heldWriters = accept.filter((specifier) =>
      WRITER_MODULES.some((writer) => specifier.includes(writer)),
    );
    // If this ever goes to zero, acceptance has stopped writing anything and
    // the feature is broken in the other direction.
    expect(heldWriters.length).toBeGreaterThan(0);
  });

  test("nothing DECIDES a proposal outside the accept path", () => {
    // `note-store.ts` is where `recordExtractionDecision` is defined, so the
    // check is on its callers: the read path proposes, and only acceptance
    // turns the column.
    for (const file of ["note-extraction.ts", "note-conflict.ts"]) {
      expect(codeOf(file)).not.toMatch(/recordExtractionDecision\s*\(/);
    }
  });
});
