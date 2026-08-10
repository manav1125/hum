/**
 * Search results are prose or they are nothing.
 *
 * Every fixture below is the shape of a real ⌘K row from production. The index
 * matches against stored message content, which is not prose — it holds HTML
 * fragments, serialized tool-call payloads, workspace file paths and literal
 * escape sequences — and the palette rendered all of it verbatim. Rows began
 * mid-string with an ellipsis, none carried a title, and two were identical.
 *
 * The assertions are deliberately about what a reader sees: no angle brackets,
 * no backslash-n, no JSON keys. A test that only checked "a subtitle exists"
 * would have passed on the broken version, since the broken version had
 * subtitles — they were just unreadable.
 */

import { describe, expect, test } from "bun:test";

import { cleanExcerpt, isUnreadableExcerpt } from "./command-palette-utils";

describe("cleanExcerpt", () => {
  test("strips HTML the index stored as content", () => {
    const raw = '<span class="thread-name">5 Cold-Surface Items</span>';
    expect(cleanExcerpt(raw)).toBe("5 Cold-Surface Items");
  });

  test("resolves literal escape sequences rather than printing them", () => {
    // These arrive as the two characters backslash + n, not as newlines.
    expect(cleanExcerpt("first\\nsecond")).toBe("first second");
    expect(cleanExcerpt('he said \\"go\\"')).toBe('he said "go"');
  });

  test("collapses the whitespace left behind by stripping tags", () => {
    expect(cleanExcerpt("<b>a</b>   <i>b</i>")).toBe("a b");
  });

  test("decodes the entities that survive round-tripping", () => {
    expect(cleanExcerpt("Tom &amp; Jerry")).toBe("Tom & Jerry");
  });

  test("empty in, empty out", () => {
    expect(cleanExcerpt(null)).toBe("");
    expect(cleanExcerpt(undefined)).toBe("");
    expect(cleanExcerpt("   ")).toBe("");
  });

  test("ordinary prose is left alone", () => {
    const prose = "Manav replied to Camy at 02:12 last night.";
    expect(cleanExcerpt(prose)).toBe(prose);
  });
});

describe("isUnreadableExcerpt — structure, not language", () => {
  test.each([
    '{"queries":[{"use_case":"search and fetch emails"}]}',
    '[{"id":1}]',
    "objects/hk-lp-trip-jul-2026.md",
    "concepts/gmail-auth.md",
    "",
  ])("%s is not shown to a reader", (text) => {
    expect(isUnreadableExcerpt(text)).toBe(true);
  });

  test.each([
    "Manav replied to Camy at 02:12 last night.",
    "NetBanking unlocks in about 11 minutes.",
    "5 Cold-Surface Items",
  ])("%s is readable", (text) => {
    expect(isUnreadableExcerpt(text)).toBe(false);
  });

  test("a cleaned JSON payload is still rejected", () => {
    // The two functions compose: cleaning does not make a payload prose.
    const raw = '\\"created\\":\\"2023-01-09T06:50:59.000Z\\",\\"creator\\":{}';
    expect(isUnreadableExcerpt(cleanExcerpt(raw))).toBe(true);
  });
});
