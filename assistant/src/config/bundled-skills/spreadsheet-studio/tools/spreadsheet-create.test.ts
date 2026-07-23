import { describe, expect, test } from "bun:test";

import ExcelJS from "exceljs";

import type { ToolContext } from "../../../../tools/types.js";
import { buildWorkbook, parseSheets, run } from "./spreadsheet-create.js";

const ctx = { conversationId: "test", workingDir: "/tmp" } as ToolContext;

describe("buildWorkbook", () => {
  test("round-trips formulas, headers, and number formats", async () => {
    const { buffer, sheetSummaries, formulaCells } = await buildWorkbook([
      {
        name: "Assumptions",
        rows: [
          ["Driver", "Value"],
          ["Starting MRR", 10000],
          ["Growth rate", 0.1],
        ],
        header: true,
      },
      {
        name: "Model",
        rows: [
          ["Metric", "M1", "M2"],
          ["MRR", "=Assumptions!B2", "=B2*(1+Assumptions!B3)"],
          ["Total", "=SUM(B2:C2)", null],
        ],
        header: true,
        column_widths: [20, 12, 12],
        number_formats: { B: "$#,##0" },
      },
    ]);

    expect(formulaCells).toBe(3);
    expect(sheetSummaries[1]).toEqual({
      name: "Model",
      rows: 3,
      formulaCells: 3,
    });

    // Read the workbook back and assert formulas survived AS formulas.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const model = wb.getWorksheet("Model")!;
    const mrrCell = model.getRow(2).getCell(2).value as { formula?: string };
    expect(mrrCell?.formula).toBe("Assumptions!B2");
    expect(model.getRow(1).getCell(1).font?.bold).toBe(true);
    expect(model.getColumn("B").numFmt).toBe("$#,##0");
    expect(model.getColumn(1).width).toBe(20);
  });

  test("caches computed results so the file carries real numbers", async () => {
    const { buffer } = await buildWorkbook([
      {
        name: "Assumptions",
        rows: [
          ["Driver", "Value"],
          ["Starting MRR", 10000],
          ["Growth rate", 0.1],
        ],
        header: true,
      },
      {
        name: "Model",
        rows: [
          ["Metric", "M1", "M2"],
          ["MRR", "=Assumptions!B2", "=B2*(1+Assumptions!B3)"],
          ["Total", "=SUM(B2:C2)", null],
        ],
        header: true,
      },
    ]);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const model = wb.getWorksheet("Model")!;
    // The formula cell now carries BOTH the formula and its cached result, so a
    // viewer with no spreadsheet engine can show a real number.
    const mrr = model.getRow(2).getCell(2).value as {
      formula?: string;
      result?: number;
    };
    expect(mrr.formula).toBe("Assumptions!B2");
    expect(mrr.result).toBe(10000);
    const m2 = model.getRow(2).getCell(3).value as { result?: number };
    expect(m2.result).toBeCloseTo(11000, 6); // 10000 * 1.1
    const total = model.getRow(3).getCell(2).value as { result?: number };
    expect(total.result).toBeCloseTo(21000, 6); // 10000 + 11000
  });
});

describe("spreadsheet_create input validation", () => {
  test("rejects missing filename and malformed sheets", async () => {
    const noFile = await run({ sheets: [{ name: "A", rows: [[1]] }] }, ctx);
    expect(noFile.isError).toBe(true);

    const noRows = await run({ filename: "x", sheets: [{ name: "A" }] }, ctx);
    expect(noRows.isError).toBe(true);
    expect(noRows.content).toContain("rows");

    const badRow = await run(
      { filename: "x", sheets: [{ name: "A", rows: ["not-an-array"] }] },
      ctx,
    );
    expect(badRow.isError).toBe(true);
  });
});

