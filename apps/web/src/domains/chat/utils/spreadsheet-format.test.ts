import { describe, expect, test } from "bun:test";

import { formatCellNumber } from "@/domains/chat/utils/spreadsheet-format";

describe("formatCellNumber", () => {
  test("currency formats", () => {
    expect(formatCellNumber(12000, "$#,##0")).toBe("$12,000");
    expect(formatCellNumber(1234.5, "$#,##0.00")).toBe("$1,234.50");
    expect(formatCellNumber(-500, "$#,##0")).toBe("-$500");
  });

  test("percent formats scale by 100 and append %", () => {
    expect(formatCellNumber(0.08, "0.0%")).toBe("8.0%");
    expect(formatCellNumber(0.125, "0%")).toBe("13%"); // rounds
  });

  test("thousands and plain decimals", () => {
    expect(formatCellNumber(1234567, "#,##0")).toBe("1,234,567");
    expect(formatCellNumber(3.14159, "0.00")).toBe("3.14");
  });

  test("General / missing format falls back to a clean locale string", () => {
    expect(formatCellNumber(1000, undefined)).toBe("1,000");
    expect(formatCellNumber(1000, "General")).toBe("1,000");
    expect(formatCellNumber(2.5, undefined)).toBe("2.5");
  });

  test("non-finite guard", () => {
    expect(formatCellNumber(Number.POSITIVE_INFINITY, "$#,##0")).toBe(
      "Infinity",
    );
  });
});
