/**
 * A conversation belongs to a thing — or it doesn't, and then we say nothing.
 */

import { describe, expect, test } from "bun:test";

import { unanimousProjectId } from "@/domains/chat/partner/use-conversation-thing";

describe("unanimousProjectId", () => {
  test("one thing is the thing", () => {
    expect(unanimousProjectId([{ projectId: "p1" }, { projectId: "p1" }])).toBe(
      "p1",
    );
  });

  test("unfiled work is not disagreement", () => {
    expect(unanimousProjectId([{ projectId: "p1" }, { projectId: null }])).toBe(
      "p1",
    );
  });

  test("two different things is genuine ambiguity — pick neither", () => {
    expect(
      unanimousProjectId([{ projectId: "p1" }, { projectId: "p2" }]),
    ).toBeNull();
  });

  test("a thread that started nothing belongs to nothing", () => {
    expect(unanimousProjectId([])).toBeNull();
    expect(unanimousProjectId([{ projectId: null }])).toBeNull();
  });
});
