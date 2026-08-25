/**
 * The rule this module exists to enforce: **real text, or an honest error —
 * never bytes.**
 *
 * The mutation checks guard the exact failure that cost a real session 39
 * minutes: a PDF coming back as `%PDF-1.7` and object dictionaries, which reads
 * like content, so nothing downstream can tell the read failed.
 *
 * The documents here are built at test time rather than mocked. A mock would
 * prove the dispatch works while leaving the actual question — can this daemon
 * turn a PDF into text — untested, which is precisely how the gap survived.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  describeBinaryContent,
  DOCUMENT_EXTENSIONS,
  readDocumentFile,
} from "./document-read.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "doc-read-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A real, minimal, byte-correct PDF containing `text`. Offsets for the xref
 * table are computed as the body is assembled, so the file is genuinely
 * parseable rather than approximately so.
 */
function buildPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    out += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("a PDF becomes text", () => {
  test("MUTATION CHECK: the text comes back, and the bytes never do", async () => {
    // If this regresses, `file_read` is once again handing the model
    // `%PDF-1.7` and object dictionaries dressed up as document content.
    const d = tmp();
    const p = join(d, "terms.pdf");
    writeFileSync(p, buildPdf("Deposit term adjustment clause"));

    const r = await readDocumentFile(p);
    expect(r.isError).toBe(false);
    expect(String(r.content)).toContain("Deposit term adjustment");
    expect(String(r.content)).not.toContain("%PDF-");
    expect(String(r.content)).not.toContain("/Type /Catalog");
  });

  test("page structure is preserved so citations can point somewhere", async () => {
    const d = tmp();
    const p = join(d, "one.pdf");
    writeFileSync(p, buildPdf("Clause 4.1"));
    const r = await readDocumentFile(p);
    expect(String(r.content)).toContain("Page 1");
  });
});

describe("a document that cannot be read says so", () => {
  test("MUTATION CHECK: a corrupt PDF errors, it does not return its bytes", async () => {
    // The dangerous regression is a silent fallback to "here is the file as
    // text" — the model would read the garbage as the contract's contents.
    const d = tmp();
    const p = join(d, "broken.pdf");
    writeFileSync(p, Buffer.from("%PDF-1.4\nnot actually a pdf at all"));

    const r = await readDocumentFile(p);
    expect(r.isError).toBe(true);
    expect(String(r.content)).not.toContain("not actually a pdf at all");
  });

  test("a text-free PDF points at reading it as an image", async () => {
    // The scanned-document case. Saying "no extractable text" names the real
    // next step; returning empty content would read as "the page is blank".
    const d = tmp();
    const p = join(d, "scan.pdf");
    writeFileSync(p, buildPdf(""));
    const r = await readDocumentFile(p);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/scanned|image/i);
  });

  test("a missing file errors cleanly", async () => {
    const r = await readDocumentFile(join(tmp(), "nope.pdf"));
    expect(r.isError).toBe(true);
  });
});

describe("spreadsheets and word documents", () => {
  test("an xlsx comes back as rows with its sheet name", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Scans");
    sheet.addRow(["Date", "Weight"]);
    sheet.addRow(["Jun 6", 121.3]);
    const d = tmp();
    const p = join(d, "b.xlsx");
    writeFileSync(p, Buffer.from(await wb.xlsx.writeBuffer()));

    const r = await readDocumentFile(p);
    expect(r.isError).toBe(false);
    expect(String(r.content)).toContain("Scans");
    expect(String(r.content)).toContain("121.3");
    // Columnar meaning must survive — tab-separated, not flattened to prose.
    expect(String(r.content)).toContain("Jun 6\t121.3");
  });

  test("a docx comes back as its paragraphs", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      `<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Lien Letter</w:t></w:r></w:p><w:p><w:r><w:t>Second clause</w:t></w:r></w:p></w:body></w:document>`,
    );
    const d = tmp();
    const p = join(d, "c.docx");
    writeFileSync(p, await zip.generateAsync({ type: "nodebuffer" }));

    const r = await readDocumentFile(p);
    expect(r.isError).toBe(false);
    expect(String(r.content)).toContain("Lien Letter");
    // Paragraph breaks become newlines rather than running together.
    expect(String(r.content)).toContain("\nSecond clause");
    expect(String(r.content)).not.toContain("<w:t>");
  });

  test("the supported set is exactly what the dispatch advertises", () => {
    expect([...DOCUMENT_EXTENSIONS].sort()).toEqual([".docx", ".pdf", ".xlsx"]);
  });
});

describe("binary content is refused, text is not", () => {
  test("MUTATION CHECK: recognisable binary is named, not returned", () => {
    // This is the backstop for formats with no extractor. Returning bytes here
    // reintroduces the original bug for every unhandled binary.
    expect(describeBinaryContent("     1  %PDF-1.7 garbage")).toBe("PDF");
    expect(describeBinaryContent("     1  PK\x03\x04 stuff")).toContain("ZIP");
    expect(describeBinaryContent("  1  \x89PNG\r\n")).toContain("PNG");
    expect(describeBinaryContent(`a${String.fromCharCode(0)}b`)).toBe(
      "binary data",
    );
  });

  test("MUTATION CHECK: ordinary text is never refused", () => {
    // Over-refusing is its own outage: every source file, log and note would
    // stop being readable.
    expect(describeBinaryContent("     1  const x = 1;")).toBeNull();
    expect(
      describeBinaryContent("plain prose about a PDF document"),
    ).toBeNull();
    expect(describeBinaryContent("")).toBeNull();
    expect(describeBinaryContent("# Heading\n\nSome markdown.")).toBeNull();
  });
});
