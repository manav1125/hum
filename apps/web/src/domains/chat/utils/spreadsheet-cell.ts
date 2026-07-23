/**
 * Pure cell-coercion for the spreadsheet viewer.
 *
 * Turns an ExcelJS `cell.value` (a tagged union) plus its effective number
 * format into a display cell. This is the honesty boundary of the viewer, so
 * it lives in its own tested module:
 *
 *   • A formula cell WITH a cached result → that result, formatted.
 *   • A formula cell WITHOUT a cached result → the FORMULA TEXT, marked
 *     `formula-uncached`, never a blank or a fabricated number.
 *   • An Excel error result (#DIV/0! etc.) → the error string, shown as-is.
 *
 * The caller styles `formula-uncached` cells distinctly and never presents them
 * as computed values.
 */

import { formatCellNumber } from "@/domains/chat/utils/spreadsheet-format";

export interface CellView {
  text: string;
  kind: "value" | "formula-uncached" | "empty";
  bold: boolean;
  align: "left" | "right";
}

export function coerceScalar(
  value: unknown,
  numFmt: string | undefined,
  bold: boolean,
): CellView {
  if (typeof value === "number") {
    return {
      text: formatCellNumber(value, numFmt),
      kind: "value",
      bold,
      align: "right",
    };
  }
  if (typeof value === "boolean") {
    return {
      text: value ? "TRUE" : "FALSE",
      kind: "value",
      bold,
      align: "right",
    };
  }
  if (value instanceof Date) {
    return {
      text: value.toLocaleDateString(),
      kind: "value",
      bold,
      align: "right",
    };
  }
  return { text: String(value), kind: "value", bold, align: "left" };
}

/** ExcelJS cell.value is a tagged union; coerce it to a display cell. */
export function coerceCell(
  rawValue: unknown,
  numFmt: string | undefined,
  bold: boolean,
): CellView {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return { text: "", kind: "empty", bold, align: "left" };
  }

  if (typeof rawValue === "object") {
    const obj = rawValue as Record<string, unknown>;
    // Formula cell: { formula, result? } or { sharedFormula, result? }
    if ("formula" in obj || "sharedFormula" in obj) {
      const formula = (obj.formula ?? obj.sharedFormula) as string;
      if ("result" in obj && obj.result !== undefined && obj.result !== null) {
        const result = obj.result;
        if (typeof result === "object" && "error" in (result as object)) {
          return {
            text: String((result as { error: unknown }).error),
            kind: "value",
            bold,
            align: "left",
          };
        }
        return coerceScalar(result, numFmt, bold);
      }
      // No cached value — show the formula honestly, never a fake number.
      return {
        text: `=${formula}`,
        kind: "formula-uncached",
        bold,
        align: "left",
      };
    }
    if ("richText" in obj && Array.isArray(obj.richText)) {
      const text = (obj.richText as Array<{ text?: string }>)
        .map((r) => r.text ?? "")
        .join("");
      return { text, kind: "value", bold, align: "left" };
    }
    if ("text" in obj) {
      return { text: String(obj.text), kind: "value", bold, align: "left" };
    }
    if ("error" in obj) {
      return { text: String(obj.error), kind: "value", bold, align: "left" };
    }
  }

  return coerceScalar(rawValue, numFmt, bold);
}
