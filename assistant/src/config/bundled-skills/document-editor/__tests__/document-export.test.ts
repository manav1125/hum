/**
 * Drives the export tools the way the daemon does — a real document in the
 * store, a real attachment written to the workspace — because everything
 * between the renderer and the user is where an export quietly stops working:
 * an unregistered executor, a wrong MIME type, an attachment that never gets
 * linked onto the message.
 *
 * The Chromium-backed formats (`pdf`, `png`) are exercised in the renderers'
 * own suites; here the cheap formats stand in for the delivery path they all
 * share.
 */

import { describe, expect, test } from "bun:test";

import JSZip from "jszip";

import { saveDocument } from "../../../../documents/document-store.js";
import { getAttachmentById } from "../../../../memory/attachments-store.js";
import { initializeDb } from "../../../../memory/db-init.js";
import { rawRun } from "../../../../memory/raw-query.js";
import type { ToolContext } from "../../../../tools/types.js";
import { bundledToolRegistry } from "../../../bundled-tool-registry.js";
import { run as documentExport } from "../tools/document-export.js";
import { run as fileCreate } from "../tools/file-create.js";

initializeDb();

const CONTENT = `# Quarterly Proposal

Prepared for **Acme Trading LLC**.

| Item | Qty | Total |
| --- | ---: | ---: |
| Implementation | 1 | $12,000.00 |
`;

let counter = 0;

function seedDocument(content = CONTENT): {
  surfaceId: string;
  context: ToolContext;
} {
  const surfaceId = `doc-export-${++counter}`;
  const conversationId = `conv-export-${counter}`;
  const now = Date.now();
  // The document row carries an FK to its conversation.
  rawRun(
    `INSERT OR IGNORE INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)`,
    conversationId,
    now,
    now,
  );
  const saved = saveDocument({
    surfaceId,
    conversationId,
    title: "Quarterly Proposal",
    content,
    wordCount: content.split(/\s+/).length,
  });
  expect(saved.success).toBe(true);
  return { surfaceId, context: { conversationId } as ToolContext };
}

/** The tool answers in JSON; this is what the daemon and the model both read. */
function payload(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

/** Read the delivered file back out of the attachment store. */
function bytesOf(attachmentId: string): Buffer {
  const stored = getAttachmentById(attachmentId, { hydrateFileData: true });
  expect(stored).not.toBeNull();
  return Buffer.from(stored!.dataBase64, "base64");
}

describe("export tool registration", () => {
  test("both executors are in the bundled registry", () => {
    // A tool listed in TOOLS.json but missing here is invisible at runtime —
    // the failure looks like the model refusing a format that exists.
    expect(
      bundledToolRegistry.has("document-editor:tools/document-export.ts"),
    ).toBe(true);
    expect(
      bundledToolRegistry.has("document-editor:tools/file-create.ts"),
    ).toBe(true);
  });
});

describe("document_export", () => {
  test("delivers the document's own markdown verbatim", async () => {
    const { surfaceId, context } = seedDocument();
    const result = await documentExport(
      { surface_id: surfaceId, format: "markdown" },
      context,
    );

    expect(result.isError).toBe(false);
    const body = payload(result.content as string);
    expect(body.filename).toBe("Quarterly-Proposal.md");
    expect(body.format).toBe("markdown");

    const stored = getAttachmentById(body.attachmentId as string);
    expect(stored?.mimeType).toBe("text/markdown");
    // The attachment must also be announced on the typed side channel, or the
    // file never gets linked onto the assistant message.
    expect(result.attachmentIds).toEqual([body.attachmentId as string]);
  });

  test("produces a Word file whose text is really there", async () => {
    const { surfaceId, context } = seedDocument();
    const result = await documentExport(
      { surface_id: surfaceId, format: "docx" },
      context,
    );

    expect(result.isError).toBe(false);
    const body = payload(result.content as string);
    expect(body.filename).toBe("Quarterly-Proposal.docx");
    expect(body.editable).toBe(true);

    const stored = getAttachmentById(body.attachmentId as string);
    expect(stored?.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    const zip = await JSZip.loadAsync(bytesOf(body.attachmentId as string));
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("Acme Trading LLC");
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
  });

  test("reports the sheets it wrote when exporting tables", async () => {
    const { surfaceId, context } = seedDocument();
    const result = await documentExport(
      { surface_id: surfaceId, format: "xlsx" },
      context,
    );
    expect(result.isError).toBe(false);
    expect(payload(result.content as string).tableCount).toBe(1);
  });

  test("says why a table-less document can't become a spreadsheet", async () => {
    const { surfaceId, context } = seedDocument("# Just prose\n\nNo tables.");
    const result = await documentExport(
      { surface_id: surfaceId, format: "xlsx" },
      context,
    );
    // A refusal the model can act on beats an empty workbook the user opens.
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/No tables found/);
  });

  test("produces editable slides, and says they are structural", async () => {
    const { surfaceId, context } = seedDocument();
    const result = await documentExport(
      { surface_id: surfaceId, format: "pptx" },
      context,
    );

    expect(result.isError).toBe(false);
    const body = payload(result.content as string);
    expect(body.filename).toBe("Quarterly-Proposal.pptx");
    expect(body.slideCount).toBeGreaterThan(0);
    // The model has to be able to repeat the limitation to the user.
    expect(String(body.note)).toMatch(/not a copy of a designed layout/i);

    const stored = getAttachmentById(body.attachmentId as string);
    expect(stored?.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );

    const zip = await JSZip.loadAsync(bytesOf(body.attachmentId as string));
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
    expect(xml).toContain("Acme Trading LLC");
    // Real text runs, not a picture of the document.
    expect(xml).toContain("<a:t>");
    expect(xml).not.toContain("<a:blip");
  });

  test("rejects an unknown format by listing the real ones", async () => {
    const { surfaceId, context } = seedDocument();
    const result = await documentExport(
      { surface_id: surfaceId, format: "keynote" },
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("docx");
  });

  test("refuses a document the caller cannot reach", async () => {
    const result = await documentExport(
      { surface_id: "nope", format: "markdown" },
      { conversationId: "someone-else" } as ToolContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not found or not accessible/);
  });
});

describe("file_create", () => {
  const context = {} as ToolContext;

  test("builds a standalone file without an editable document first", async () => {
    const result = await fileCreate(
      { title: "Rate Card", format: "html", markdown: CONTENT },
      context,
    );
    expect(result.isError).toBe(false);
    const body = payload(result.content as string);
    expect(body.filename).toBe("Rate-Card.html");

    const html = bytesOf(body.attachmentId as string).toString("utf8");
    expect(html).toContain("<title>Rate Card</title>");
    expect(html).toContain("<table>");
  });

  test("refuses HTML input for the structure-derived formats", async () => {
    // Accepting it would mean shipping a Word file with a picture of a page
    // in it — which defeats the only reason to ask for Word.
    for (const format of ["docx", "xlsx", "markdown"]) {
      const result = await fileCreate(
        { title: "Rate Card", format, html: "<h1>hi</h1>" },
        context,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/needs `markdown`/);
    }
  });

  test("points PDF requests at the tool that owns them", async () => {
    const result = await fileCreate(
      { title: "Rate Card", format: "pdf", markdown: CONTENT },
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("pdf_create");
  });

  test("insists on exactly one content source", async () => {
    for (const input of [
      { title: "X", format: "html" },
      { title: "X", format: "html", markdown: "a", html: "<p>b</p>" },
    ]) {
      const result = await fileCreate(input, context);
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/exactly ONE/);
    }
  });
});
