/**
 * The whole value of an xlsx export over a PDF is that the cells are numbers
 * the client can re-total. A currency column that arrives as text looks
 * identical in the grid and silently breaks every formula written against it,
 * so the coercion rules are what these tests actually guard — including the
 * cases that must NOT be coerced, because a wrong number is worse than a
 * string.
 */

import { describe, expect, test } from "bun:test";

import ExcelJS from "exceljs";

import {
  coerceCell,
  displayText,
  extractTables,
  renderMarkdownTablesToXlsx,
} from "../xlsx-render.js";

const MARKDOWN = `# Proposal

Intro prose with no table in it.

## Pricing

| Item | Qty | Unit | Total |
| --- | ---: | ---: | ---: |
| Implementation | 1 | $12,000.00 | $12,000.00 |
| Seats (annual) | 25 | $480.00 | $12,000.00 |

## Timeline

| Phase | Duration | Effort |
| --- | --- | ---: |
| Discovery | 2 weeks | 35% |
| Build | 6 weeks | 50% |
`;

async function readBack(markdown: string): Promise<ExcelJS.Workbook> {
  const { bytes } = await renderMarkdownTablesToXlsx(markdown);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  return workbook;
}

describe("extractTables", () => {
  test("finds every table and tags it with the heading above it", () => {
    const tables = extractTables(MARKDOWN);
    expect(tables.map((t) => t.heading)).toEqual(["Pricing", "Timeline"]);
    expect(tables[0].header).toEqual(["Item", "Qty", "Unit", "Total"]);
    expect(tables[0].rows).toHaveLength(2);
  });

  test("strips inline markdown so a cell reads as a value", () => {
    const [table] = extractTables(
      "| A | B |\n| --- | --- |\n| **Total** | [link](http://x.co) |",
    );
    expect(table.rows[0]).toEqual(["Total", "link"]);
  });

  test("keeps punctuation that only looks like markup", () => {
    // Found by opening the file: stripping `*_~` by regex rewrote the data.
    // `SKU_ALPHA_01` arrived as `SKUALPHA01`, and — because the survivors were
    // then all digits — `~5000` became the exact number 5000 and `5*3` became
    // 53. marked already knows which of these characters are markup.
    const [table] = extractTables(
      "| SKU | Approx | Ratio | Under | Struck |\n" +
        "| --- | --- | --- | --- | --- |\n" +
        "| SKU_ALPHA_01 | ~5000 | 5*3 | 1_000 | ~~gone~~ |",
    );
    expect(table.rows[0]).toEqual([
      "SKU_ALPHA_01",
      "~5000",
      "5*3",
      "1_000",
      "gone",
    ]);
  });

  test("reaches tables nested inside blockquotes and list items", () => {
    const nested = extractTables(
      "> | A |\n> | --- |\n> | 1 |\n\n- item\n\n  | B |\n  | --- |\n  | 2 |\n",
    );
    expect(nested).toHaveLength(2);
  });
});

describe("coerceCell", () => {
  test("turns money into a number carrying its currency format", () => {
    expect(coerceCell("$12,000.00")).toEqual({
      value: 12000,
      numFmt: '"$"#,##0.00',
    });
    expect(coerceCell("£450")).toEqual({ value: 450, numFmt: '"£"#,##0.00' });
  });

  test("turns a percentage into Excel's fraction representation", () => {
    // 35% must be 0.35 with a percent format, not 35 — otherwise every
    // downstream formula is out by a factor of 100.
    expect(coerceCell("35%")).toEqual({ value: 0.35, numFmt: "0.0%" });
  });

  test("reads accounting parentheses as a negative", () => {
    expect(coerceCell("($1,200.00)").value).toBe(-1200);
  });

  test("reads a parenthesised percentage as a negative fraction", () => {
    // The parentheses used to be stripped along with the `%`, so `(20%)`
    // landed as -20 — the same factor-of-100 error the plain case guards.
    expect(coerceCell("(20%)")).toEqual({ value: -0.2, numFmt: "0.0%" });
  });

  test("refuses a value whose leading zero is part of its meaning", () => {
    // A SKU, a cost centre, a postcode. `007` stored as 7 is a different SKU.
    for (const text of ["007", "00421", "01772", "0800"]) {
      expect(coerceCell(text)).toEqual({ value: text });
    }
    // A leading zero before a decimal point is just a number.
    expect(coerceCell("0.5").value).toBe(0.5);
    expect(coerceCell("0").value).toBe(0);
  });

  test("refuses a digit run longer than a float64 can hold exactly", () => {
    // Excel keeps 15 significant digits; a 20-digit account number would come
    // back rounded, which is a different account.
    expect(coerceCell("12345678901234567890").value).toBe(
      "12345678901234567890",
    );
    expect(coerceCell("123456789012345").value).toBe(123456789012345);
  });

  test("does not invent decimals the source never had", () => {
    expect(coerceCell("12,500")).toEqual({ value: 12500, numFmt: "#,##0" });
    expect(coerceCell("12,500.75")).toEqual({
      value: 12500.75,
      numFmt: "#,##0.00",
    });
  });

  test("an empty cell is blank, not an empty string", () => {
    // `""` is a text cell that looks blank: ISBLANK and COUNTBLANK disagree
    // with the reader's eyes, and a chart plots it as a category.
    expect(coerceCell("  ")).toEqual({ value: null });
  });

  test("leaves an approximation or a range alone", () => {
    for (const text of ["~5000", "5*3", "2~3", "1_000"]) {
      expect(coerceCell(text)).toEqual({ value: text });
    }
  });

  test("leaves anything that isn't wholly a number as text", () => {
    // The dangerous direction: a half-parsed cell would show a plausible but
    // wrong figure.
    for (const text of [
      "2-3 weeks",
      "N/A",
      "TBD",
      "Support (20%)",
      "Q1 2026",
    ]) {
      expect(coerceCell(text)).toEqual({ value: text });
    }
  });
});

