/**
 * N4 — when a note contradicts memory.
 *
 * The case the design draws: memory holds "Acme's ceiling is $52 a seat" from
 * Dana's email, and today's note says "they'll approve at $47". Accepting
 * that silently is how an assistant becomes confidently wrong, so the
 * disagreement has to be found before the proposal is ever offered.
 *
 * The tests below are as much about what must NOT raise the screen. A
 * conflict prompt that fires on two unrelated sentences that happen to share
 * a word is a prompt people learn to click through, and a conflict screen
 * people click through is worse than none.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { rm } from "node:fs/promises";

import { getConceptsDir, writePage } from "../memory/v2/page-store.js";
import { getWorkspaceDir } from "../util/platform.js";
import {
  attachConflict,
  claimValues,
  findContradiction,
  subjectTerms,
} from "./note-conflict.js";
import type { ExtractedItem } from "./note-extraction.js";

async function seedPage(slug: string, body: string): Promise<void> {
  await writePage(getWorkspaceDir(), {
    slug,
    frontmatter: { edges: [], ref_files: [], ref_urls: [] },
    body,
  });
}

beforeEach(async () => {
  await rm(getConceptsDir(getWorkspaceDir()), {
    recursive: true,
    force: true,
  });
});

const memoryItem = (detail: string): ExtractedItem => ({
  kind: "memory",
  confidenceTier: "confident",
  reason: null,
  payload: { title: detail, detail, person: null, dueAt: null },
});

describe("subjectTerms", () => {
  test("excludes the numbers, which are the values being compared", () => {
    const terms = subjectTerms("Acme procurement approves at $47 a seat");
    expect(terms.has("acme")).toBe(true);
    expect(terms.has("procurement")).toBe(true);
    expect(terms.has("47")).toBe(false);
  });
});

describe("claimValues", () => {
  test("reads money, percentages and durations", () => {
    const values = claimValues("$47 a seat on a 24-month term, up 22%");
    expect(values.has("$47")).toBe(true);
    expect(values.has("22%")).toBe(true);
    expect([...values].some((v) => v.includes("24-month"))).toBe(true);
  });
});

describe("findContradiction", () => {
  test("finds the disagreement the design draws", async () => {
    await seedPage(
      "acme",
      "Acme procurement has a ceiling of $52 a seat on the renewal.",
    );

    const found = await findContradiction(
      "Acme procurement will approve at $47 a seat on the renewal.",
    );
    expect(found?.text).toContain("$52");
    expect(found?.source).toContain("acme");
  });

  test("agreement is not a contradiction", async () => {
    await seedPage("acme", "Acme procurement approves at $47 a seat.");
    expect(
      await findContradiction("Acme procurement approves at $47 a seat."),
    ).toBeNull();
  });

  test("two claims about the same subject making DIFFERENT claims do not collide", async () => {
    await seedPage("acme", "Acme wants a 24-month term on the renewal.");
    // Shares a subject and both carry numbers, but they are not the same
    // claim — raising a conflict here is the false positive that teaches
    // people to click through.
    expect(
      await findContradiction("Acme has 30 people on the renewal."),
    ).toBeNull();
  });

  test("a qualitative claim never raises the screen", async () => {
    await seedPage("acme", "Acme's ceiling is $52 a seat.");
    expect(
      await findContradiction("Acme seem keen on the renewal."),
    ).toBeNull();
  });

  test("an empty memory corpus is 'no conflict', never an error", async () => {
    expect(await findContradiction("Acme approve at $47 a seat.")).toBeNull();
  });
});

describe("attachConflict", () => {
  test("only memory proposals can conflict", async () => {
    const task: ExtractedItem = {
      kind: "task",
      confidenceTier: "confident",
      reason: null,
      payload: { title: "Hold $47 a seat", detail: "Hold $47 a seat" },
    };
    await seedPage("acme", "Acme's ceiling is $52 a seat on the renewal.");
    expect(await attachConflict(task)).toBeNull();
  });

  test("carries both values WITH where each came from", async () => {
    await seedPage(
      "acme",
      "Acme procurement has a ceiling of $52 a seat on the renewal.",
    );
    const conflict = await attachConflict(
      memoryItem("Acme procurement will approve at $47 a seat on the renewal."),
    );

    expect(conflict).not.toBeNull();
    expect(conflict?.existing).toContain("$52");
    expect(conflict?.existingSource).toContain("acme");
    expect(conflict?.incoming).toContain("$47");
    expect(conflict?.incomingSource).toBe("this note");
  });
});
