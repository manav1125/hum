/**
 * Tests for the DSML/DeepSeek wire-text sanitizer.
 *
 * The fixture shapes mirror real leaked rows sampled read-only from prod
 * (assistant.db, DeepSeek-era conversations) with synthetic values:
 *
 *   1. Complete native span inside a thinking block:
 *      `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>skill_load<｜tool▁sep｜>{...}<｜tool▁call▁end｜><｜tool▁calls▁end｜>`
 *   2. Bare separator block as the entire text:
 *      `function<｜tool▁sep｜>skill_load\n```json\n{...}\n````
 *   3. Unterminated call span mid-prose, args in a fenced block, prose
 *      resuming immediately after the closing fence.
 *   4. DSML XML-style runaway: `<｜DSML｜tool_calls>` + invoke/parameter
 *      tags, truncated with broken nesting and no closing tag.
 */

import { describe, expect, test } from "bun:test";

import {
  containsDsmlMarkup,
  sanitizeAssistantWireText,
} from "./wire-text-sanitizer.js";

describe("containsDsmlMarkup", () => {
  test("false for plain prose", () => {
    expect(containsDsmlMarkup("Just a normal assistant reply.")).toBe(false);
  });

  test("false for prose containing an ASCII pipe", () => {
    expect(containsDsmlMarkup("a | b | c")).toBe(false);
  });

  test("false for prose containing a lone fullwidth bar", () => {
    expect(containsDsmlMarkup("日本語｜テスト")).toBe(false);
  });

  test("true for DeepSeek native markers", () => {
    expect(containsDsmlMarkup("<｜tool▁calls▁begin｜>")).toBe(true);
    expect(containsDsmlMarkup("x<｜tool▁sep｜>y")).toBe(true);
  });

  test("true for DSML XML markers", () => {
    expect(containsDsmlMarkup('<｜DSML｜invoke name="bash">')).toBe(true);
  });
});

describe("sanitizeAssistantWireText", () => {
  test("returns marker-free text unchanged", () => {
    const text = 'Here is your app.\n\n```json\n{"a": 1}\n```\nDone.';
    expect(sanitizeAssistantWireText(text)).toBe(text);
  });

  test("strips a complete native tool-call span (sampled shape 1)", () => {
    const text =
      "I'll build you a calm mood tracker app. Let me create this using the app-builder skill." +
      "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>skill_load<｜tool▁sep｜>" +
      '{"skill": "app-builder", "activity": "Loading app builder"}' +
      "<｜tool▁call▁end｜><｜tool▁calls▁end｜>";
    expect(sanitizeAssistantWireText(text)).toBe(
      "I'll build you a calm mood tracker app. Let me create this using the app-builder skill.[tool call]",
    );
  });

  test("strips a lone call span without the calls wrapper", () => {
    const text =
      "Before.<｜tool▁call▁begin｜>app_open<｜tool▁sep｜>" +
      '{"app_id": "abc"}<｜tool▁call▁end｜>After.';
    expect(sanitizeAssistantWireText(text)).toBe("Before.[tool call]After.");
  });

  test("strips a bare separator block that is the entire text (sampled shape 2)", () => {
    const text =
      "function<｜tool▁sep｜>skill_load\n" +
      "```json\n" +
      '{"skill": "app-builder", "activity": "Loading the App Builder skill"}\n' +
      "```";
    expect(sanitizeAssistantWireText(text)).toBe("[tool call]");
  });

  test("strips an unterminated call span through its closing fence, keeping trailing prose (sampled shape 3)", () => {
    const text =
      "Now I'll write the main App component.\n\n" +
      "<｜tool▁call▁begin｜>function<｜tool▁sep｜>app_open\n" +
      "```json\n" +
      '{"app_id": "01b6d050", "open_mode": "preview"}\n' +
      "```" +
      "Here's your color palette generator:\n\n- Generates 5 random colors";
    expect(sanitizeAssistantWireText(text)).toBe(
      "Now I'll write the main App component.\n\n" +
        "[tool call]Here's your color palette generator:\n\n- Generates 5 random colors",
    );
  });

  test("strips an unterminated call span with no fence to end of text", () => {
    const text = 'Working on it.<｜tool▁call▁begin｜>bash<｜tool▁sep｜>{"cmd":';
    expect(sanitizeAssistantWireText(text)).toBe("Working on it.[tool call]");
  });

  test("strips a truncated DSML XML runaway block (sampled shape 4)", () => {
    const text =
      "<｜DSML｜tool_calls>\n" +
      '<｜DSML｜invoke name="mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL">\n' +
      '<｜DSML｜parameter name="activity" string="true">Writing summary to sheet</｜DSML｜parameter>\n' +
      '<｜DSML｜parameter name="session_id" string="true">heartbeat-1</｜DSML｜parameter>\n' +
      '<｜DSML｜parameter name="tools" string="false">[{"arguments": {"spreadsheet_id": "abc"}}]</<｜DSML｜tool_calls>\n' +
      '<｜DSML｜invoke name="mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL">\n' +
      '<｜DSML｜parameter name="activity" string="true">Writing summ';
    expect(sanitizeAssistantWireText(text)).toBe("[tool call]");
  });

  test("strips a well-formed DSML XML block, keeping surrounding prose", () => {
    const text =
      "Writing the update now.\n" +
      "<｜DSML｜tool_calls>\n" +
      '<｜DSML｜invoke name="bash">\n' +
      '<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>\n' +
      "</｜DSML｜invoke>\n" +
      "</｜DSML｜tool_calls>\n" +
      "Done — the file list is above.";
    expect(sanitizeAssistantWireText(text)).toBe(
      "Writing the update now.\n[tool call]\nDone — the file list is above.",
    );
  });

  test("strips a stray DSML invoke block with no tool_calls wrapper", () => {
    const text =
      'Sure.\n<｜DSML｜invoke name="web_search">\n' +
      '<｜DSML｜parameter name="query" string="true">weather</｜DSML｜parameter>\n' +
      "</｜DSML｜invoke>";
    expect(sanitizeAssistantWireText(text)).toBe("Sure.\n[tool call]");
  });

  test("collapses adjacent stripped blocks into one placeholder", () => {
    const text =
      "Start." +
      "<｜tool▁calls▁begin｜>a<｜tool▁calls▁end｜>" +
      "<｜tool▁calls▁begin｜>b<｜tool▁calls▁end｜>" +
      "End.";
    expect(sanitizeAssistantWireText(text)).toBe("Start.[tool call]End.");
  });

  test("strips residual stray markers", () => {
    const text = "Left over<｜tool▁calls▁end｜> marker text.";
    expect(sanitizeAssistantWireText(text)).toBe(
      "Left over[tool call] marker text.",
    );
  });

  test("does not mangle legitimate fenced code after a stripped block", () => {
    const text =
      "function<｜tool▁sep｜>bash\n```json\n{}\n```\n\nHere is real code:\n```ts\nconst x = 1;\n```";
    expect(sanitizeAssistantWireText(text)).toBe(
      "[tool call]\n\nHere is real code:\n```ts\nconst x = 1;\n```",
    );
  });
});
