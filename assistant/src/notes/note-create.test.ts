/**
 * A note as a brief — and the restraint that keeps the suggestions credible.
 *
 * The options offered have to be the note's *plausible* outputs, not a menu
 * of everything Create can do. A note about a customer offering a video style
 * is the difference between "make something from this" reading as a
 * suggestion and reading as a toy box — and a toy box is what makes people
 * stop trusting suggestions everywhere else in the product.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

import { briefFor, createOptionsFor, readNoteShape } from "./note-create.js";
import type { Note } from "./note-store.js";

const note = (body: string): Note =>
  ({
    id: "n1",
    title: body.split("\n")[0] ?? "",
    body,
    occurredAt: Date.parse("2026-03-14T09:00:00Z"),
  }) as Note;

const CUSTOMER = note(
  "Acme kickoff — migration is the real objection, not price. Dana called and they've been burned twice.",
);
const PLAN = note(
  "Ship Halo: tooling by Friday, then the launch phase in Nov.",
);
const MUSING = note("Been thinking about how the team feels lately.");

describe("readNoteShape", () => {
  test("recognises a note about a person and about terms", () => {
    expect(readNoteShape(CUSTOMER).aboutAPerson).toBe(true);
    expect(
      readNoteShape(note("they'll approve at $47 a seat")).aboutMoneyOrTerms,
    ).toBe(true);
  });

  test("recognises a note about a plan", () => {
    expect(readNoteShape(PLAN).aboutAPlan).toBe(true);
  });
});

describe("createOptionsFor", () => {
  test("a customer note offers a deck and an email", () => {
    const kinds = createOptionsFor(CUSTOMER).map((o) => o.kind);
    expect(kinds).toContain("deck");
    expect(kinds).toContain("email");
  });

  test("a plan note offers a plan", () => {
    expect(createOptionsFor(PLAN).map((o) => o.kind)).toContain("plan");
  });

  test("never offers more than four — a menu is not a suggestion", () => {
    for (const n of [CUSTOMER, PLAN, MUSING]) {
      expect(createOptionsFor(n).length).toBeLessThanOrEqual(4);
    }
  });

  test("a note matching nothing still offers something real", () => {
    // "Make something from this" that offers nothing is a dead button.
    const kinds = createOptionsFor(MUSING).map((o) => o.kind);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).toContain("one_pager");
  });

  test("a musing does not get offered an email to nobody", () => {
    expect(createOptionsFor(MUSING).map((o) => o.kind)).not.toContain("email");
  });
});

describe("briefFor", () => {
  test("carries the note verbatim and forbids inventing round it", () => {
    const brief = briefFor(CUSTOMER);
    expect(brief).toContain("migration is the real objection");
    // The same standard the extractor holds itself to, carried into the
    // thing that gets made.
    expect(brief).toContain("rather than inventing it");
  });

  test("dates the brief from when the thought happened", () => {
    expect(briefFor(CUSTOMER)).toContain("2026-03-14");
  });
});
