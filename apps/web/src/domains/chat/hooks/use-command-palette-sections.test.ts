import { describe, expect, test } from "bun:test";

import type { GlobalSearchResponse } from "@/domains/chat/api/global-search";

import {
  buildServerResultSections,
  emptyResultsMessage,
  PALETTE_SEARCH_CATEGORIES,
  searchNoticeFor,
} from "@/domains/chat/hooks/command-palette-utils";

const searchResults: GlobalSearchResponse = {
  conversations: [
    {
      id: "c1",
      title: "Alpha",
      updatedAt: 1,
      excerpt: "snippet-a",
      matchCount: 1,
    },
    {
      id: "c2",
      title: "Beta",
      updatedAt: 2,
      excerpt: "snippet-b",
      matchCount: 1,
    },
    {
      id: "c3",
      title: null,
      updatedAt: 3,
      excerpt: "snippet-c",
      matchCount: 1,
    },
  ],
  memories: [],
  schedules: [
    {
      id: "s1",
      name: "Daily Digest",
      expression: "0 9 * * *",
      message: "Send the daily digest",
      enabled: true,
      nextRunAt: null,
    },
  ],
  contacts: [
    {
      id: "ct1",
      displayName: "Alice",
      notes: "VIP customer",
      lastInteraction: 100,
    },
    { id: "ct2", displayName: "Bob", notes: null, lastInteraction: null },
  ],
};

describe("buildServerResultSections", () => {
  test("builds all three section types from server results", () => {
    const sections = buildServerResultSections(searchResults, new Set());
    expect(sections).toHaveLength(3);
    expect(sections[0]!.id).toBe("search-conversations");
    expect(sections[0]!.items).toHaveLength(3);
    expect(sections[1]!.id).toBe("search-schedules");
    expect(sections[1]!.items).toHaveLength(1);
    expect(sections[2]!.id).toBe("search-contacts");
    expect(sections[2]!.items).toHaveLength(2);
  });

  test("deduplicates conversations already in local recents", () => {
    const recentKeys = new Set(["c1", "c3"]);
    const sections = buildServerResultSections(searchResults, recentKeys);
    const convSection = sections.find((s) => s.id === "search-conversations");
    expect(convSection!.items).toHaveLength(1);
    expect(convSection!.items[0]!.id).toBe("search-conv-c2");
  });

  test("omits empty sections entirely", () => {
    const emptyResults: GlobalSearchResponse = {
      conversations: [],
      memories: [],
      schedules: [],
      contacts: [
        {
          id: "ct1",
          displayName: "Solo",
          notes: "solo note",
          lastInteraction: null,
        },
      ],
    };
    const sections = buildServerResultSections(emptyResults, new Set());
    expect(sections).toHaveLength(1);
    expect(sections[0]!.id).toBe("search-contacts");
  });

  test("uses 'Untitled' for null conversation titles", () => {
    const sections = buildServerResultSections(searchResults, new Set());
    const convSection = sections.find((s) => s.id === "search-conversations")!;
    const nullTitleItem = convSection.items.find(
      (i) => i.id === "search-conv-c3",
    );
    expect(nullTitleItem!.title).toBe("Untitled");
  });

  test("uses contact display name as title and notes as subtitle", () => {
    const sections = buildServerResultSections(searchResults, new Set());
    const contactSection = sections.find((s) => s.id === "search-contacts")!;
    expect(contactSection.items[0]!.title).toBe("Alice");
    expect(contactSection.items[0]!.subtitle).toBe("VIP customer");
    expect(contactSection.items[1]!.subtitle).toBeUndefined();
  });

  test("returns empty array when all results are empty", () => {
    const emptyResults: GlobalSearchResponse = {
      conversations: [],
      memories: [],
      schedules: [],
      contacts: [],
    };
    const sections = buildServerResultSections(emptyResults, new Set());
    expect(sections).toHaveLength(0);
  });

  test("drops conversations section when all are duplicates", () => {
    const allDuplicates = new Set(["c1", "c2", "c3"]);
    const sections = buildServerResultSections(searchResults, allDuplicates);
    expect(
      sections.find((s) => s.id === "search-conversations"),
    ).toBeUndefined();
    expect(sections).toHaveLength(2);
  });
});

describe("searchNoticeFor — red is reserved for Cue's own failure", () => {
  test("an error is the loud one, verbatim", () => {
    expect(
      searchNoticeFor({
        status: "error",
        query: "acme",
        message: "I couldn't reach my search index (500). Nothing was searched.",
        httpStatus: 500,
      }),
    ).toEqual({
      tone: "error",
      message: "I couldn't reach my search index (500). Nothing was searched.",
    });
  });

  test("not-connected-yet explains without alarming", () => {
    const notice = searchNoticeFor({
      status: "unavailable",
      query: "acme",
      message: "I'm not connected to your Cue yet, so I can't search.",
    });
    expect(notice?.tone).toBe("muted");
  });

  test("a real answer and a superseded keystroke say nothing", () => {
    expect(
      searchNoticeFor({
        status: "ok",
        query: "acme",
        results: {
          conversations: [],
          memories: [],
          schedules: [],
          contacts: [],
        },
      }),
    ).toBeNull();
    expect(searchNoticeFor({ status: "cancelled", query: "acme" })).toBeNull();
    expect(searchNoticeFor(null)).toBeNull();
  });
});

describe("emptyResultsMessage — an empty list still says why", () => {
  const base = { isSearching: false, minQueryLength: 2 };

  test("a genuine no-match names what was actually searched", () => {
    const msg = emptyResultsMessage({
      ...base,
      query: "zzz",
      outcome: {
        status: "ok",
        query: "zzz",
        results: {
          conversations: [],
          memories: [],
          schedules: [],
          contacts: [],
        },
      },
    });
    expect(msg).toBe(
      "Nothing matched “zzz”. I searched your conversations, schedules and people.",
    );
  });

  test("a failure gets NO empty-state line — the alert speaks for it", () => {
    // This is the regression guard: "nothing matched" underneath "I couldn't
    // reach my search index" would put the lie back on the screen.
    expect(
      emptyResultsMessage({
        ...base,
        query: "acme",
        outcome: {
          status: "error",
          query: "acme",
          message: "I couldn't reach my search index. Nothing was searched.",
        },
      }),
    ).toBeNull();
    expect(
      emptyResultsMessage({
        ...base,
        query: "acme",
        outcome: {
          status: "unavailable",
          query: "acme",
          message: "I'm not connected to your Cue yet, so I can't search.",
        },
      }),
    ).toBeNull();
  });

  test("a query too short to reach the server says that, not 'no results'", () => {
    const msg = emptyResultsMessage({ ...base, query: "a", outcome: null });
    expect(msg).toContain("Type 2 characters");
  });

  test("an in-flight search says it is in flight", () => {
    expect(
      emptyResultsMessage({
        ...base,
        isSearching: true,
        query: "acme",
        outcome: null,
      }),
    ).toBe("Searching…");
  });

  test("the palette asks for exactly the categories it can render", () => {
    // No memory row exists in buildServerResultSections, so memories are not
    // requested — and the sentence above must not claim they were searched.
    expect([...PALETTE_SEARCH_CATEGORIES]).toEqual([
      "conversations",
      "schedules",
      "contacts",
    ]);
  });
});
