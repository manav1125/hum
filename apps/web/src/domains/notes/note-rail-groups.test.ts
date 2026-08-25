import { describe, expect, test } from "bun:test";

import { groupProposals } from "./note-rail";
import type { NoteExtraction } from "@/types/notes";

/**
 * The rail's grouping — design `1a`.
 *
 * Grouped because the three kinds are answered differently: a task is
 * something you will do, a fact is something Cue will remember, and a person
 * note changes how it talks about somebody. Read as one undifferentiated list
 * they all look like the same small decision, and the person notes — the ones
 * with the longest reach — are the easiest to wave through.
 */

const item = (id: string, kind: NoteExtraction["kind"]): NoteExtraction =>
  ({ id, kind }) as NoteExtraction;

describe("three kinds, in a fixed order", () => {
  test("things, then facts, then people", () => {
    const groups = groupProposals([
      item("c", "person_trait"),
      item("a", "task"),
      item("b", "memory"),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["thing", "fact", "person"]);
  });

  test("the order does not follow the counts", () => {
    // A rail that rearranged itself between two readings of the same note
    // would make the reader re-find everything each time.
    const groups = groupProposals([
      item("a", "person_trait"),
      item("b", "person_trait"),
      item("c", "person_trait"),
      item("d", "task"),
    ]);
    expect(groups[0]?.label).toBe("thing");
  });

  test("an empty kind gets no heading — no '0 tasks found'", () => {
    const groups = groupProposals([item("a", "task")]);
    expect(groups).toHaveLength(1);
  });

  test("plurals are counted, not assumed", () => {
    const groups = groupProposals([
      item("a", "task"),
      item("b", "task"),
      item("c", "memory"),
    ]);
    expect(groups.map((g) => `${g.items.length} ${g.label}`)).toEqual([
      "2 things",
      "1 fact",
    ]);
  });

  test("REGRESSION: a kind this list has not been taught still reaches the owner", () => {
    // An extraction that renders nowhere is a proposal that files itself by
    // never being refused.
    const groups = groupProposals([
      item("a", "task"),
      item("x", "something-new" as NoteExtraction["kind"]),
    ]);
    expect(groups.flatMap((g) => g.items.map((i) => i.id))).toContain("x");
  });
});