describe("per-cell number format survives column format", () => {
  // The live bug: a percent margin row inside a column that also has a
  // "$#,##0" column format rendered as "$1" because the column-level numFmt
  // pass clobbered the per-cell "0.0%". Column formats must be applied before
  // per-cell writes so the per-cell format wins.
  test("a per-cell percent format is not clobbered by a column currency format", async () => {
    const { buffer } = await buildWorkbook([
      {
        name: "Model",
        rows: [
          ["Metric", "M1"],
          ["Revenue", 52500],
          [{ value: "Gross Margin %", bold: false }, { value: 0.9, format: "0.0%" }],
        ],
        header: true,
        number_formats: { B: "$#,##0" },
      },
    ]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet("Model")!;
    // The margin cell keeps its percent format...
    expect(ws.getRow(3).getCell(2).numFmt).toBe("0.0%");
    // ...while a plain currency cell in the same column keeps the column format.
    expect(ws.getRow(2).getCell(2).numFmt).toBe("$#,##0");
  });

  test("a CELL-reference number_formats key (B4) is honored over its column", async () => {
    // The exact live payload: the model formats one percent cell via a cell
    // key ("B4") inside a currency column ("B"). Previously "B4" was dropped
    // and B4 inherited "$#,##0" → "$1". It must now render as a percent.
    const { buffer } = await buildWorkbook([
      {
        name: "Sheet1",
        rows: [
          ["Item", "Amount"],
          ["Revenue", 100000],
          ["Costs", 40000],
          ["Gross Margin %", "=(B2-B3)/B2"],
        ],
        header: true,
        number_formats: { B: "$#,##0", B4: "0.0%" },
      },
    ]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet("Sheet1")!;
    expect(ws.getCell("B4").numFmt).toBe("0.0%"); // percent, not "$#,##0"
    expect(ws.getCell("B2").numFmt).toBe("$#,##0"); // revenue still currency
  });
});

describe("provider-stringified arguments", () => {
  // Open-weight brains over OpenRouter routinely serialize nested tool args as
  // JSON strings. The live failure this guards: `sheets` arrived as a string,
  // the tool answered "sheets must be an array", and the model fell back to
  // hand-building the workbook via bash. The tool must parse the string.
  test("accepts `sheets` passed as a JSON string", () => {
    const parsed = parseSheets(
      JSON.stringify([
        { name: "Budget", rows: [["Item", "Cost"], ["Rent", 1000]] },
      ]),
    );
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as { name: string }[])[0].name).toBe("Budget");
  });

  test("accepts a sheet's `rows` passed as a JSON string", () => {
    const parsed = parseSheets([
      { name: "Budget", rows: JSON.stringify([["Item", "Cost"], ["Rent", 1000]]) },
    ]);
    expect(Array.isArray(parsed)).toBe(true);
    const rows = (parsed as { rows: unknown[][] }[])[0].rows;
    expect(rows.length).toBe(2);
    expect(rows[0][0]).toBe("Item");
  });

  test("the exact live payload — a whole workbook as one JSON string — builds", async () => {
    // Byte-for-byte the shape that failed in prod: sheets serialized to a
    // string by the brain. It must parse AND produce a real workbook.
    const parsed = parseSheets(
      JSON.stringify([
        {
          name: "Weekly Budget",
          rows: [
            ["Category", "Amount"],
            ["Rent", 1500],
            ["Food", 400],
            ["Transport", 200],
            ["Total", "=SUM(B2:B4)"],
          ],
        },
      ]),
    );
    expect(Array.isArray(parsed)).toBe(true);
    const { formulaCells } = await buildWorkbook(parsed as Parameters<typeof buildWorkbook>[0]);
    expect(formulaCells).toBe(1);
  });

  test("still rejects genuinely malformed sheets, not silently", () => {
    expect(typeof parseSheets("not json at all")).toBe("string");
    expect(typeof parseSheets("[]")).toBe("string"); // empty array
  });
});

describe("rich cells", () => {
  test("unwraps {value, format, bold} — formulas stay live", async () => {
    const { buffer, formulaCells } = await buildWorkbook([
      {
        name: "R",
        rows: [
          [
            { value: "Total", bold: true },
            { value: "=SUM(B2:B3)", format: "$#,##0" },
          ],
          ["a", 1],
          ["b", 2],
        ],
        header: false,
      },
    ]);
    expect(formulaCells).toBe(1);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet("R")!;
    const totalCell = ws.getRow(1).getCell(2);
    expect((totalCell.value as { formula?: string })?.formula).toBe(
      "SUM(B2:B3)",
    );
    expect(totalCell.numFmt).toBe("$#,##0");
    expect(ws.getRow(1).getCell(1).font?.bold).toBe(true);
  });
});
