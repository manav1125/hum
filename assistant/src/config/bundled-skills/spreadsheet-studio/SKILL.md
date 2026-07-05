---
name: spreadsheet-studio
description: Use whenever the user wants a spreadsheet, Excel file, financial model, budget, forecast, P&L, cap table, pricing model, expense report, or any tabular deliverable as a FILE (.xlsx). Builds real workbooks with LIVE formulas — change an assumption and everything recalculates — delivered as an in-chat attachment. Not for interactive trackers (app-builder) or tables displayed in chat (markdown).
compatibility: "Designed for Cue personal assistants"
metadata:
  emoji: "📊"
  vellum:
    display-name: "Spreadsheet Studio"
    category: "content"
    activation-hints:
      - "User asks for a spreadsheet, Excel file, .xlsx, financial model, budget, P&L, forecast, cap table, pricing model, or expense report"
      - "User wants numbers they can edit/tweak with formulas that recalculate — a model, not a snapshot"
    avoid-when:
      - "User wants an interactive tracker/dashboard they'll use inside Cue — use app-builder instead"
      - "A table shown in chat is enough — just render markdown"
---

Build real .xlsx workbooks with `spreadsheet_create`. One rule towers over everything:

## Formulas, never precomputed values

Any cell derivable from other cells MUST be a live formula (a string starting with `=`): `"=B2*C2"`, `"=SUM(D2:D13)"`, `"=Assumptions!B4"`. Hardcoding a computed number is a failed build — the user must be able to change an assumption and watch the model recalculate. If you find yourself computing a value in your head, write the formula instead.

## Financial-model methodology

1. **Sheet 1 = `Assumptions`.** Every driver as a labeled input cell (starting MRR, growth %, churn %, CAC, price, headcount cost, …). Two columns: label, value. This is the only sheet with typed-in numbers.
2. **Calculation sheets reference assumptions by cell** — `"=Assumptions!B4"` — never repeat the number.
3. **Time across columns**: monthly columns for operating models (B..M for months 1–12), annual for multi-year projections. Growth via explicit rate cells: `"=B5*(1+Assumptions!B3)"`.
4. **Totals via ranges** (`"=SUM(B10:M10)"`), and add sanity-check rows (gross margin %, MRR net change) so errors show themselves.
5. **Formats**: currency `"$#,##0"` (or `"$#,##0.00"`), percents `"0.0%"`, sensible `column_widths` (first label column ~26). Header rows are bolded + frozen automatically.

## Recipes

- **SaaS model**: Assumptions → Monthly sheet (New MRR, Churned MRR `"=-B6*Assumptions!B4"`, Net MRR, Revenue, CAC spend, Opex, EBITDA) → Annual summary referencing the monthly sheet.
- **Budget**: Categories down, months across, `"=SUM(...)"` row + column totals, Variance column `"=C4-B4"` vs plan.
- **Cap table**: Holders down; shares, `"=B4/SUM($B$4:$B$12)"` ownership %, per-round columns; post-money math via formulas.

## Honoring a design contract (Create Studio)

When the request is prefixed with a **`DESIGN CONTRACT`** or **`BRAND`** block (compiled by Create Studio, above a `---` divider), apply what a workbook can carry — the model recalcs first, the look second, but a branded model reads far better:

- **Palette** — use the brand/template primary and accent hexes for header-row fills and section labels (where `spreadsheet_create` supports cell fill/font color); keep body cells legible (dark text on light).
- **Fonts** — set the workbook font to the brand's body font if a font option is available; otherwise skip silently (don't hardcode a font into a formula).
- **Naming / voice** — use the exact brand name in the title, sheet names, and any labels; keep header wording in the brand's tone.

Never let styling compromise the formulas rule below — a correct, recalculating model in brand colors, not a static colored snapshot. Absent any such block, use the clean default formatting.

## Anti-patterns

- Don't emit CSV into chat or paste giant markdown tables when a FILE was requested — call the tool.
- Don't precompute values a formula should compute (the rule above).
- Don't build an interactive calculator here — that's app-builder.