describe("displayText", () => {
  test("reports what Excel draws, not what the markdown said", () => {
    // Column width is measured against this. `$120000` is 7 characters of
    // source and 11 of rendered money, and a numeric cell that does not fit
    // its column is not clipped — Excel replaces it with `####`.
    expect(displayText(coerceCell("$120000"))).toBe("$120,000.00");
    expect(displayText(coerceCell("35%"))).toBe("35.0%");
    expect(displayText(coerceCell("($15,000.00)"))).toBe("-$15,000.00");
    expect(displayText(coerceCell("12,500"))).toBe("12,500");
    expect(displayText(coerceCell("1250000"))).toBe("1250000");
    expect(displayText(coerceCell("N/A"))).toBe("N/A");
    expect(displayText(coerceCell(""))).toBe("");
  });
});

describe("renderMarkdownTablesToXlsx", () => {
  test("refuses rather than shipping an empty workbook", () => {
    expect(
      renderMarkdownTablesToXlsx("# Just prose\n\nNo tables."),
    ).rejects.toThrow(/No tables found/);
  });

  test("writes one sheet per table, named from its heading", async () => {
    const workbook = await readBack(MARKDOWN);
    expect(workbook.worksheets.map((w) => w.name)).toEqual([
      "Pricing",
      "Timeline",
    ]);
  });

  test("lands numeric cells as numbers, not as text", async () => {
    const workbook = await readBack(MARKDOWN);
    const sheet = workbook.getWorksheet("Pricing")!;

    expect(sheet.getCell("B2").value).toBe(1);
    expect(sheet.getCell("D2").value).toBe(12000);
    expect(sheet.getCell("D2").numFmt).toBe('"$"#,##0.00');
    // The label column stays text.
    expect(sheet.getCell("A2").value).toBe("Implementation");
    // Percentages arrive as fractions.
    expect(workbook.getWorksheet("Timeline")!.getCell("C2").value).toBe(0.35);
  });

  test("freezes the header row so it stays visible while scrolling", async () => {
    const sheet = (await readBack(MARKDOWN)).getWorksheet("Pricing")!;
    expect(sheet.views[0]?.state).toBe("frozen");
    expect((sheet.views[0] as { ySplit?: number }).ySplit).toBe(1);
  });

  test("gives every column a width the content actually fits in", async () => {
    const sheet = (await readBack(MARKDOWN)).getWorksheet("Pricing")!;
    for (const column of sheet.columns) {
      expect(column.width).toBeGreaterThanOrEqual(10);
      expect(column.width).toBeLessThanOrEqual(60);
    }
  });

  test("de-duplicates sheet names and keeps them inside Excel's 31 chars", async () => {
    const workbook = await readBack(
      "## Rates\n\n| A |\n| --- |\n| 1 |\n\n## Rates\n\n| B |\n| --- |\n| 2 |\n",
    );
    const names = workbook.worksheets.map((w) => w.name);
    expect(new Set(names).size).toBe(2);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(31);
  });
});
