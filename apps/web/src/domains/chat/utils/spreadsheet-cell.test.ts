import { describe, expect, test } from "bun:test";

import { coerceCell } from "@/domains/chat/utils/spreadsheet-cell";

describe("coerceCell — the honesty boundary", () => {
  test("a formula WITH a cached result shows the formatted value", () => {
    const cell = coerceCell({ formula: "B2*12", result: 12000 }, "$#,##0", false);
    expect(cell.kind).toBe("value");
    expect(cell.text).toBe("$12,000");
    expect(cell.align).toBe("right");
  });

  test("a formula WITHOUT a cached result shows the formula, never a number", () => {
    const cell = coerceCell({ formula: "B2*12" }, "$#,##0", false);
    expect(cell.kind).toBe("formula-uncached");
    expect(cell.text).toBe("=B2*12");
    // Crucially, it is NOT presented as a computed value.
    expect(cell.text).not.toMatch(/\$|\d,\d/);
  });

  test("a result of 0 is a real value, not treated as missing", () => {
    const cell = coerceCell({ formula: "A1-A2", result: 0 }, "#,##0", false);
    expect(cell.kind).toBe("value");
    expect(cell.text).toBe("0");
  });

  test("an Excel error result is surfaced as the error string", () => {
    const cell = coerceCell(
      { formula: "A1/A2", result: { error: "#DIV/0!" } },
      undefined,
      false,
    );
    expect(cell.kind).toBe("value");
    expect(cell.text).toBe("#DIV/0!");
  });

  test("plain numbers, strings, booleans, and blanks", () => {
    expect(coerceCell(1234.5, "#,##0.00", false)).toMatchObject({
      kind: "value",
      text: "1,234.50",
      align: "right",
    });
    expect(coerceCell("Revenue", undefined, true)).toMatchObject({
      kind: "value",
      text: "Revenue",
      align: "left",
      bold: true,
    });
    expect(coerceCell(true, undefined, false)).toMatchObject({
      text: "TRUE",
      align: "right",
    });
    expect(coerceCell(null, undefined, false).kind).toBe("empty");
    expect(coerceCell("", undefined, false).kind).toBe("empty");
  });

  test("rich text and hyperlink cells flatten to their text", () => {
    expect(
      coerceCell({ richText: [{ text: "Net " }, { text: "MRR" }] }, undefined, false)
        .text,
    ).toBe("Net MRR");
    expect(
      coerceCell({ text: "cue.ai", hyperlink: "https://cue.ai" }, undefined, false)
        .text,
    ).toBe("cue.ai");
  });
});
