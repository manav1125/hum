/**
 * pdf_create — build a standalone PDF file from markdown or self-contained
 * HTML and deliver it as an in-chat attachment. For deliverables that should
 * be a FILE (invoices, one-pagers, flyers, formal letters) rather than an
 * editable document.
 */

import {
  renderHtmlToPdf,
  renderMarkdownToPDF,
} from "../../../../documents/pdf-render.js";
import { uploadAttachmentFromBytes } from "../../../../memory/attachments-store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

function sanitizeFilename(title: string): string {
  return (
    title
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "file"
  );
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const markdown =
    typeof input.markdown === "string" ? input.markdown : undefined;
  const html = typeof input.html === "string" ? input.html : undefined;

  if (!title) {
    return { content: "Provide a `title` for the PDF.", isError: true };
  }
  if ((markdown ? 1 : 0) + (html ? 1 : 0) !== 1) {
    return {
      content: "Provide exactly ONE of `markdown` or `html` as the content.",
      isError: true,
    };
  }
  const content = markdown ?? html ?? "";
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    return {
      content: "Content too large (max 2 MB). Split it into smaller PDFs.",
      isError: true,
    };
  }

  const format = input.format === "Letter" ? "Letter" : "A4";
  const landscape = input.landscape === true;
  const marginIn =
    typeof input.margin_inches === "number" &&
    input.margin_inches >= 0 &&
    input.margin_inches <= 2
      ? input.margin_inches
      : 0.75;

  try {
    const pdf = markdown
      ? await renderMarkdownToPDF(title, markdown)
      : await renderHtmlToPdf(html!, {
          format,
          landscape,
          marginIn,
          javascript: false,
        });
    const filename = `${sanitizeFilename(title)}.pdf`;
    const attachment = uploadAttachmentFromBytes(
      filename,
      "application/pdf",
      new Uint8Array(pdf),
    );
    return {
      content: JSON.stringify({
        message: "PDF created.",
        attachmentId: attachment.id,
        filename,
        sizeBytes: pdf.length,
        pageFormat: format,
      }),
      isError: false,
    };
  } catch (err) {
    return {
      content: `PDF creation failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}
