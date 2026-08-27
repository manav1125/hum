/**
 * Notes invalidation — the predicate that matched nothing.
 *
 * Every notes mutation called this, and it never invalidated a single query:
 * the test was `JSON.stringify(queryKey).includes("/notes")`, and a generated
 * key has no slash anywhere in it. An imported note never appeared, a renamed
 * note kept its old title, and the header counts — the feature's central
 * claim — went stale the moment anything changed.
 */
import { describe, expect, test } from "bun:test";

import { isNotesQuery } from "./use-invalidate-notes";

/** The real shape, from `createQueryKey` in the generated client. */
const key = (id: string) => ({
  queryKey: [
    { _id: id, baseUrl: "https://x.example", path: { assistant_id: "a1" } },
  ] as const,
});

describe("it matches the queries Notes actually reads", () => {
  test("REGRESSION: the list query is matched", () => {
    // The old predicate looked for "/notes" and this key has no slash in it.
    expect(JSON.stringify(key("notesGet").queryKey)).not.toContain("/notes");
    expect(isNotesQuery(key("notesGet"))).toBe(true);
  });

  test("the note detail and the waiting count are matched too", () => {
    expect(isNotesQuery(key("notesByIdGet"))).toBe(true);
    expect(isNotesQuery(key("notesExtractionsWaitingGet"))).toBe(true);
  });

  test("it does not invalidate the rest of the app", () => {
    expect(isNotesQuery(key("contactsGet"))).toBe(false);
    expect(isNotesQuery(key("hqValveFeedbackPost"))).toBe(false);
  });

  test("anchored at the start, so a lookalike id is not swept in", () => {
    expect(isNotesQuery(key("deniedNotesGet"))).toBe(false);
  });

  test("a key that is not the generated shape is simply not ours", () => {
    expect(isNotesQuery({ queryKey: ["notes", "list"] })).toBe(false);
    expect(isNotesQuery({ queryKey: [] })).toBe(false);
  });
});
