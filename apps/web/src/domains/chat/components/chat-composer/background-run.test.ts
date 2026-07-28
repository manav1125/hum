/**
 * Tests for the composer's background-run helpers.
 *
 * Both are pure, and both guard user data:
 *   - `stripBackgroundCommand` decides whether a message leaves the thread at
 *     all. A false positive would silently divert an ordinary chat message
 *     into an autonomous run, so the match is anchored and must not fire on a
 *     mid-sentence mention.
 *   - `deriveWorkItemTitle` only ever produces the item's LABEL; the full text
 *     is sent separately as the run instruction. These assertions pin the
 *     eliding so a long message never yields a title that misrepresents it.
 */

import { describe, expect, test } from "bun:test";

import { stripBackgroundCommand } from "@/domains/chat/components/chat-composer/slash-command-catalog";
import { deriveWorkItemTitle } from "@/domains/chat/components/chat-composer/use-background-run";

describe("stripBackgroundCommand", () => {
  test("returns the task text after /background", () => {
    expect(stripBackgroundCommand("/background draft the Q3 recap")).toBe(
      "draft the Q3 recap",
    );
  });

  test("/later is an alias", () => {
    expect(stripBackgroundCommand("/later chase the invoice")).toBe(
      "chase the invoice",
    );
  });

  test("is case-insensitive", () => {
    expect(stripBackgroundCommand("/Background do it")).toBe("do it");
  });

  test("tolerates leading whitespace and multiple spaces", () => {
    expect(stripBackgroundCommand("  /background    do it")).toBe("do it");
  });

  test("keeps multi-line bodies intact", () => {
    expect(stripBackgroundCommand("/background line one\nline two")).toBe(
      "line one\nline two",
    );
  });

  test("a bare command yields an empty task, not null", () => {
    expect(stripBackgroundCommand("/background")).toBe("");
    expect(stripBackgroundCommand("/later  ")).toBe("");
  });

  test("returns null for ordinary messages", () => {
    expect(stripBackgroundCommand("what is the status?")).toBeNull();
    expect(stripBackgroundCommand("")).toBeNull();
  });

  test("does not fire on a mid-sentence mention", () => {
    expect(stripBackgroundCommand("run it with /background please")).toBeNull();
  });

  test("does not fire on a longer command that merely starts the same", () => {
    expect(stripBackgroundCommand("/backgrounds")).toBeNull();
    expect(stripBackgroundCommand("/laterally")).toBeNull();
  });
});

describe("deriveWorkItemTitle", () => {
  test("short single-line text is used verbatim", () => {
    expect(deriveWorkItemTitle("Draft the Q3 recap")).toBe(
      "Draft the Q3 recap",
    );
  });

  test("uses the first non-blank line of a multi-line message", () => {
    expect(deriveWorkItemTitle("\n\nFirst line\nSecond line")).toBe(
      "First line",
    );
  });

  test("collapses internal whitespace", () => {
    expect(deriveWorkItemTitle("Draft   the    recap")).toBe("Draft the recap");
  });

  test("elides long text on a word boundary", () => {
    const long = `${"word ".repeat(40)}end`;
    const title = deriveWorkItemTitle(long);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(73);
    // Never cuts mid-word.
    expect(title.slice(0, -1).trimEnd().endsWith("word")).toBe(true);
  });

  test("elides a single unbroken token by hard cut", () => {
    const title = deriveWorkItemTitle("x".repeat(200));
    expect(title).toBe(`${"x".repeat(72)}…`);
  });
});
