import { describe, expect, test } from "bun:test";

import ExcelJS from "exceljs";

import type { ToolContext } from "../../../../tools/types.js";
import { buildWorkbook, run } from "./spreadsheet-create.js";

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
