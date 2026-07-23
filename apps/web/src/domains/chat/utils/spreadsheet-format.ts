/**
 * Render a numeric cell value using an Excel number-format string.
 *
 * This is a focused formatter for the format vocabulary Spreadsheet Studio
 * emits — currency (`$#,##0`, `$#,##0.00`), percent (`0.0%`), thousands
 * (`#,##0`), and plain decimals (`0.00`). It is presentation only: the
 * underlying value is always the real number, so an imperfect format never
 * misrepresents the value — at worst the grouping or decimal count differs from
 * Excel's. Unknown/absent formats fall back to a sensible locale string.
 */
export function formatCellNumber(value: number, fmt: string | undefined): string {
  if (!Number.isFinite(value)) return String(value);
  if (!fmt || fmt === "General") {
    // Avoid scientific notation for ordinary magnitudes; keep integers clean.
    return Number.isInteger(value)
      ? value.toLocaleString("en-US")
      : value.toLocaleString("en-US", { maximumFractionDigits: 10 });
  }

  const isPercent = fmt.includes("%");
  const currencyMatch = fmt.match(/[$£€¥]/);
  const useGrouping = fmt.includes(",");

  // Decimal places: count the 0/# placeholders after the first '.'
  let decimals = 0;
  const dot = fmt.indexOf(".");
  if (dot !== -1) {
    const after = fmt.slice(dot + 1);
    const m = after.match(/[0#]+/);
    decimals = m ? m[0].length : 0;
  }

  const scaled = isPercent ? value * 100 : value;
  const magnitude = Math.abs(scaled);

  let body = magnitude.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping,
  });

  if (currencyMatch) {
    body = currencyMatch[0] + body;
  }
  if (isPercent) {
    body = body + "%";
  }

  return scaled < 0 ? `-${body}` : body;
}
