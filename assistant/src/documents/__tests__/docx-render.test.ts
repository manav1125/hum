/**
 * The promise this exporter makes is that the .docx is *editable* — a client
 * opens it in Word and redlines it. That promise fails silently: a file with no
 * heading styles, a table with no column grid, or a hyperlink whose text got
 * dropped all open perfectly well and only look wrong. So these assertions read
 * the actual OOXML out of the package rather than trusting the builder.
 */

import { describe, expect, test } from "bun:test";

import JSZip from "jszip";

import { renderMarkdownToDocx } from "../docx-render.js";

const MARKDOWN = `# Proposal

A proposal for **Acme Trading LLC** with *emphasis* and \`code\`.

## Pricing

- first bullet
- second bullet
  - nested bullet

1. step one
2. step two

| Item | Qty | Total |
| --- | ---: | ---: |
| Implementation | 1 | $12,000.00 |
| Seats | 25 | $12,000.00 |

> Prices exclude VAT.

Contact [Manav Gupta](mailto:manav@brinc.io).

---
`;

async function documentXml(markdown: string, opts = {}): Promise<string> {
  const buffer = await renderMarkdownToDocx(markdown, opts);
  const zip = await JSZip.loadAsync(buffer);
  return zip.file("word/document.xml")!.async("string");
}

