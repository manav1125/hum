/**
 * The three stores R2 added to recall: notes, mail and work.
 *
 * The demo that decides whether "ask" is worth having is a five-month-old
 * note nobody would have gone looking for, surfaced because it answers the
 * question. So the test that matters most here is the one asserting **age is
 * never a filter** — an old note is not a worse note, it is a note whose age
 * the answer should state and let the reader judge.
 *
 * The second is that mail Cue FILED is still searchable. "Filed" was always a
 * decision about interrupting you, never about deleting; a search that
 * skipped it would answer "nothing from Stripe" about an inbox full of it.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

import { recordArrival } from "../../../arrivals/arrival-store.js";
import { createNote } from "../../../notes/note-store.js";
import { createTask } from "../../../tasks/task-store.js";
import { createWorkItem } from "../../../work-items/work-item-store.js";
import { getDb } from "../../db-connection.js";
import { initializeDb } from "../../db-init.js";
import type { RecallSearchContext } from "../types.js";
import { searchEmailSource } from "./email.js";
import { queryTerms, scoreNote, searchNotesSource } from "./notes.js";
import { searchWorkSource } from "./work.js";

initializeDb();

const context = {
  workingDir: "/tmp",
  conversationId: "test",
  config: {} as RecallSearchContext["config"],
} as RecallSearchContext;

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM notes");
  db.run("DELETE FROM note_extractions");
  db.run("DELETE FROM work_items");
  db.run("DELETE FROM tasks");
  db.run("DELETE FROM arrivals");
});

describe("queryTerms", () => {
  test("drops stop words and fragments that rank nothing", () => {
    expect(queryTerms("what have we promised to Acme")).toEqual([
      "promised",
      "acme",
    ]);
  });

  test("keeps money and numbers, which are often the whole question", () => {
    expect(queryTerms("did we agree $47")).toContain("$47");
  });
});

describe("scoreNote", () => {
  test("more of the asked-about terms scores higher", () => {
    const terms = ["acme", "migration"];
    expect(scoreNote("acme and the migration", terms)).toBe(1);
    expect(scoreNote("acme only", terms)).toBe(0.5);
    expect(scoreNote("nothing relevant", terms)).toBe(0);
  });
});

describe("the notes source", () => {
  test("finds a note by its words", async () => {
    createNote({ body: "Migration is the real objection, not price." });

    const { evidence } = await searchNotesSource(
      "what is the objection about migration",
      context,
      5,
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.source).toBe("notes");
    expect(evidence[0]?.locator).toMatch(/^notes\//);
  });

  test("THE DEMO: a five-month-old note is not filtered out by age", async () => {
    const march = Date.parse("2026-03-14T09:00:00Z");
    createNote({
      body: "We said we'd cover the migration for Acme.",
      occurredAt: march,
    });
    createNote({ body: "Unrelated thought about lunch." });

    const { evidence } = await searchNotesSource(
      "did we promise to cover the migration",
      context,
      5,
    );

    // The whole value of asking is surfacing the thing nobody would have gone
    // looking for. Age belongs in the answer, never in the filter.
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.timestampMs).toBe(march);
  });

  test("ranks the note carrying more of the question above one carrying less", async () => {
    createNote({ body: "Acme mentioned once." });
    createNote({ body: "Acme and the migration and the discount." });

    const { evidence } = await searchNotesSource(
      "acme migration discount",
      context,
      5,
    );
    expect(evidence[0]?.excerpt).toContain("migration");
  });

  test("dates from when the THOUGHT happened, not when the row was written", async () => {
    const when = Date.parse("2026-03-14T09:00:00Z");
    createNote({ body: "Acme migration promise", occurredAt: when });
    const { evidence } = await searchNotesSource("acme migration", context, 5);
    expect(evidence[0]?.timestampMs).toBe(when);
  });

  test("a query of only stop words searches nothing rather than everything", async () => {
    createNote({ body: "Acme migration promise" });
    const { evidence } = await searchNotesSource("what are the", context, 5);
    expect(evidence).toEqual([]);
  });
});

describe("the email source", () => {
  const arrival = (over: Partial<Parameters<typeof recordArrival>[0]> = {}) =>
    recordArrival({
      channel: "watcher:gmail",
      externalId: `msg-${Math.random().toString(36).slice(2)}`,
      title: "Re: renewal terms",
      senderName: "Dana Whitman",
      senderAddress: "dana@example.com",
      snippet: "procurement will sign off at $47 per seat",
      disposition: "surfaced",
      decidedBy: "model",
      ...over,
    });

  test("finds mail by subject, body or sender", async () => {
    arrival();
    for (const q of ["renewal terms", "$47", "Dana Whitman"]) {
      const { evidence } = await searchEmailSource(q, context, 5);
      expect(evidence.length).toBeGreaterThan(0);
    }
  });

  test("names the sender in the title, so a citation can be weighed", async () => {
    arrival();
    const { evidence } = await searchEmailSource("renewal terms", context, 5);
    expect(evidence[0]?.title).toContain("Dana Whitman");
  });

  test("mail Cue FILED is still searchable", async () => {
    // "Filed" was a decision about interrupting you, never about deleting.
    arrival({
      title: "Your Stripe receipt",
      snippet: "payment for the tooling invoice",
      disposition: "filed",
      reason: "automated receipt",
    });

    const { evidence } = await searchEmailSource("tooling invoice", context, 5);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.metadata?.disposition).toBe("filed");
  });
});

describe("the work source", () => {
  const item = (title: string, status = "queued") => {
    const task = createTask({ title, template: title });
    const created = createWorkItem({ taskId: task.id, title });
    if (status !== "queued") {
      getDb().run(
        `UPDATE work_items SET status = '${status}' WHERE id = '${created.id}'`,
      );
    }
    return created;
  };

  test("finds work by its title", async () => {
    item("Send the SOC 2 report to Dana");
    const { evidence } = await searchWorkSource("soc 2 report", context, 5);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.source).toBe("work");
  });

  test("says what state it is in, in the owner's words", async () => {
    item("Send the SOC 2 report", "awaiting_review");
    const { evidence } = await searchWorkSource("soc 2 report", context, 5);
    // "awaiting_review" is a fact about our schema; "waiting for you" is a
    // fact about their day, and the citation has to carry the second.
    expect(evidence[0]?.excerpt).toContain("waiting for you");
  });

  test("DONE work is found too — 'did we ever send that?' needs it", async () => {
    // A source that only saw the queue would answer "no" to a question whose
    // real answer is "yes, last Tuesday".
    item("Send the SOC 2 report", "done");
    const { evidence } = await searchWorkSource("soc 2 report", context, 5);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.metadata?.status).toBe("done");
  });
});
