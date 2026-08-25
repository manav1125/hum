/**
 * Text extraction for the document formats people actually attach.
 *
 * ## Why this exists
 *
 * `file_read` used to treat every non-image, non-audio file as UTF-8 text. A
 * PDF therefore came back as `%PDF-1.7`, object dictionaries and binary — with
 * line numbers attached. That is worse than an error: it looks like content, so
 * the model cannot tell that the read failed, and it goes hunting for another
 * way to open the file. In one real session that hunt ran 39 minutes, ended in
 * a hand-written zlib stream decoder, and burned a string of approvals for
 * `bash` calls that only existed because reading a PDF was impossible.
 *
 * Every library used here was already a dependency of this package. The
 * capability was present in the running process the whole time; nothing was
 * wired to it.
 *
 * ## The rule this module enforces
 *
 * **Either real text, or an honest error. Never bytes.** Extraction failure
 * returns `isError` with a reason. It must never degrade into "here is the file
 * as text", because that is the exact failure being fixed.
 */

import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

import type { ToolExecutionResult } from "../../types.js";
import { boundOutput } from "../output-spill.js";

/** Extensions this module can turn into text. */
export const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx"]);

/**
 * Cap on extracted text handed back inline. Beyond this the text is spilled to
 * a file and a locator is returned, the same contract `bash` and MCP results
 * already use — a 300-page contract must not silently become the whole context
 * window.
 */
const MAX_DOCUMENT_CHARS = 60_000;

/** Refuse absurd inputs before allocating a buffer for them. */
const MAX_SOURCE_SIZE_BYTES = 100 * 1024 * 1024;

/**
 * Extract text from a PDF via `unpdf` — a serverless pdf.js build with no
 * native dependencies, so it works in the daemon container where there is no
 * pip, no poppler and no Python PDF library.
 */
async function extractPdf(buf: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(buf));
  const { text, totalPages } = await extractText(doc, { mergePages: false });
  const pages = Array.isArray(text) ? text : [String(text)];
  // Emptiness is decided on the page text alone, BEFORE the page headers are
  // added. Deciding it afterwards would make every scanned PDF look like it
  // had content — the header is text even when the page is not — and the
  // caller would report a blank page instead of "no extractable text".
  if (!pages.some((p) => p.trim())) return "";
  return pages
    .map((p, i) => `--- Page ${i + 1} of ${totalPages} ---\n${p.trim()}`)
    .join("\n\n");
}

/**
 * Extract text from a .docx.
 *
 * A .docx is a zip whose `word/document.xml` holds the body. Paragraph and
 * break tags become newlines before the remaining tags are dropped, so the
 * output keeps the document's line structure instead of collapsing into one
 * run-on paragraph.
 */
async function extractDocx(buf: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("no word/document.xml — not a Word document");
  const xml = await entry.async("string");
  return xml
    .replace(/<w:p\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:br\b[^>]*\/?>/g, "\n")
    .replace(/<w:tab\b[^>]*\/?>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract a .xlsx as TSV per sheet.
 *
 * Tab-separated rather than a prose rendering because a spreadsheet's meaning
 * is columnar — the model needs to see which values line up, and TSV survives
 * that where a flattened list does not.
 */
async function extractXlsx(buf: Buffer): Promise<string> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  // `as never`: exceljs types want its own Buffer flavour; the runtime accepts
  // a node Buffer directly.
  await wb.xlsx.load(buf as never);
  const out: string[] = [];
  wb.eachSheet((sheet) => {
    out.push(`--- Sheet: ${sheet.name} ---`);
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell.value;
        if (v == null) cells.push("");
        else if (typeof v === "object" && "result" in v) {
          // A formula cell: the computed value is what a reader cares about.
          cells.push(String((v as { result?: unknown }).result ?? ""));
        } else if (typeof v === "object" && "text" in v) {
          cells.push(String((v as { text?: unknown }).text ?? ""));
        } else cells.push(String(v));
      });
      out.push(cells.join("\t"));
    });
  });
  return out.join("\n").trim();
}

/**
 * Read a document as text.
 *
 * Returns `isError` — never bytes — when the file cannot be turned into text,
 * so a caller can tell "this document says nothing" from "I could not read
 * this document". Those are different facts and the model acts differently on
 * each.
 */
export async function readDocumentFile(
  resolvedPath: string,
): Promise<ToolExecutionResult> {
  const ext = extname(resolvedPath).toLowerCase();

  let size: number;
  try {
    size = statSync(resolvedPath).size;
  } catch (err) {
    return {
      content: `Error reading "${resolvedPath}": ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
  if (size > MAX_SOURCE_SIZE_BYTES) {
    return {
      content: `Error: "${resolvedPath}" is ${Math.round(size / 1024 / 1024)} MB, above the ${MAX_SOURCE_SIZE_BYTES / 1024 / 1024} MB document limit.`,
      isError: true,
    };
  }

  let text: string;
  try {
    const buf = readFileSync(resolvedPath);
    if (ext === ".pdf") text = await extractPdf(buf);
    else if (ext === ".docx") text = await extractDocx(buf);
    else if (ext === ".xlsx") text = await extractXlsx(buf);
    else {
      return {
        content: `Error: no text extractor for "${ext}" files.`,
        isError: true,
      };
    }
  } catch (err) {
    // Named as an extraction failure so the model does not read it as "the
    // document was empty" and proceed on that basis.
    return {
      content: `Error: could not extract text from "${resolvedPath}" (${ext}): ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  if (!text.trim()) {
    // A scanned PDF is the common case here. Saying so points at the real next
    // step instead of leaving the model to conclude the file is blank.
    return {
      content: `No extractable text in "${resolvedPath}". If this is a scanned or image-only document, read it as an image so it can be viewed directly.`,
      isError: true,
    };
  }

  const bounded = boundOutput(text, MAX_DOCUMENT_CHARS, "document");
  return { content: bounded.content, isError: false };
}

/**
 * Name the binary format of content that was read as text, or `null` when it
 * looks like ordinary text.
 *
 * The generic reader decodes bytes as UTF-8, so a binary file arrives here as
 * mojibake with a recognisable header. Detecting it lets `file_read` refuse
 * rather than hand back bytes dressed as content — the failure this whole
 * module exists to prevent, for the formats it does not itself handle.
 *
 * Deliberately conservative: it reports a format only on a known signature, or
 * on a NUL byte, which does not occur in text. Anything ambiguous is treated as
 * text, because wrongly refusing a real file is worse than passing odd text
 * through.
 */
export function describeBinaryContent(content: string): string | null {
  if (!content) return null;
  // The generic reader prefixes line numbers, so signatures sit a little way
  // in rather than at offset 0.
  const head = content.slice(0, 400);
  const signatures: [RegExp, string][] = [
    [/%PDF-/, "PDF"],
    [/\x89PNG/, "PNG image"],
    [/\xFF\xD8\xFF/, "JPEG image"],
    [/GIF8[79]a/, "GIF image"],
    [/PK\x03\x04/, "ZIP-based file (DOCX, XLSX, PPTX or archive)"],
    [/\x1F\x8B/, "gzip archive"],
    [/\x7FELF/, "ELF executable"],
  ];
  for (const [re, name] of signatures) {
    if (re.test(head)) return name;
  }
  // A NUL byte is decisive on its own — it does not occur in text.
  if (head.includes(String.fromCharCode(0))) return "binary data";
  return null;
}