describe("renderMarkdownToDocx", () => {
  test("produces a readable OOXML package, not an opaque blob", async () => {
    const buffer = await renderMarkdownToDocx(MARKDOWN);
    // A .docx is a zip: `PK\x03\x04`. Anything else means Word shows an error.
    expect(buffer.subarray(0, 4).toString("binary")).toBe("PK");

    const zip = await JSZip.loadAsync(buffer);
    for (const entry of [
      "[Content_Types].xml",
      "word/document.xml",
      "word/styles.xml",
      "word/numbering.xml",
    ]) {
      expect(zip.file(entry)).not.toBeNull();
    }
  });

  test("refuses empty content rather than emitting a blank file", () => {
    expect(renderMarkdownToDocx("   ")).rejects.toThrow(/empty/i);
  });

  test("maps headings onto Word's built-in styles", async () => {
    const xml = await documentXml(MARKDOWN);
    // Built-in styles are what make the navigation pane and the client's own
    // template work; a bold run that merely looks like a heading does neither.
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toContain('<w:pStyle w:val="Heading2"/>');
  });

  test("carries bold, italic and code through as character runs", async () => {
    const xml = await documentXml(MARKDOWN);
    expect(xml).toMatch(/<w:b\/>[\s\S]{0,200}Acme Trading LLC/);
    expect(xml).toMatch(/<w:i\/>[\s\S]{0,200}emphasis/);
    expect(xml).toMatch(/Consolas[\s\S]{0,300}>code</);
  });

  test("numbers ordered lists and bullets unordered ones", async () => {
    const buffer = await renderMarkdownToDocx(MARKDOWN);
    const zip = await JSZip.loadAsync(buffer);
    const numbering = await zip.file("word/numbering.xml")!.async("string");
    // Both must exist: an ordered list rendered as bullets loses the sequence
    // the author was relying on.
    expect(numbering).toContain('<w:numFmt w:val="decimal"/>');
    expect(numbering).toContain('<w:numFmt w:val="bullet"/>');

    const xml = await documentXml(MARKDOWN);
    // Nesting survives as an indent level rather than being flattened.
    expect(xml).toContain('<w:ilvl w:val="1"/>');
  });

  test("writes a real column grid so the table isn't squeezed to hairlines", async () => {
    const xml = await documentXml(MARKDOWN);
    const grid = xml.match(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/)?.[0] ?? "";
    const widths = [...grid.matchAll(/w:w="(\d+)"/g)].map((m) => Number(m[1]));

    expect(widths).toHaveLength(3);
    // OOXML's default gridCol is 100 twips (~0.07"). Shipping that is the
    // failure this test exists for.
    for (const width of widths) expect(width).toBeGreaterThan(1000);
    // The row fills the text column exactly (A4 less 1" margins).
    expect(widths.reduce((a, b) => a + b, 0)).toBe(9026);
  });

  test("sets a wide table smaller rather than breaking its numbers", async () => {
    // Opening the export in Word is what caught this: at 11pt these ten
    // columns cannot all hold their values, and the grid Word honours laid
    // `$1,450.00` out as `$1,450.0` above `0`. A wrapped sentence is fine; a
    // wrapped number is a different number, so the type gives way instead.
    const wide = `| Workstream | Owner | Start | End | Effort | Rate | Budget | Spent | Remaining | Status |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Discovery and stakeholder alignment | R. Vance | 2026-01-05 | 2026-02-13 | 120 | $1,450.00 | $174000 | $166750 | $7250 | On track |
| Cutover | M. Duarte | 2026-07-01 | 2026-07-31 | 60 | $1,600.00 | $96000 | $0 | $96000 | Not started |
`;
    const xml = await documentXml(wide);
    const grid = xml.match(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/)?.[0] ?? "";
    const widths = [...grid.matchAll(/w:w="(\d+)"/g)].map((m) => Number(m[1]));
    expect(widths).toHaveLength(10);
    expect(widths.reduce((a, b) => a + b, 0)).toBe(9026);

    // The runs inside the table carry an explicit size below the 22 half-point
    // body default; without it the columns above cannot hold their values.
    const sizes = [...xml.matchAll(/<w:sz w:val="(\d+)"\/>/g)].map((m) =>
      Number(m[1]),
    );
    const tableSize = Math.min(...sizes);
    expect(tableSize).toBeLessThan(22);
    expect(tableSize).toBeGreaterThanOrEqual(12);

    // Every column can hold its longest unbreakable run at that size.
    const charWidth = (tableSize / 2) * 0.56 * 20;
    const padding = 2 * Math.round(100 * (tableSize / 2 / 11));
    const longest = [10, 6, 10, 6, 6, 9, 7, 7, 9, 7];
    widths.forEach((width, i) => {
      expect(width - padding).toBeGreaterThanOrEqual(longest[i]! * charWidth);
    });
  });

  test("leaves a table that already fits at the document's body size", async () => {
    const xml = await documentXml(MARKDOWN);
    const table = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/)?.[0] ?? "";
    expect(table).not.toContain("<w:sz ");
  });

  test("keeps the markdown column alignment on the table cells", async () => {
    const xml = await documentXml(MARKDOWN);
    expect(xml).toContain('<w:jc w:val="right"/>');
  });

  test("keeps hyperlink text, and registers the target as a relationship", async () => {
    const buffer = await renderMarkdownToDocx(MARKDOWN);
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    const rels = await zip
      .file("word/_rels/document.xml.rels")!
      .async("string");

    // The link's visible text is the part that goes missing when runs are
    // rebuilt rather than reused.
    expect(xml).toMatch(/<w:hyperlink[\s\S]{0,400}Manav Gupta/);
    expect(rels).toContain("mailto:manav@brinc.io");
    expect(rels).toContain('TargetMode="External"');
  });

  test("leaves a relative link as plain text rather than a dead link", async () => {
    const xml = await documentXml("See [the docs](../guide.md).");
    expect(xml).toContain("the docs");
    expect(xml).not.toContain("<w:hyperlink");
  });

  test("adds the title only when the content doesn't already open with one", async () => {
    const withOwnH1 = await documentXml(MARKDOWN, { title: "Proposal" });
    expect(withOwnH1.match(/>Proposal</g)).toHaveLength(1);

    const withoutH1 = await documentXml("Just a paragraph.", {
      title: "Proposal",
    });
    expect(withoutH1).toContain('<w:pStyle w:val="Title"/>');
    expect(withoutH1).toContain(">Proposal<");
  });

  test("names an image it cannot embed instead of dropping it", async () => {
    // The renderer has no network, so a remote image can't be fetched — but a
    // silently missing figure is worse than a labelled gap.
    const xml = await documentXml("![Org chart](https://example.com/a.png)");
    expect(xml).toContain("[image: Org chart]");
  });

  test("decodes the entities marked leaves escaped for HTML output", async () => {
    const xml = await documentXml("Terms & conditions for <Acme>.");
    // The characters land as characters — XML-escaped in the package, but not
    // as the literal text `&amp;` the reader would otherwise see in Word.
    // marked splits this into three inline tokens, so assert per run.
    expect(xml).toContain(">Terms &amp; conditions for <");
    expect(xml).toContain(">&lt;Acme&gt;<");
  });
});
