/**
 * Artifact → conversation provenance resolution.
 *
 * The Library link is only allowed to exist when the originating thread does.
 * These tests pin the "prove it or omit it" contract: a live thread resolves
 * (title included, `null` when untitled), a deleted one resolves to nothing.
 */
import { describe, expect, test } from "bun:test";

import { initializeDb } from "../../../memory/db-init.js";
import { rawRun } from "../../../memory/raw-query.js";
import {
  resolveExistingConversations,
  resolveSourceConversation,
} from "../artifact-provenance.js";

initializeDb();

function seedConversation(id: string, title: string | null): void {
  const now = Date.now();
  rawRun(
    /*sql*/ `INSERT OR REPLACE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    id,
    title,
    now,
    now,
  );
}

describe("resolveSourceConversation", () => {
  test("resolves a thread that still exists", () => {
    seedConversation("prov-conv-live", "Q3 planning");
    expect(resolveSourceConversation("prov-conv-live")).toEqual({
      id: "prov-conv-live",
      title: "Q3 planning",
    });
  });

  test("reports an untitled thread as a null title, not as missing", () => {
    seedConversation("prov-conv-untitled", null);
    expect(resolveSourceConversation("prov-conv-untitled")).toEqual({
      id: "prov-conv-untitled",
      title: null,
    });
  });

  test("returns undefined for a thread that no longer exists", () => {
    // A stored conversation id is not proof the thread survived — the caller
    // must render no link rather than one that opens nothing.
    expect(resolveSourceConversation("prov-conv-deleted")).toBeUndefined();
  });

  test("returns undefined for a missing or empty id", () => {
    expect(resolveSourceConversation(undefined)).toBeUndefined();
    expect(resolveSourceConversation(null)).toBeUndefined();
    expect(resolveSourceConversation("")).toBeUndefined();
  });
});

describe("resolveExistingConversations", () => {
  test("returns only the ids that survived", () => {
    seedConversation("prov-batch-a", "Alpha");
    seedConversation("prov-batch-b", "Beta");

    const resolved = resolveExistingConversations([
      "prov-batch-a",
      "prov-batch-b",
      "prov-batch-gone",
      // duplicates and blanks must not throw or inflate the query
      "prov-batch-a",
      "",
    ]);

    expect([...resolved.keys()].sort()).toEqual([
      "prov-batch-a",
      "prov-batch-b",
    ]);
    expect(resolved.get("prov-batch-a")?.title).toBe("Alpha");
  });

  test("returns an empty map for no input", () => {
    expect(resolveExistingConversations([]).size).toBe(0);
  });
});
