import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SpreadsheetPreviewSurface } from "@/domains/chat/components/surfaces/spreadsheet-preview-surface";
import type { Surface } from "@/domains/chat/types/types";

function surface(overrides: Partial<Surface["data"]> = {}): Surface {
  return {
    surfaceId: "sheet-att-1",
    surfaceType: "spreadsheet_preview",
    title: "saas-model.xlsx",
    data: {
      filename: "saas-model.xlsx",
      attachmentId: "att-1",
      sheets: [
        { name: "Assumptions", rows: 8, formulaCells: 0 },
        { name: "Monthly", rows: 20, formulaCells: 180 },
        { name: "Annual", rows: 10, formulaCells: 90 },
      ],
      totalFormulaCells: 270,
      ...overrides,
    },
  };
}

describe("SpreadsheetPreviewSurface", () => {
  test("renders the filename and sheet/formula metadata", () => {
    const html = renderToStaticMarkup(
      <SpreadsheetPreviewSurface
        surface={surface()}
        onAction={() => undefined}
        onOpenSpreadsheet={() => undefined}
      />,
    );
    expect(html).toContain("saas-model.xlsx");
    expect(html).toContain("3 sheets");
    expect(html).toContain("270 formulas");
  });

  test("is a button when an open handler is provided", () => {
    const html = renderToStaticMarkup(
      <SpreadsheetPreviewSurface
        surface={surface()}
        onAction={() => undefined}
        onOpenSpreadsheet={() => undefined}
      />,
    );
    expect(html).toContain('role="button"');
  });

  test("is still a button without the open handler — it falls back to the viewer store", () => {
    // `onOpenSpreadsheet` used to be required for the card to be clickable.
    // On the live render path that prop was null, so clicking an .xlsx opened
    // a Download modal instead of the native grid; the card now opens the
    // viewer through the store and treats the prop as an optional fast path.
    // What matters is that having an attachment is what makes it openable.
    const html = renderToStaticMarkup(
      <SpreadsheetPreviewSurface
        surface={surface()}
        onAction={() => undefined}
      />,
    );
    expect(html).toContain('role="button"');
  });

  test("is not clickable without an attachment id", () => {
    // Nothing to open — the card must not present a button affordance it
    // cannot honour.
    const noAttachment = renderToStaticMarkup(
      <SpreadsheetPreviewSurface
        surface={surface({ attachmentId: "" })}
        onAction={() => undefined}
        onOpenSpreadsheet={() => undefined}
      />,
    );
    expect(noAttachment).not.toContain('role="button"');
    expect(noAttachment).not.toContain("cursor-pointer");
  });

  test("singularizes a single sheet / single formula", () => {
    const html = renderToStaticMarkup(
      <SpreadsheetPreviewSurface
        surface={surface({
          sheets: [{ name: "Sheet1", rows: 3, formulaCells: 1 }],
          totalFormulaCells: 1,
        })}
        onAction={() => undefined}
        onOpenSpreadsheet={() => undefined}
      />,
    );
    expect(html).toContain("1 sheet");
    expect(html).not.toContain("1 sheets");
    expect(html).toContain("1 formula");
    expect(html).not.toContain("1 formulas");
  });
});
