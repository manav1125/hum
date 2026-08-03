/**
 * The Library's model — the four claims the frames make about it.
 *
 * These are the assertions worth having, because each one is a place the
 * surface could quietly start lying:
 *
 *  · the sheet opened from a thing LEADS with that thing's files (F1's whole
 *    reason to exist — if the partition drifts, the sheet is just a gallery);
 *  · the count line never prints a leg it cannot back ("0 this week");
 *  · a chip is only offered when something sits behind it;
 *  · "who made it" reads a real field and null reads as Cue, per the daemon's
 *    own description of `agent`.
 */
import { describe, expect, test } from "bun:test";

import {
  agentLabel,
  availableFilters,
  cardMeta,
  countThisWeek,
  filterEntries,
  filterOf,
  groupByRecency,
  madeLine,
  partitionByThing,
  type LibraryEntry,
} from "./library-model";

const NOW = Date.UTC(2026, 7, 3, 12, 0, 0);
const DAY = 86_400_000;

function entry(over: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id: "o1",
    workItemId: "w1",
    missionId: null,
    projectId: null,
    attachmentId: null,
    externalUrl: null,
    kind: "document",
    title: "One-pager",
    why: null,
    agent: null,
    reviewState: "approved",
    createdAt: NOW - DAY,
    attachment: null,
    ...over,
  } as LibraryEntry;
}

describe("kind → chip", () => {
  test("the frame's four chips exist and PDFs read as Docs", () => {
    expect(filterOf("document")).toBe("Docs");
    expect(filterOf("pdf")).toBe("Docs");
    expect(filterOf("deck")).toBe("Decks");
    expect(filterOf("spreadsheet")).toBe("Sheets");
    expect(filterOf("image")).toBe("Images");
  });

  test("a chip is only offered when something is behind it", () => {
    const entries = [entry({ kind: "deck" }), entry({ id: "o2", kind: "image" })];
    expect(availableFilters(entries)).toEqual(["All", "Decks", "Images"]);
    // Nothing to filter → no chip row at all.
    expect(availableFilters([])).toEqual(["All"]);
  });

  test("filtering keeps only the picked kind, All keeps everything", () => {
    const entries = [entry({ kind: "deck" }), entry({ id: "o2", kind: "image" })];
    expect(filterEntries(entries, "Decks").map((e) => e.id)).toEqual(["o1"]);
    expect(filterEntries(entries, "All")).toHaveLength(2);
  });
});

describe("the sheet leads with the current thing's files", () => {
  const entries = [
    entry({ id: "a", projectId: "acme" }),
    entry({ id: "b", projectId: "seed" }),
    entry({ id: "c", projectId: "acme" }),
    entry({ id: "d", projectId: null }),
  ];

  test("opened FROM a thing, that thing's files come first — and nothing is dropped", () => {
    const { fromThing, rest } = partitionByThing(entries, "acme");
    expect(fromThing.map((e) => e.id)).toEqual(["a", "c"]);
    expect(rest.map((e) => e.id)).toEqual(["b", "d"]);
    // The dismiss loses nothing precisely because the split is a view, not a
    // filter: both halves together are still the whole library.
    expect(fromThing.length + rest.length).toBe(entries.length);
  });

  test("opened from nowhere (the composer's ▦) there is no lead section", () => {
    const { fromThing, rest } = partitionByThing(entries, null);
    expect(fromThing).toHaveLength(0);
    expect(rest).toHaveLength(4);
  });

  test("a thing with nothing made for it gets no empty lead heading", () => {
    const { fromThing } = partitionByThing(entries, "unknown-thing");
    expect(fromThing).toHaveLength(0);
  });
});

describe("the header line is never a fake number", () => {
  test("counts what it was handed, and drops the week leg at zero", () => {
    const old = [
      entry({ id: "a", createdAt: NOW - 30 * DAY }),
      entry({ id: "b", createdAt: NOW - 40 * DAY }),
    ];
    expect(countThisWeek(old, NOW)).toBe(0);
    expect(madeLine(old, NOW)).toBe("2 things Cue made");
  });

  test("the week leg appears only when something actually landed", () => {
    const mixed = [
      entry({ id: "a", createdAt: NOW - DAY }),
      entry({ id: "b", createdAt: NOW - 40 * DAY }),
    ];
    expect(madeLine(mixed, NOW)).toBe("2 things Cue made · 1 this week");
  });

  test("one thing is singular", () => {
    expect(madeLine([entry()], NOW)).toBe("1 thing Cue made · 1 this week");
  });
});

describe("grouping", () => {
  test("empty sections are omitted rather than rendered as a heading", () => {
    const recent = [entry({ createdAt: NOW - DAY })];
    expect(groupByRecency(recent, NOW).map((g) => g.key)).toEqual([
      "THIS WEEK",
    ]);
    const old = [entry({ createdAt: NOW - 40 * DAY })];
    expect(groupByRecency(old, NOW).map((g) => g.key)).toEqual(["EARLIER"]);
    expect(groupByRecency([], NOW)).toEqual([]);
  });
});

describe("every card is backed by a real field", () => {
  test("null agent reads as Cue — the daemon says so, we do not invent one", () => {
    expect(agentLabel(null)).toBe("Cue");
    expect(agentLabel("cue")).toBe("Cue");
    expect(agentLabel("you")).toBe("You");
    expect(agentLabel("Growth")).toBe("Growth");
  });

  test("the card carries the agent AND the thing", () => {
    expect(cardMeta(entry({ agent: "Growth" }), "Renew Acme")).toBe(
      "◆ Growth · Renew Acme",
    );
  });

  test("an unfiled output says nothing rather than inventing a thing", () => {
    expect(cardMeta(entry({ agent: null }), null)).toBe("◆ Cue");
  });
});
